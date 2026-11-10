# Assistant transcript and process display

The transcript follows Pi content blocks rather than text heuristics. The same projection runs for authoritative live completion and persisted JSONL history. Jarvis does not change prompts, providers, token budgets, or how often a model emits commentary.

## Content classification

- Native `thinking` blocks become thinking items.
- Text phase is recorded, but it does not split the timeline. One user message is one turn. Everything before the trailing assistant text is the process; only that last text stays outside as the summary. If tools or thinking follow a text block, the text stays inside the process so later work is not shown before it.
- Language, length, headings, and phrases such as `Preparing` or `Reviewing` do not decide what is outside the process.
- Legacy unphased text containing `<thinking>…</thinking>` retains the existing import behavior. Explicitly phased text keeps its original content, including literal thinking markup.

Signatures must be JSON strings containing `v: 1`, a nonempty `id`, and a recognized phase. No provider or model name is required for classification.

## Identity and order

`assistantMessageId` associates the text, thinking, and tool calls of one source response. `contentIndex` is the original index in Pi's assistant content array. These optional fields travel through events, runtime snapshots, completion, and history projection.

Text block zero uses the existing assistant message ID; later blocks add `:text:<index>`. Thinking blocks use `:thinking` or `:thinking:<index>`. Tool IDs remain Pi's tool-call IDs. Timestamp-backed thinking IDs match between streaming and history; legacy history without a message timestamp retains its earlier thinking ID format.

A tool enters the timeline as queued at `toolcall_end`. Execution updates its state without moving its original position. A separate execution-start map measures duration; the source response timestamp remains the tool's transcript position.

The client orders blocks of a response by `contentIndex`, then groups adjacent tools for display. A user message starts a turn; standalone user commands form separate turns. Only an assistant text at the end of a conversation turn becomes its visible final reply; later tools, thinking, and errors remain in their original order.

## Streaming and authoritative completion

Pi's `partial` is mutable response-so-far. A start event creates an empty block; a delta appends only the event's own delta. Neither event copies the accumulated text from `partial`. `text_end` and `thinking_end` replace the corresponding block with their authoritative content, including empty content. Text phase can be calibrated from the matching partial block at `text_end`.

`message_end` replaces the full response using its authoritative content array. The `assistant.completed` payload includes `items` and `replaceIds`; an empty `items` array removes discarded provisional blocks. Single-item text/thinking/tool events remain available for clients using the older payload shape.

Delta coalescing preserves metadata and combines only events for the same identity, index, and phase. The sequence watermark continues to suppress already-applied events.

## Runtime snapshots and cleanup

`SessionStreamSnapshot` adds optional `partialAssistantItems`, `liveThinking`, and `streamingMessageIds`. The server always emits the new partial array and cursor list, even when empty. An empty list means the text blocks are sealed. The old `partial` and `partialThinking` fields remain as compatibility mirrors.

Hydration prefers the new partial array when present; it does not add the legacy mirrors again. Older snapshots still hydrate from the old fields. Completed thinking that has not yet reached persisted history remains available through `liveThinking`.

The client keeps a cursor for every open text block and retains `streamingMessageId` for existing callers. Ending one block removes only its cursor. Retry removes unfinished text blocks and settles running thinking. Server initialization, new runs, user bash commands, successful settlement, and failed settlement reset the added runtime state together.

## Process presentation

Thinking has no fold of its own and no chrome: no rule, title, chevron, or duration row. It is styled as text only: a CJK serif at 12.5px with 1.88 leading and slightly opened tracking, near-white rather than tinted, so the voice differs from the answer by letterform and rhythm instead of hue. Devices without a CJK serif fall back to the sans stack and keep the smaller size and looser leading. Commentary stays neutral sans beside it, so the two never read as the same voice. While generating it grows with each delta in the page flow, with no inner scroll box: the timeline owns scrolling and stays on the newest line until the user scrolls back; after completion the text stays in place. Hiding it is the turn's job: the process fold already collapses the whole run once it settles, and opening the process shows the asides again in order. Duration is measured from `thinking_start` to `thinking_end`, persisted in the `jarvis.generation` custom entry as `thinking`, keyed by content index, and surfaced in the process header. Commentary inside a completed process is smaller and muted. Token/speed/duration statistics appear only under a turn's final answer, when the values are known and non-zero.

