# cowork-remote Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal Node.js/Express web app that runs Claude tasks from any browser, streams output live, and auto-starts on macOS login.

**Architecture:** Single-file Express server (`server.js`) with an in-memory process registry (EventEmitter per task) for SSE streaming, a serialized write queue for concurrent-safe `tasks.json` persistence, and a self-contained vanilla-JS dark UI in `public/index.html`.

**Tech Stack:** Node.js 25, Express 4, dotenv, `child_process.spawn`, EventEmitter, Server-Sent Events, launchd

---

## File Map

| File | Responsibility |
|------|---------------|
| `server.js` | All server logic: setup, auth, routes, process registry, SSE, task store |
| `public/index.html` | Dark mobile UI: textarea, submit, live output panel, history |
| `tasks.json` | Auto-created at runtime; last 10 task records |
| `.env` | Runtime secrets (gitignored) |
| `.env.example` | Documented template |
| `package.json` | Dependencies: express, dotenv |
| `.gitignore` | Excludes node_modules, .env, tasks.json |
| `README.md` | Setup, usage, launchd instructions |
| `~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist` | Auto-start on login |

---

## Chunk 1: Project Scaffolding

### Task 1: npm init + install dependencies

**Files:**
- Create/modify: `package.json`

- [ ] **Step 1: Run npm init**

```bash
cd ~/Projects/cowork-remote
npm init -y
```

Expected: `package.json` created with `"main": "index.js"`.

- [ ] **Step 2: Fix package.json main field and add start script**

Edit `package.json` — change `"main"` to `"server.js"` and add a `"start"` script:

```json
{
  "name": "cowork-remote",
  "version": "1.0.0",
  "description": "Remote Claude task runner",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
```

- [ ] **Step 3: Install express and dotenv**

```bash
npm install express dotenv
```

Expected: `node_modules/` created, `package.json` now has `"dependencies": { "express": "...", "dotenv": "..." }`.

- [ ] **Step 4: Verify installation**

```bash
node -e "require('express'); require('dotenv'); console.log('OK')"
```

Expected output: `OK`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: npm init and install express + dotenv"
```

---

### Task 2: Create .env.example and .env

**Files:**
- Create: `.env.example`
- Create: `.env` (local dev, gitignored)

- [ ] **Step 1: Create .env.example**

Create the file `/.env.example` with this exact content:

```
# Server port
PORT=4242

# Basic auth credentials (protect the UI and API)
COWORK_USER=admin
COWORK_PASS=changeme

# Working directory where Claude runs tasks
COWORK_DIR=/Users/marshalwalker/Projects

# Log directory — used by launchd plist (not read by server.js)
LOG_PATH=/Users/marshalwalker/logs
```

- [ ] **Step 2: Create .env from the example**

```bash
cp .env.example .env
```

Edit `.env` and set real values (can leave defaults for local dev).

- [ ] **Step 3: Verify .env is gitignored**

```bash
git check-ignore -v .env
```

Expected: `.gitignore:.env    .env`

If the output is empty, open `.gitignore` and verify it contains the line `.env`.

- [ ] **Step 4: Commit .env.example only**

```bash
git add .env.example
git commit -m "chore: add .env.example with all required vars documented"
```

---

## Chunk 2: Server Core (Setup + Auth + /status + Task Store + /tasks)

### Task 3: Create server.js — setup block and /status

**Files:**
- Create: `server.js`
- Create: `public/` directory

- [ ] **Step 1: Create public directory**

```bash
mkdir -p ~/Projects/cowork-remote/public
```

- [ ] **Step 2: Write server.js with setup block and /status only**

Create `server.js`:

```javascript
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
  writeQueue = writeQueue.then(() =>
    fs.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2))
  );
  return writeQueue;
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
  stale.forEach(t => { t.status = 'failed'; t.output = '[server restarted]'; });
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
  app.listen(PORT, () => {
    console.log(`cowork-remote listening on http://localhost:${PORT}`);
  });
});
```

- [ ] **Step 3: Start the server**

```bash
node server.js
```

Expected output: `cowork-remote listening on http://localhost:4242`

