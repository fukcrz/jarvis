# Jarvis

Jarvis is a local, single-user coding workspace for persistent Pi sessions. It keeps Pi JSONL as the session-history source of truth and provides a React workbench for Workspace navigation, session continuation, streaming responses, tool activity, stop, and reconnect recovery.

## Requirements

- Node.js 24 or newer
- A configured Pi profile, normally `~/.pi/agent`

## Development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

The Fastify API listens on `http://127.0.0.1:4310`. Production builds can be run with:

```bash
npm run build
NODE_ENV=production npm start
```

Jarvis stores only its Workspace registry in `~/.jarvis/workspaces.json`. Pi JSONL remains the authoritative conversation history. Do not write to the same Pi session concurrently from Jarvis and the Pi CLI.

## MVP Scope

- Workspace registration and selection
- Existing and new Pi sessions
- Session rename and filtering
- Text-only streaming prompts
- Tool execution status and output
- Stop, refresh, WebSocket reconnect, and paged history

Model settings, attachments, archive/delete, terminal/files/Git panels, and extension dialogs are intentionally outside the MVP.
