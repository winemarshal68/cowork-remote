'use strict';
require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 4242;
const COWORK_DIR = process.env.COWORK_DIR || process.cwd();
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const MAX_TASKS = 50;

// In-memory process registry: id -> { proc, outputBuffer, emitter, startTime }
const registry = new Map();

// SSE clients watching the task list: Set of response objects
const watchers = new Set();

// Serialized write queue — prevents concurrent tasks.json corruption
let writeQueue = Promise.resolve();

// --- TASK STORE ---

async function loadTasks() {
  try {
    const data = await fs.readFile(TASKS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  const next = writeQueue.then(() =>
    fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2))
  );
  writeQueue = next.catch(() => {});
  return next;
}

async function addTask(task) {
  const tasks = await loadTasks();
  tasks.unshift(task);
  const trimmed = tasks.slice(0, MAX_TASKS);
  await saveTasks(trimmed);
  broadcastTaskUpdate();
  return trimmed;
}

async function updateTask(id, updates) {
  const tasks = await loadTasks();
  const t = tasks.find(t => t.id === id);
  if (t) Object.assign(t, updates);
  await saveTasks(tasks);
  broadcastTaskUpdate();
  return tasks;
}

async function deleteTask(id) {
  const tasks = await loadTasks();
  const filtered = tasks.filter(t => t.id !== id);
  await saveTasks(filtered);
  broadcastTaskUpdate();
  return filtered;
}

// Broadcast task list changes to all watching clients
function broadcastTaskUpdate() {
  for (const res of watchers) {
    try {
      res.write(`event: update\ndata: "refresh"\n\n`);
    } catch {
      watchers.delete(res);
    }
  }
}

// On startup: mark any stale "running" entries as failed
async function recoverStaleTasks() {
  const tasks = await loadTasks();
  const stale = tasks.filter(t => t.status === 'running');
  if (!stale.length) return;
  stale.forEach(t => {
    t.status = 'failed';
    t.output = (t.output ? t.output + '\n' : '') + '[server restarted]';
    t.endTime = new Date().toISOString();
  });
  return saveTasks(tasks);
}

// --- EXPRESS SETUP ---

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- AUTH MIDDLEWARE ---

const AUTH_USER = process.env.COWORK_USER;
const AUTH_PASS = process.env.COWORK_PASS;

function basicAuth(req, res, next) {
  if (!AUTH_USER || !AUTH_PASS) return next();
  const auth = req.headers.authorization || '';
  const [type, encoded = ''] = auth.split(' ');
  if (type !== 'Basic') {
    res.set('WWW-Authenticate', 'Basic realm="cowork-remote"');
    return res.status(401).send('Unauthorized');
  }
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
  if (user !== AUTH_USER || pass !== AUTH_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="cowork-remote"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

// --- ROUTES ---

// Public health check (no auth)
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeTasks: registry.size,
    version: '2.0.0',
  });
});

// Auth guard for all routes below
app.use(basicAuth);

// Task list with optional search
app.get('/tasks', async (req, res) => {
  let tasks = await loadTasks();
  const { q, status, limit } = req.query;

  if (q) {
    const query = q.toLowerCase();
    tasks = tasks.filter(t =>
      t.prompt.toLowerCase().includes(query) ||
      (t.output && t.output.toLowerCase().includes(query))
    );
  }

  if (status && status !== 'all') {
    tasks = tasks.filter(t => t.status === status);
  }

  if (limit) {
    tasks = tasks.slice(0, parseInt(limit, 10));
  }

  // Annotate running tasks with live info
  tasks = tasks.map(t => {
    if (registry.has(t.id)) {
      const entry = registry.get(t.id);
      return {
        ...t,
        _live: true,
        _outputLength: entry.outputBuffer.length,
        _elapsed: Date.now() - new Date(t.timestamp).getTime(),
      };
    }
    return t;
  });

  res.json(tasks);
});

// Get single task detail
app.get('/tasks/:id', async (req, res) => {
  const tasks = await loadTasks();
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(task);
});

