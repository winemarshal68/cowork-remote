# cowork-remote Design Spec
**Date:** 2026-03-15
**Status:** Approved

## Overview

A personal Node.js/Express web app that lets you submit tasks to `claude --dangerously-skip-permissions` from any device (phone, tablet, desktop) via a mobile-friendly browser UI. Streams Claude's output live via SSE, persists the last 10 task runs, and auto-starts on macOS login via launchd.

---

## Architecture

**Option chosen:** Single-file server (Option A) — all logic in `server.js` (~200 lines). No build step. No frontend framework.

---

## Project Structure

```
cowork-remote/
├── server.js          # Express server: auth, SSE, task runner, task history
├── public/
│   └── index.html     # Dark mobile-friendly UI (vanilla JS, no deps)
├── tasks.json         # Auto-created; stores last 10 runs
├── .env               # Real secrets (gitignored)
├── .env.example       # Template with all vars documented
├── package.json
├── .gitignore         # node_modules, .env, tasks.json
└── README.md
```

Outside the repo:
```
~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
```

---

## Server (`server.js`)

Five logical blocks, top to bottom:

1. **Setup** — dotenv, Express app, `public/` static serving, JSON body parsing, in-memory `Map<id, { process, outputBuffer }>` process registry
2. **Auth middleware** — HTTP Basic Auth checking `COWORK_USER`/`COWORK_PASS` env vars; applied to all routes except `GET /status`
3. **`GET /status`** — Public health check; returns `{ status: "ok", uptime }` JSON
4. **`POST /run`** — Accepts `{ prompt }`; creates task record `{ id, timestamp, prompt, status: "running" }`; saves to `tasks.json`; spawns `claude --dangerously-skip-permissions -p "<prompt>"` (prompt passed as the `-p` CLI argument, not stdin); working dir set to `COWORK_DIR` env var; stores `{ process, outputBuffer: "" }` in registry keyed by `id`; responds immediately with `{ id }`. Multiple concurrent tasks are supported — each gets its own registry entry.
5. **`GET /stream/:id`** — SSE endpoint. If the task is still running (found in registry), stream stdout/stderr chunks in real time as `data:` SSE events; on process exit, mark task `done`/`failed`, write buffered output to `tasks.json`, remove from registry, send a final `event: done` SSE event, close stream. If the task is already finished (not in registry), look it up in `tasks.json` and replay the saved output as a single `data:` event followed immediately by `event: done` — this handles the race where the client opens the stream after the process exits. If the id is not found in either place, return HTTP 404.
6. **`GET /tasks`** — Returns last 10 tasks from `tasks.json` for history panel on page load

### `tasks.json` schema

Array of up to 10 objects, newest first. When an 11th entry is added, the oldest is dropped.

```json
[
  {
    "id": "uuid-v4",
    "timestamp": "ISO-8601",
    "prompt": "task prompt text",
    "status": "running | done | failed",
    "output": "full stdout+stderr as string"
  }
]
```

Output is **buffered in memory** during a run and written to `tasks.json` once on process exit. If the server crashes mid-run, that run's output is lost, but the file itself remains valid (the entry will persist with `status: "running"` and empty output). On startup, any `running` entries left in `tasks.json` are re-marked as `failed` with output `"[server restarted]"`.

All writes to `tasks.json` must go through a **write queue** — a promise chain (`let writeQueue = Promise.resolve()`) where each write appends to the chain with `writeQueue = writeQueue.then(() => fs.writeFile(...))`. This serializes concurrent writes from multiple finishing tasks and prevents file corruption.

---

## UI (`public/index.html`)

Single self-contained file. No build step. No external dependencies.

### Layout (mobile-first, dark theme)

- Background: `#0f0f0f`, light text, accent color for the submit button
- Full-width column layout:
  1. Title
  2. Textarea (~6 rows) for task prompt
  3. "Run" submit button
  4. Live output panel — streams text as SSE chunks arrive
  5. History panel — last 10 runs loaded from `GET /tasks` on page load

### Behavior

- On submit: `POST /run` → get task `id` → open `EventSource` on `GET /stream/:id` → append chunks to output panel
- History: collapsible list; items **start collapsed**; clicking a past task expands it to show full saved output
- Status badges: color-coded `running` / `done` / `failed` next to each history item
- Auth: browser-native HTTP Basic Auth dialog (no custom login page)

---

## Configuration

### `.env.example`

```
# Server
PORT=4242

# Basic auth credentials
COWORK_USER=admin
COWORK_PASS=changeme

# Working directory for spawned claude processes
COWORK_DIR=/Users/you/Projects

# Log file directory (used by launchd plist, not the server itself)
LOG_PATH=/Users/you/logs
```

`LOG_PATH` is read only by the launchd plist (for `StandardOutPath`/`StandardErrorPath`). The server does not use it directly — all server output goes to stdout/stderr, which launchd redirects to the log files.

### launchd plist (`~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist`)

- `WorkingDirectory` → `/Users/<username>/Projects/cowork-remote` (absolute path)
- `ProgramArguments` → `["/usr/local/bin/node", "/Users/<username>/Projects/cowork-remote/server.js"]` (absolute paths)
- `RunAtLoad = true` — starts on login
- `StandardOutPath` → `/Users/<username>/logs/cowork-remote.log`
- `StandardErrorPath` → `/Users/<username>/logs/cowork-remote.err`
- `EnvironmentVariables` block containing `PORT`, `COWORK_USER`, `COWORK_PASS`, `COWORK_DIR`

---

## README.md

Covers:
- Prerequisites (Node.js, Claude Code CLI installed)
- Install: `npm install`, copy `.env.example` → `.env`, fill in values
- Run manually: `node server.js`
- Load launchd: `launchctl load ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist`
- Unload launchd: `launchctl unload ...`
- View logs: `tail -f ~/logs/cowork-remote.log`
- Usage: open `http://localhost:4242` in any browser

---

## Error Handling

- If `claude` process fails to spawn → task marked `failed`, error written to output field
- If SSE client disconnects mid-stream → process continues, output still saved to `tasks.json`
- If `tasks.json` is missing or corrupt → server recreates it as an empty array on startup

---

## Security Notes

- Basic Auth protects all routes except `/status`
- `.env` is gitignored — never committed
- `COWORK_DIR` constrains the working directory for spawned processes
- `claude --dangerously-skip-permissions` is intentional — this is a personal tool on a trusted local network