During the whole active run, thinking, commentary, and tool rows stay in the timeline without a 过程 summary. A completed text block does not end that run. Standalone commands and manual compaction preserve the previous completed reply and its details. Only when the run settles do the rows collapse into 过程 below the user's message and above the final reply; file changes appear below the final reply text and above its copy/fork controls and generation statistics. A turn without a final reply still keeps its process available. Opening a settled process by hand is kept. The 过程 header carries elapsed time, tool category counts (for example `读取 2 · 命令 1`), and `改了 N 个文件` when edits landed. An expanded process shows the original ordered rows and results. Command rows show what the command actually runs, never its raw first line. `client/lib/command-summary.ts` splits the call into top-level statements, drops variable assignments, `$env:` assignments, `cd`, `echo`/`sleep` noise, and output redirections, resolves literal values assigned earlier in the same call, strips env prefixes and PowerShell's `&` call operator, unwraps `$(…)`, `(Cmdlet …).Prop` and `foreach { … }` bodies, drops heredoc and PowerShell here-string bodies while keeping the `<<EOF` marker, collapses inline `-e`/`-c` scripts, and shortens paths longer than 44 characters to `…/last-three-segments`. Up to three steps are joined with `→` and the rest become `+N`, capped at 150 characters; the untouched command stays in the row's details. The run status bar and subagent step lines use the same parser with a single step. Running rows never open their details on their own, whatever the command length: the row stays collapsed and shows its state icon plus elapsed time, so a long command is only read after an explicit click.

While the run is live the stream is a single-line log, not a group list. There is no category heading; instead consecutive completed steps of the same tool merge into one counted line (`读取 ×2`, `命令 ×3`) that opens into the individual steps, queued steps merge into one `等待 N 步` line that does not spin or count time, the step in flight keeps its own row (first command line, spinner, elapsed), and a failed step always keeps its own row. Density drops to 2px gaps and completed lines sit dimmer than the current one. Settlement restores the ordered diary inside 过程, where groups start collapsed and each step shows its own row again.

