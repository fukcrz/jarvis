# Jarvis

Jarvis is a local, single-user coding workspace for persistent Pi sessions. It keeps Pi JSONL as the session-history source of truth and provides a React workbench for project/session navigation, model selection, streaming responses, tool activity, stop, and reconnect recovery.

## Requirements

- Node.js 24 or newer
- A configured Pi profile, normally `~/.pi/agent`

## Install & Run (preview builds)

Every commit and pull request triggers an instant preview release via
[pkg.pr.new](https://pkg.pr.new) — no npm publish involved. To install and run
the latest commit on `main`:

```bash
npx https://pkg.pr.new/fukcrz/jarvis/jarvis@main
```

or pin an exact commit:

```bash
npx https://pkg.pr.new/fukcrz/jarvis/jarvis@<commit-sha>
```

Once running, open `http://<machine-ip>:9528` from any reachable device. Use
`jarvis --help` after install for options (`--port`, `--host`, `--open`).

> **Security warning**: Jarvis has **no authentication** and can operate Pi
> sessions. Only run it on your local machine or a trusted LAN — never expose
> it to the public internet. It binds to `0.0.0.0` by default; use
> `--host 127.0.0.1` to restrict it to the local machine.

## Development

```bash
npm install
npm run dev
```

Open `http://<machine-ip>:28471` from any reachable device. In development, Vite listens on port `28471` and Fastify listens on port `39130`, both on all network interfaces.

For a production build served by Fastify directly:

```bash
npm run build
NODE_ENV=production npm start
```

The same build is what the preview packages ship (`npm pack` runs `prepack`,
which builds `dist/` automatically).

Jarvis stores only its Workspace registry in `~/.jarvis/workspaces.json`. Pi JSONL remains the authoritative conversation history. Do not write to the same Pi session concurrently from Jarvis and the Pi CLI.

## MVP Scope

- Expandable project tree with existing and new Pi sessions
- Project registration, session rename, filtering, and permanent session deletion
- Authenticated Pi model selection and per-session thinking levels, persisted as Pi history
- Text-only streaming prompts
- Tool execution status and output
- Stop, refresh, WebSocket reconnect, and paged history

Attachments, archive, terminal/files/Git panels, and extension dialogs are intentionally outside the MVP.

## Keyboard Shortcuts

- `Ctrl+P` — cycle to the next enabled model (skips disabled models, wraps around)
- `Shift+Tab` — cycle thinking level (wraps around)

Both mirror the Pi TUI bindings (`app.model.cycleForward`, `app.thinking.cycle`)
and only act on the currently selected session. They are skipped while a dialog,
menu, or autocomplete popup is open, during IME composition, and when the
connection is not live or a model/thinking switch or compaction is in progress.
`Ctrl+P` is intercepted before the browser print dialog; composer dedent stays
available via `Ctrl+[` (CodeMirror default).

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
