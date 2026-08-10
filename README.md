# Jarvis

Jarvis is a local, single-user coding workspace for persistent Pi sessions. It keeps Pi JSONL as the session-history source of truth and provides a React workbench for project/session navigation, model selection, streaming responses, tool activity, stop, and reconnect recovery.

## Requirements

- Node.js 24 or newer
- A configured Pi profile, normally `~/.pi/agent`

## Development

```bash
npm install
npm run dev
```

Open `http://<machine-ip>:28471` from any reachable device. In development, Vite listens on port `28471` and Fastify listens on port `39126`, both on all network interfaces.

Development has no authentication and can operate Pi sessions, so do not expose it to an untrusted network. Production builds keep Fastify on `127.0.0.1` and can be run with:

```bash
npm run build
NODE_ENV=production npm start
```

Jarvis stores only its Workspace registry in `~/.jarvis/workspaces.json`. Pi JSONL remains the authoritative conversation history. Do not write to the same Pi session concurrently from Jarvis and the Pi CLI.

## MVP Scope

- Expandable project tree with existing and new Pi sessions
- Project registration, session rename, filtering, and permanent session deletion
- Authenticated Pi model selection and per-session thinking levels, persisted as Pi history
- Text-only streaming prompts
- Tool execution status and output
- Stop, refresh, WebSocket reconnect, and paged history

Attachments, archive, terminal/files/Git panels, and extension dialogs are intentionally outside the MVP.