Leave it running and open a second terminal for the next steps.

- [ ] **Step 4: Test /status (no auth required)**

```bash
curl -s http://localhost:4242/status
```

Expected: `{"status":"ok","uptime":...}` (a JSON object)

- [ ] **Step 5: Test auth is required for /tasks**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4242/tasks
```

Expected: `401`

- [ ] **Step 6: Test /tasks with valid credentials**

```bash
curl -s -u admin:changeme http://localhost:4242/tasks
```

Expected: `[]` (empty array — no tasks yet)

- [ ] **Step 7: Stop the server (Ctrl+C) and commit**

```bash
git add server.js public/
git commit -m "feat: add server setup, auth middleware, /status, /tasks, task store"
```

---

## Chunk 3: Task Runner + SSE Streaming

### Task 4: Add POST /run route

**Files:**
- Modify: `server.js` (add POST /run before the start block)

- [ ] **Step 1: Add POST /run route to server.js**

Find the comment `// POST /run and GET /stream/:id added in Chunk 3` in `server.js` and replace it with:

```javascript
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

  const proc = spawn('claude', ['--dangerously-skip-permissions', '-p', prompt], {
    cwd: COWORK_DIR,
  });

  const emitter = new EventEmitter();
  const entry = { proc, outputBuffer: '', emitter };
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
    await updateTask(id, { status: 'failed', output: entry.outputBuffer });
    emitter.emit('done', 'failed');
  });

  proc.on('close', async (code) => {
    const status = code === 0 ? 'done' : 'failed';
    registry.delete(id);
    await updateTask(id, { status, output: entry.outputBuffer });
    emitter.emit('done', status);
  });

  res.json({ id });
});

// GET /stream/:id added in Task 5
```

- [ ] **Step 2: Start the server**

```bash
node server.js
```

- [ ] **Step 3: Test POST /run returns an id**

```bash
curl -s -u admin:changeme \
  -X POST http://localhost:4242/run \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"echo hello from test"}'
```

Expected: `{"id":"<some-uuid>"}` — a JSON object with an id field.

- [ ] **Step 4: Verify tasks.json was created**

```bash
cat ~/Projects/cowork-remote/tasks.json
```

Expected: a JSON array with one entry, status either `"running"`, `"done"`, or `"failed"`.

- [ ] **Step 5: Test missing prompt returns 400**

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -u admin:changeme \
  -X POST http://localhost:4242/run \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Expected: `400`

- [ ] **Step 6: Stop server and commit**

```bash
git add server.js
git commit -m "feat: add POST /run — spawns claude task with process registry"
```

---

### Task 5: Add GET /stream/:id SSE endpoint

**Files:**
- Modify: `server.js` (add GET /stream/:id)

- [ ] **Step 1: Add GET /stream/:id to server.js**

Find the comment `// GET /stream/:id added in Task 5` and replace it with:

```javascript
// Stream task output via Server-Sent Events
app.get('/stream/:id', async (req, res) => {
  const { id } = req.params;

  const entry = registry.get(id);

  if (!entry) {
    // Not running — look up in tasks.json before flushing SSE headers
    const tasks = await loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) {
      return res.status(404).json({ error: 'not found' });
    }
    // Replay saved output as SSE
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(task.output)}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ status: task.status })}\n\n`);
    return res.end();
  }

  // Task is still running — open SSE stream
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();

  // Send buffered output so far
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
```

- [ ] **Step 2: Start the server**

```bash
node server.js
```

- [ ] **Step 3: Submit a task and capture its id**

```bash
ID=$(curl -s -u admin:changeme \
  -X POST http://localhost:4242/run \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"say the word PINEAPPLE and nothing else"}' \
  | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
echo "Task ID: $ID"
```

- [ ] **Step 4: Stream the output**

```bash
curl -s -u admin:changeme "http://localhost:4242/stream/$ID"
```

Expected: one or more `data: "..."` lines containing Claude's output, followed by `event: done` with `{"status":"done"}` or `{"status":"failed"}`.

- [ ] **Step 5: Test replay — stream the same id again after it finishes**

Wait a few seconds, then:

```bash
curl -s -u admin:changeme "http://localhost:4242/stream/$ID"
```

Expected: same output replayed immediately (single `data:` event + `event: done`), stream closes right away.

- [ ] **Step 6: Test 404 for unknown id**

```bash
curl -s -o /dev/null -w "%{http_code}" -u admin:changeme "http://localhost:4242/stream/nonexistent-id"
```

Expected: `404`

```bash
curl -s -u admin:changeme "http://localhost:4242/stream/nonexistent-id"
```

Expected: `{"error":"not found"}` (plain JSON body, not SSE)

- [ ] **Step 7: Stop server and commit**

```bash
git add server.js
git commit -m "feat: add GET /stream/:id SSE endpoint with live streaming and replay"
```

---

## Chunk 4: UI

### Task 6: Create public/index.html

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: Create public/index.html**

Create the file `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>cowork-remote</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0f0f0f;
      color: #e0e0e0;
      font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
      font-size: 14px;
      padding: 1rem;
      max-width: 800px;
      margin: 0 auto;
    }

    h1 {
      color: #fff;
      font-size: 1.2rem;
      margin-bottom: 1rem;
      letter-spacing: 0.05em;
    }

    textarea {
      width: 100%;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 6px;
      color: #e0e0e0;
      font-family: inherit;
      font-size: 14px;
      padding: 0.75rem;
      resize: vertical;
      outline: none;
    }
    textarea:focus { border-color: #555; }

    #run-btn {
      margin-top: 0.5rem;
      width: 100%;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 0.75rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    #run-btn:disabled { background: #1e3a6e; cursor: not-allowed; }
    #run-btn:hover:not(:disabled) { background: #1d4ed8; }

    #output-panel {
      margin-top: 1rem;
      background: #111;
      border: 1px solid #222;
      border-radius: 6px;
      padding: 0.75rem;
      min-height: 120px;
      max-height: 50vh;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 13px;
      color: #a8e6cf;
      display: none;
    }

    h2 {
      color: #888;
      font-size: 0.8rem;
      margin: 1.5rem 0 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    #history-list { list-style: none; }

    .task-item {
      border: 1px solid #222;
      border-radius: 6px;
      margin-bottom: 0.5rem;
    }

    .task-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem 0.75rem;
      cursor: pointer;
      user-select: none;
    }
    .task-header:hover { background: #1a1a1a; border-radius: 6px; }

    .badge {
      font-size: 0.7rem;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      flex-shrink: 0;
      text-transform: uppercase;
    }
    .badge-running { background: #7c3aed; color: #fff; }
    .badge-done    { background: #065f46; color: #6ee7b7; }
    .badge-failed  { background: #7f1d1d; color: #fca5a5; }

    .task-prompt {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #ccc;
      font-size: 13px;
    }

    .task-time { font-size: 11px; color: #555; flex-shrink: 0; }

    .task-output {
      display: none;
      padding: 0.5rem 0.75rem 0.75rem;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      color: #a8e6cf;
      border-top: 1px solid #222;
      max-height: 40vh;
      overflow-y: auto;
    }
    .task-output.open { display: block; }
  </style>
</head>
<body>
  <h1>cowork-remote</h1>

  <textarea id="prompt" rows="6" placeholder="Describe the task for Claude..."></textarea>
  <button id="run-btn">Run</button>
  <pre id="output-panel"></pre>

  <h2>Recent Tasks</h2>
  <ul id="history-list"></ul>

  <script>
    const promptEl = document.getElementById('prompt');
    const runBtn   = document.getElementById('run-btn');
    const outputPanel = document.getElementById('output-panel');
    const historyList = document.getElementById('history-list');

    function timeSince(iso) {
      const s = Math.floor((Date.now() - new Date(iso)) / 1000);
      if (s < 60)   return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      return Math.floor(s / 3600) + 'h ago';
    }

    function renderTask(task) {
      const li = document.createElement('li');
      li.className = 'task-item';
      li.dataset.id = task.id;

      const header = document.createElement('div');
      header.className = 'task-header';

      // Use textContent for user-supplied fields to prevent XSS
      const badge = document.createElement('span');
      badge.className = `badge badge-${task.status}`;
      badge.textContent = task.status;

      const prompt = document.createElement('span');
      prompt.className = 'task-prompt';
      prompt.textContent = task.prompt.slice(0, 80);

      const time = document.createElement('span');
      time.className = 'task-time';
      time.textContent = timeSince(task.timestamp);

      header.appendChild(badge);
      header.appendChild(prompt);
      header.appendChild(time);

      const output = document.createElement('pre');
      output.className = 'task-output';
      output.textContent = task.output || '';

      header.addEventListener('click', () => output.classList.toggle('open'));

      li.appendChild(header);
      li.appendChild(output);
      return li;
    }

    async function loadHistory() {
      try {
        const res = await fetch('/tasks');
        const tasks = await res.json();
        historyList.innerHTML = '';
        tasks.forEach(t => historyList.appendChild(renderTask(t)));
      } catch (e) {
        console.error('Failed to load history:', e);
      }
    }

    runBtn.addEventListener('click', async () => {
      const prompt = promptEl.value.trim();
      if (!prompt) return;

      runBtn.disabled = true;
      outputPanel.textContent = '';
      outputPanel.style.display = 'block';
      outputPanel.scrollTop = 0;

      let runRes;
      try {
        runRes = await fetch('/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
      } catch (e) {
        outputPanel.textContent = '[network error: ' + e.message + ']';
        runBtn.disabled = false;
        return;
      }

      const { id, error } = await runRes.json();
      if (error) {
        outputPanel.textContent = '[error: ' + error + ']';
        runBtn.disabled = false;
        return;
      }

      const es = new EventSource('/stream/' + id);

      es.onmessage = (e) => {
        outputPanel.textContent += JSON.parse(e.data);
        outputPanel.scrollTop = outputPanel.scrollHeight;
      };

      es.addEventListener('done', () => {
        es.close();
        runBtn.disabled = false;
        loadHistory();
      });

      es.addEventListener('error', () => {
        es.close();
        runBtn.disabled = false;
        loadHistory();
      });
    });

    loadHistory();
  </script>
</body>
</html>
```

- [ ] **Step 2: Start the server**

```bash
node server.js
```

- [ ] **Step 3: Open browser and verify UI loads**

Open `http://localhost:4242` in a browser.

Expected:
- Browser prompts for username/password — enter `admin` / `changeme`
- Dark page loads with title "cowork-remote", textarea, and "Run" button
- History panel shows any tasks from previous testing

- [ ] **Step 4: Submit a task and verify live streaming**

Type a short prompt like `say the word PINEAPPLE only` and click Run.

Expected:
- Output panel appears and fills with streaming text
- "Run" button becomes disabled during the task
- Button re-enables when done
- Task appears in Recent Tasks history with correct status badge

- [ ] **Step 5: Verify history collapse/expand**

Click on any history item.

Expected: output expands below the header. Click again — it collapses.

- [ ] **Step 6: Stop server and commit**

```bash
git add public/index.html
git commit -m "feat: add dark mobile UI with SSE streaming and task history"
```

---

## Chunk 5: Config, Deployment, GitHub

### Task 7: Create launchd plist

**Files:**
- Create: `~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist`

Note: This file lives **outside** the repo. It contains real credentials — do not commit it.

- [ ] **Step 1: Create logs directory**

```bash
mkdir -p ~/logs
```

- [ ] **Step 2: Create the plist file**

Create `~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nexogrx.cowork-remote</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/marshalwalker/Projects/cowork-remote/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/marshalwalker/Projects/cowork-remote</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/marshalwalker/logs/cowork-remote.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/marshalwalker/logs/cowork-remote.err</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>4242</string>
    <key>COWORK_USER</key>
    <string>admin</string>
    <key>COWORK_PASS</key>
    <string>changeme</string>
    <key>COWORK_DIR</key>
    <string>/Users/marshalwalker/Projects</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

**Important:** Replace `admin`/`changeme` with your real credentials before loading.

- [ ] **Step 3: Validate plist syntax**

```bash
plutil -lint ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
```

Expected: `~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist: OK`

- [ ] **Step 4: Load and start the service**

```bash
launchctl load ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
```

- [ ] **Step 5: Verify it started**

```bash
curl -s http://localhost:4242/status
```

Expected: `{"status":"ok","uptime":...}`

- [ ] **Step 6: Check logs are being written**

```bash
tail ~/logs/cowork-remote.log
```

Expected: `cowork-remote listening on http://localhost:4242`

---

### Task 8: Create README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

Create `README.md`:

```markdown
# cowork-remote

Run Claude tasks from any device — phone, tablet, laptop. Streams output live in the browser.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Claude Code CLI](https://claude.ai/code) installed and authenticated (`claude` in your PATH)

## Install

```bash
git clone https://github.com/winemarshal68/cowork-remote.git
cd cowork-remote
npm install
cp .env.example .env
```

Edit `.env` and set your values:

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 4242) |
| `COWORK_USER` | Basic auth username |
| `COWORK_PASS` | Basic auth password |
| `COWORK_DIR` | Directory Claude runs tasks in |
| `LOG_PATH` | Directory for launchd log files |

## Run manually

```bash
node server.js
# → cowork-remote listening on http://localhost:4242
```

Open `http://localhost:4242` in a browser, enter your credentials, and start submitting tasks.

## Auto-start on login (macOS)

1. Copy the plist template and edit it with your real paths and credentials:

```bash
cp ~/Projects/cowork-remote/docs/com.nexogrx.cowork-remote.plist.example \
   ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
```

2. Edit the plist — replace `admin`/`changeme` with your real `COWORK_USER`/`COWORK_PASS`.

3. Create the logs directory:

```bash
mkdir -p ~/logs
```

4. Load the service:

```bash
launchctl load ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
```

The server now starts automatically on every login.

### Manage the service

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
launchctl load   ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist

# View logs
tail -f ~/logs/cowork-remote.log
tail -f ~/logs/cowork-remote.err
```

## Health check

```bash
curl http://localhost:4242/status
# → {"status":"ok","uptime":42.3}
```

## Task history

The last 10 task runs are saved to `tasks.json` (gitignored). Each entry includes the prompt, status (`done`/`failed`), and full output. The Recent Tasks panel in the UI shows them — click any item to expand its output.
```

- [ ] **Step 2: Create plist example in docs for README reference**

```bash
cp ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist \
   ~/Projects/cowork-remote/docs/com.nexogrx.cowork-remote.plist.example
```

Then open `docs/com.nexogrx.cowork-remote.plist.example` and replace the real credentials with placeholders:
- `<string>admin</string>` under `COWORK_USER` → `<string>YOUR_USERNAME</string>`
- `<string>changeme</string>` under `COWORK_PASS` → `<string>YOUR_PASSWORD</string>`

- [ ] **Step 3: Commit**

```bash
git add README.md docs/com.nexogrx.cowork-remote.plist.example
git commit -m "docs: add README and launchd plist example"
```

---

### Task 9: Create GitHub repo and push

- [ ] **Step 1: Create GitHub repo**

```bash
cd ~/Projects/cowork-remote
gh repo create winemarshal68/cowork-remote \
  --public \
  --description "Remote Claude task runner — stream tasks from any browser" \
  --source . \
  --remote origin
```

Expected: repo created, remote `origin` added.

- [ ] **Step 2: Push all commits**

```bash
git push -u origin main
```

Expected: all commits pushed, URL printed.

- [ ] **Step 3: Verify on GitHub**

```bash
gh repo view winemarshal68/cowork-remote --web
```

Expected: browser opens to the repo page showing README, server.js, and all files.

---

## Done

The app is fully built and deployed:

- `http://localhost:4242` — the UI (requires browser auth)
- `http://localhost:4242/status` — public health check
- `~/logs/cowork-remote.log` — server logs
- `~/Projects/cowork-remote/tasks.json` — last 10 task records (auto-created, gitignored)
- `~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist` — auto-start on login