// Delete a task from history
app.delete('/tasks/:id', async (req, res) => {
  const { id } = req.params;
  // Kill if running
  const entry = registry.get(id);
  if (entry) {
    entry.proc.kill('SIGTERM');
    registry.delete(id);
  }
  await deleteTask(id);
  res.json({ ok: true });
});

// Cancel a running task
app.post('/tasks/:id/cancel', async (req, res) => {
  const { id } = req.params;
  const entry = registry.get(id);
  if (!entry) {
    return res.status(404).json({ error: 'task not running' });
  }
  entry.proc.kill('SIGTERM');
  // Give it a moment, then force kill
  setTimeout(() => {
    try { entry.proc.kill('SIGKILL'); } catch {}
  }, 3000);
  res.json({ ok: true });
});

// Re-run a task (create new task with same prompt)
app.post('/tasks/:id/rerun', async (req, res) => {
  const tasks = await loadTasks();
  const original = tasks.find(t => t.id === req.params.id);
  if (!original) return res.status(404).json({ error: 'not found' });

  // Delegate to the /run handler logic
  const prompt = original.prompt;
  const id = randomUUID();
  const task = {
    id,
    timestamp: new Date().toISOString(),
    prompt,
    status: 'running',
    output: '',
    rerunOf: original.id,
  };
  await addTask(task);
  spawnTask(id, prompt);
  res.json({ id });
});

// Submit a new task
app.post('/run', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const id = randomUUID();
  const task = {
    id,
    timestamp: new Date().toISOString(),
    prompt,
    status: 'running',
    output: '',
  };
  await addTask(task);
  spawnTask(id, prompt);
  res.json({ id });
});

function spawnTask(id, prompt) {
  const proc = spawn('claude', ['--dangerously-skip-permissions', '-p', prompt], {
    cwd: COWORK_DIR,
  });

  const emitter = new EventEmitter();
  const entry = { proc, outputBuffer: '', emitter, startTime: Date.now() };
  registry.set(id, entry);

  const onChunk = (chunk) => {
    const str = chunk.toString();
    entry.outputBuffer += str;
    emitter.emit('data', str);
  };

  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  proc.on('error', async (err) => {
    const msg = `[spawn error: ${err.message}]`;
    entry.outputBuffer += msg;
    emitter.emit('data', msg);
    registry.delete(id);
    const duration = Date.now() - entry.startTime;
    await updateTask(id, {
      status: 'failed',
      output: entry.outputBuffer,
      endTime: new Date().toISOString(),
      duration,
    });
    emitter.emit('done', 'failed');
  });

  proc.on('close', async (code) => {
    const status = code === 0 ? 'done' : 'failed';
    registry.delete(id);
    const duration = Date.now() - entry.startTime;
    await updateTask(id, {
      status,
      output: entry.outputBuffer,
      endTime: new Date().toISOString(),
      duration,
    });
    emitter.emit('done', status);
  });
}

// Stream task output via Server-Sent Events
app.get('/stream/:id', async (req, res) => {
  const { id } = req.params;
  const entry = registry.get(id);

  if (!entry) {
    const tasks = await loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(task.output)}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ status: task.status })}\n\n`);
    return res.end();
  }

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();

  if (entry.outputBuffer) {
    res.write(`data: ${JSON.stringify(entry.outputBuffer)}\n\n`);
  }

  const onData = (str) => res.write(`data: ${JSON.stringify(str)}\n\n`);
  const onDone = (status) => {
    res.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
    cleanup();
    res.end();
  };
  const cleanup = () => {
    entry.emitter.off('data', onData);
    entry.emitter.off('done', onDone);
  };

  entry.emitter.on('data', onData);
  entry.emitter.once('done', onDone);
  req.on('close', cleanup);
});

// Watch for task list changes (SSE)
app.get('/watch', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: "connected"\n\n`);
  watchers.add(res);
  req.on('close', () => watchers.delete(res));
});

// --- START ---
recoverStaleTasks().then(() => {
  if (!AUTH_USER || !AUTH_PASS) {
    console.warn('WARNING: auth disabled — set COWORK_USER and COWORK_PASS in .env');
  }
  app.listen(PORT, () => {
    console.log(`cowork-remote v2.0 listening on http://localhost:${PORT}`);
  });
});
