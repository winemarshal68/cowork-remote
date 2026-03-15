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

1. **Setup** — dotenv, Express app, `public/` static serving, JSON body parsing
2. **Auth middleware** — HTTP Basic Auth checking `COWORK_USER`/`COWORK_PASS` env vars; applied to all routes except `GET /status`
3. **`GET /status`** — Public health check; returns `{ status: "ok", uptime }` JSON
4. **`POST /run`** — Accepts `{ prompt }`; creates task record `{ id, timestamp, prompt, status: "running" }`; saves to `tasks.json`; spawns `claude --dangerously-skip-permissions` with prompt via stdin; working dir set to `COWORK_DIR` env var
5. **`GET /stream/:id`** — SSE endpoint; streams stdout/stderr from the running process in real time; on exit marks task `done`/`failed`, saves full output to `tasks.json`, closes stream
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
- History: collapsible list; clicking a past task expands it to show full saved output
- Status badges: color-coded `running` / `done` / `failed` next to each history item
- Auth: browser-native HTTP Basic Auth dialog (no custom login page)

---

## Configuration

### `.env.example`

```
PORT=4242
COWORK_USER=admin
COWORK_PASS=changeme
COWORK_DIR=/Users/you/Projects
LOG_PATH=/Users/you/logs
```

### launchd plist (`~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist`)

- `WorkingDirectory` → `~/Projects/cowork-remote`
- `ProgramArguments` → `[node, /absolute/path/to/server.js]`
- `RunAtLoad = true` — starts on login
- `StandardOutPath` → `$LOG_PATH/cowork-remote.log`
- `StandardErrorPath` → `$LOG_PATH/cowork-remote.err`
- `EnvironmentVariables` block with all `.env` vars

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