A settled process is the parent fold. Consecutive tools share a category/count label; inside an expanded process that group starts collapsed and opens on click, with the choice retained afterwards. Each tool row shows a disclosure chevron and keeps its own detail state. Folding a process hides its details without resetting them. Manual choices for tool details and groups survive later events and completion. Pending extension input stays outside the process fold. Failed tools and error diagnostics stay accessible. A turn that ends in failure shows one card instead of separate attempt and run-failure cards: which step failed (the last failed tool, if any), a plain-language reason for common errors (401/403/429/5xx, network, context length), how many automatic retries happened, 重试 (re-sends that turn's user message through edit-and-resend) and 继续 (sends 「继续」) while idle, and the raw errors folded under 原始错误. The status-level run failure card is suppressed when the last turn already ends with that card; on its own it also gets the plain reason and the same buttons. User `!cmd` entries remain outside the process fold.

## Long answers

A final answer has a copy button (复制整段回答) at the start of its footer line, next to the stats. Markdown tables sit in a horizontal scroller instead of squeezing into narrow columns (on phones the table may grow up to 620px wide and scroll). h1–h4 headings get an id and a hover `#` button that scrolls that section to the top; it is a button rather than an `href` anchor because the app uses hash routing.

## Run status bar

An active run always has an inline indicator after the latest timeline content, showing its activity and elapsed time. It participates in normal layout and scrolls with the messages. Activities include `正在执行：<command or tool>`, `思考中`, `正在回复`, `正在压缩上下文`, `等待重试`, `正在停止`, and `执行中` between steps.

Only when the timeline is more than 300px from the bottom does a floating capsule appear above the composer. It replaces the jump-to-latest button during an active run. Returning to the bottom hides it; on mobile an expanded composer taller than 140px also hides it. Clicking the capsule scrolls to the active step, streaming reply, or bottom. The inline indicator disappears when the run becomes idle.

## Subagent activity

A session whose root turn has ended can still have child threads running. `pi-subagent-manager` publishes each thread on `pi-subagent:live:v1`; the server turns those threads into `SessionSummary.subagentThreads` (path, type, state, one-line activity, run start, and a frozen elapsed time for paused threads). A finished thread leaves the list immediately, so an empty array means nothing is outstanding, and the field is the only source of both the sidebar marker and the composer status chip.

A thread that changes count or state publishes the session summary at once; a thread that only changed its activity line is throttled to one summary per second, so the list and the chip do not rebuild on every progress tick. Threads known only from a blocking tool result, with no live event, do not appear here.

The sidebar keeps its running ring for the root turn. When the root turn has ended and only child threads are running, the same ring uses `--subagent` (teal) and turns slower, and the relative time is hidden while it shows. Paused-only threads do not mark the session; they stay out of the chip as well, and only show up in the thread sheet while something else is running. In the list such a session ranks with running sessions, behind the sessions whose own turn is running.

One pill sits in the extension panel track above the input box, sharing the look of the plugin status pills (same border, radius and type size): `2 个子代理执行中`, or `1 个子代理执行中 · 1 已暂停` when a paused thread sits next to a running one. It appears only while at least one thread is running — completed, failed and stopped threads never appear there, and a paused thread alone does not hold the pill, because nothing in this UI sends the input it waits for. The pill disappears instead of showing zero, and the timeline clearance follows the dock height so it never covers a message. Clicking opens a sheet with each thread's type, activity line and elapsed time; picking a row brings that thread's card into view — the folded turn process is expanded if it hides the card, and earlier history is paged in (up to 20 pages) until the card exists; if it never appears, a notice says the card is not in history. The row then scrolls the card to the middle and flashes it. There is no stop action: the plugin exposes stopping only as a model tool.

## File changes

`edit` and `write` tool items carry a `fileChange` (path, added/removed line counts, display diff). It is first derived from the call arguments (edit `oldText`/`newText` pairs, or the whole written content) and replaced by the unified patch in Pi's `details.patch` once the edit succeeds; a failed edit drops it. The diff is capped at 400 lines. The row shows `+a −b` next to its title and opens to a coloured diff. After a turn settles, a `N 个文件 +a −b` line sits below the final answer text and above its copy/fork controls and generation statistics, with clickable file chips (existing text preview). Expanding it hides that summary and shows only each file's path, stats, and diff; the chevron on the first file collapses the block. Repeated edits to one file are merged.

## Verification

`session-pi-events.test.ts` exercises real EventHub envelopes through the client reducer and compares live, snapshot, and history identities/order. Projection, transcript, socket coalescing, tool summaries, and timeline grouping have focused regression tests.

The built-app smoke script starts its own temporary Jarvis/Pi environment on an ephemeral loopback port, injects structured events into the real server handler, and persists authoritative messages through the isolated SessionManager. It checks desktop and mobile layouts, previews, expanded records, ordinary and final replies, failures, pending input, user commands, refresh, and a real WebSocket disconnect/reconnect. It captures DOM snapshots, computed layout/style measurements, screenshots, and a JSON report.

```bash
npm run typecheck
npm test
npm run lint
npm run build
node scripts/ui-fold-smoke.mjs
node scripts/ui-run-status-smoke.mjs
node scripts/ui-subagent-status-smoke.mjs
```

`ui-run-status-smoke.mjs` separately injects protocol events into the client socket. It checks the inline indicator through streaming, tools, thinking, gaps between responses, retry, compaction, and stopping; the 300px scroll boundary; mobile composer sizing; and the DOM and visual order of the completed process before the final reply, with file changes after its text and before the message actions. It captures screenshots and layout measurements on desktop and mobile.

`ui-subagent-status-smoke.mjs` injects a session summary carrying child threads into the client socket. It checks the composer chip in its three shapes, the compact label and no horizontal overflow on phones, the sidebar ring colour with the relative time hidden, the sheet rows (type, activity, elapsed, paused tag, frozen pause time), and that clearing the threads removes both markers. It captures desktop and mobile screenshots.

The smoke scripts use deterministic fixtures and require no external model calls. They check Jarvis behavior for the supplied structured metadata; upstream model/provider classification depends on the metadata Pi emits. Production port 9528 is not used by this script. Production restart remains user-triggered under [BOOTSTRAP.md](../BOOTSTRAP.md).
