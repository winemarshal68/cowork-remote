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

Open `http://localhost:4242` in a browser, enter your credentials when prompted, and start submitting tasks.

## Auto-start on login (macOS)

1. Copy the plist template:

```bash
cp docs/com.nexogrx.cowork-remote.plist.example \
   ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
```

2. Edit the plist — replace all `YOUR_USERNAME` and `YOUR_PASSWORD` placeholders with your real values.

3. Create the logs directory:

```bash
mkdir -p ~/logs
```

4. Validate and load the service:

```bash
plutil -lint ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
launchctl load ~/Library/LaunchAgents/com.nexogrx.cowork-remote.plist
```

The server now starts automatically on every login.

## Manage the service

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
