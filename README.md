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

Jarvis has no authentication and can operate Pi sessions, so do not expose it to an untrusted network. Production builds also bind Fastify to `0.0.0.0` (override the bind address with `HOST`, the port with `PORT`) and can be run with:

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

## Message Queue

While a session is running, Jarvis queues new prompts instead of rejecting them.
Queued messages are shown **one per line above the input box** with ellipsis
preview, each with three actions on the right: **restore to editor**, **toggle
urgent (interrupt)**, and **delete**:

- **Send while busy** queues a *follow-up* message by default, delivered only
  after the agent finishes all work
- **Toggle urgent** switches a message to *steering*: delivered after the
  current assistant turn finishes executing its tool calls (before the next
  LLM call); toggle again to go back to follow-up
- **Restore to editor** pulls one message back into the composer; **restore
  all** pulls every queued message back
- **Stop** cancels the run and returns queued messages to the editor (same as
  Pi TUI Escape)

Delivery mode follows Pi's `steeringMode` / `followUpMode` settings
(`"one-at-a-time"` by default, or `"all"` to deliver everything at once).
