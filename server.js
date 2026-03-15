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
const MAX_TASKS = 10;

// In-memory process registry: id -> { proc, outputBuffer, emitter }
const registry = new Map();

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
  writeQueue = next.catch(() => {}); // keep queue alive on disk errors
  return next;
}

async function addTask(task) {
  const tasks = await loadTasks();
  tasks.unshift(task);
  return saveTasks(tasks.slice(0, MAX_TASKS));
}

async function updateTask(id, updates) {
  const tasks = await loadTasks();
  const t = tasks.find(t => t.id === id);
  if (t) Object.assign(t, updates);
  return saveTasks(tasks);
}

// On startup: mark any stale "running" entries as failed
async function recoverStaleTasks() {
  const tasks = await loadTasks();
  const stale = tasks.filter(t => t.status === 'running');
  if (!stale.length) return;
  stale.forEach(t => {
    t.status = 'failed';
    t.output = (t.output ? t.output + '\n' : '') + '[server restarted]';
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
  if (!AUTH_USER || !AUTH_PASS) {
    // Auth disabled — COWORK_USER/COWORK_PASS not set in env
    return next();
  }
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
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Auth guard for all routes below this line
app.use(basicAuth);

// Task history
app.get('/tasks', async (req, res) => {
  res.json(await loadTasks());
});

// POST /run and GET /stream/:id added in Chunk 3

// --- START ---
recoverStaleTasks().then(() => {
  if (!AUTH_USER || !AUTH_PASS) {
    console.warn('WARNING: auth disabled — set COWORK_USER and COWORK_PASS in .env');
  }
  app.listen(PORT, () => {
    console.log(`cowork-remote listening on http://localhost:${PORT}`);
  });
});
