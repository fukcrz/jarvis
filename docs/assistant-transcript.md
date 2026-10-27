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

While a thinking block is generating, the row is only its latest line. The run indicator already says 思考中 and carries the elapsed time, so the row does not repeat that status. After completion, the row reads 思考了 N 秒. Opening a block shows the full text in a quiet panel, without a title or rendered headings; a manual open or close survives later tokens and completion. Duration is measured from `thinking_start` to `thinking_end` and persisted in the `jarvis.generation` custom entry as `thinking`, keyed by content index. Commentary inside a completed process is smaller and muted. Token/speed/duration statistics appear only under a turn's final answer, when the values are known and non-zero.

During the whole active run, thinking, commentary, and tool rows stay in the timeline without a 过程 summary. A completed text block does not end that run. Standalone commands and manual compaction preserve the previous completed reply and its details. Only when the run settles do the rows collapse into 过程 below the user's message and above the final reply; file changes appear below the final reply text and above its copy/fork controls and generation statistics. A turn without a final reply still keeps its process available. Opening a settled process by hand is kept. The 过程 header carries elapsed time, tool category counts (for example `读取 2 · 命令 1`), and `改了 N 个文件` when edits landed. An expanded process shows the original ordered rows and results. Command rows show their first line, with an ellipsis for multi-line commands; the full command is in the row's details.

A settled process is the parent fold. Consecutive tools share a category/count label; groups default open while running and may be folded manually, with that choice retained after settlement. Each tool row shows a disclosure chevron and keeps its own detail state. Folding a process hides its details without resetting them. Manual choices for thinking, tool details, and groups survive later events and completion. Pending extension input stays outside the process fold. Failed tools and error diagnostics stay accessible. A turn that ends in failure shows one card instead of separate attempt and run-failure cards: which step failed (the last failed tool, if any), a plain-language reason for common errors (401/403/429/5xx, network, context length), how many automatic retries happened, 重试 (re-sends that turn's user message through edit-and-resend) and 继续 (sends 「继续」) while idle, and the raw errors folded under 原始错误. The status-level run failure card is suppressed when the last turn already ends with that card; on its own it also gets the plain reason and the same buttons. User `!cmd` entries remain outside the process fold.

## Long answers

A final answer has a copy button (复制整段回答) at the start of its footer line, next to the stats. Markdown tables sit in a horizontal scroller instead of squeezing into narrow columns (on phones the table may grow up to 620px wide and scroll). h1–h4 headings get an id and a hover `#` button that scrolls that section to the top; it is a button rather than an `href` anchor because the app uses hash routing.

## Run status bar

An active run always has an inline indicator after the latest timeline content, showing its activity and elapsed time. It participates in normal layout and scrolls with the messages. Activities include `正在执行：<command or tool>`, `思考中`, `正在回复`, `正在压缩上下文`, `等待重试`, `正在停止`, and `执行中` between steps.

Only when the timeline is more than 300px from the bottom does a floating capsule appear above the composer. It replaces the jump-to-latest button during an active run. Returning to the bottom hides it; on mobile an expanded composer taller than 140px also hides it. Clicking the capsule scrolls to the active step, streaming reply, or bottom. The inline indicator disappears when the run becomes idle.

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
```

`ui-run-status-smoke.mjs` separately injects protocol events into the client socket. It checks the inline indicator through streaming, tools, thinking, gaps between responses, retry, compaction, and stopping; the 300px scroll boundary; mobile composer sizing; and the DOM and visual order of the completed process before the final reply, with file changes after its text and before the message actions. It captures screenshots and layout measurements on desktop and mobile.

The smoke scripts use deterministic fixtures and require no external model calls. They check Jarvis behavior for the supplied structured metadata; upstream model/provider classification depends on the metadata Pi emits. Production port 9528 is not used by this script. Production restart remains user-triggered under [BOOTSTRAP.md](../BOOTSTRAP.md).
