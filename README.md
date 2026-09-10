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

> **Security**: Jarvis ships with a single-password login (Settings → 安全).
> **Until you set a password, every request is allowed** — that is the default
> for local development. Because it can operate Pi sessions and delete files,
> set a password before exposing it beyond your own machine (LAN or tunnel),
> or bind to the local machine only with `--host 127.0.0.1`.

## Authentication

Settings → **安全** sets a single access password. With a password in place every
API route, file response and WebSocket handshake requires a logged-in browser;
without one Jarvis behaves exactly as before (open, no login screen).

- **Session** — login returns an `HttpOnly` `SameSite=Lax` cookie that lasts 7
days and is renewed on use, so a device you keep working from stays signed in.
- **No loopback exemption** — cloudflared, sish and frp all forward traffic from
`127.0.0.1`, so trusting the loopback address would hand the tunnel a free pass.
Login is required for local, LAN and tunnel requests alike.
- **Storage** — `~/.jarvis/auth.json` holds a salted scrypt hash (N=2¹⁵) plus an
HMAC signing secret; the password itself is never written to disk. Sessions are
stateless signed tokens, so they survive a restart.
- **Revocation** — changing or clearing the password invalidates every existing
session; *退出所有设备* does the same on demand, while *退出登录* only clears the
current browser.
- **Brute force** — after 3 failed attempts a client is asked to wait (5s, then
doubling, capped at 15 minutes). All tunnel traffic shares one client address,
so a hostile visitor can also delay logins by up to 15 minutes at a time.
- **WebSocket** — an unauthenticated handshake is closed with code `4401`; the
client drops back to the login page instead of reconnecting in a loop.

Clearing the password in Settings → 安全 (the *关闭认证* button) turns
authentication off again.

## Development

```bash
npm install
npm run dev
```

Open `http://<machine-ip>:28471` from any reachable device. In development, Vite listens on port `28471` and Fastify listens on port `39130`, both on all network interfaces.

For a production build served by Fastify directly:

```bash
npm run build
npm run prod:start # Background start; defaults to port 9528
npm run prod:stop  # Stop the background production server
```

`prod:start` does not rebuild and refuses to replace an existing service. Its PID is recorded under `.runtime/` and its output is appended to `logs/prod-9528.log`. The port can be overridden for both commands with `JARVIS_PORT` (or `PORT`). On macOS and Linux, `prod:stop` sends `SIGTERM` and waits for the server to close. Windows cannot deliver that signal to a detached Node process, so it terminates the server process tree immediately.

To run the production server attached to the current terminal instead, use:

```bash
npm run prod:foreground
```

The same build is what the preview packages ship (`npm pack` runs `prepack`,
which builds `dist/` automatically).

Jarvis stores only its Workspace registry in `~/.jarvis/workspaces.json`. Pi JSONL remains the authoritative conversation history. Do not write to the same Pi session concurrently from Jarvis and the Pi CLI.

## Pi CLI compatibility

Pi extensions that delegate work by spawning Pi sub-processes (`@mjakl/pi-subagent`,
Pi's own subagent example, ...) derive the child command from `process.argv[1]`. Jarvis
embeds Pi in its own server process, so that path points at
`dist/server/server/index.js` and the child would be a second Jarvis server instead of
a subagent.

Jarvis therefore recognizes Pi CLI invocations (`--mode text|json|rpc` — a flag Jarvis
never uses) and forwards them to the Pi CLI from the same
`@earendil-works/pi-coding-agent` install before any server code runs, then exits with
its status. `scripts/prod-foreground.mjs` applies the same check, so both production
launch paths behave identically; `npm run dev` (`tsx watch`) does not.

## MVP Scope

- Expandable project tree with existing and new Pi sessions
- Project registration, session rename, filtering, and permanent session deletion
- Authenticated Pi model selection and per-session thinking levels, persisted as Pi history
- Text-only streaming prompts
- Tool execution status and output
- Stop, refresh, WebSocket reconnect, and paged history

Attachments, archive, terminal/files/Git panels, and extension dialogs are intentionally outside the MVP.

## Run-End Notifications

When a session run finishes (or fails), Jarvis can pop a browser notification so you
can leave the tab in the background and get pinged when work is done:

- **Browser Notification API** — enable the *会话运行结束时弹出通知* toggle in
  Settings → 常规. The browser asks for permission once (a user gesture is
  required, so the toggle itself requests it).
- **Background only** — notifications are shown only while the Jarvis tab is
  hidden (`document.hidden`), so they never interrupt you while you are watching.
- **Content** — the notification carries the session name plus a preview of the
  last assistant message (or the failure reason). Clicking it focuses the tab.
- **Multi-tab dedup** — open Jarvis tabs coordinate over `BroadcastChannel`; a
  single run produces exactly one notification.

Note that this requires the tab to stay open (background is fine) and the
browser to keep running. It cannot fire when the tab or browser is closed.

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
