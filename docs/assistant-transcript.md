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

The client orders blocks of a response by `contentIndex`, then groups adjacent tools for display. It splits process sections at visible replies so multiple final or ordinary reply blocks and later operations retain their source order.

## Streaming and authoritative completion

Pi's `partial` is mutable response-so-far. A start event creates an empty block; a delta appends only the event's own delta. Neither event copies the accumulated text from `partial`. `text_end` and `thinking_end` replace the corresponding block with their authoritative content, including empty content. Text phase can be calibrated from the matching partial block at `text_end`.

`message_end` replaces the full response using its authoritative content array. The `assistant.completed` payload includes `items` and `replaceIds`; an empty `items` array removes discarded provisional blocks. Single-item text/thinking/tool events remain available for clients using the older payload shape.

Delta coalescing preserves metadata and combines only events for the same identity, index, and phase. The sequence watermark continues to suppress already-applied events.

## Runtime snapshots and cleanup

`SessionStreamSnapshot` adds optional `partialAssistantItems`, `liveThinking`, and `streamingMessageIds`. The server always emits the new partial array and cursor list, even when empty. An empty list means the text blocks are sealed. The old `partial` and `partialThinking` fields remain as compatibility mirrors.

Hydration prefers the new partial array when present; it does not add the legacy mirrors again. Older snapshots still hydrate from the old fields. Completed thinking that has not yet reached persisted history remains available through `liveThinking`.

The client keeps a cursor for every open text block and retains `streamingMessageId` for existing callers. Ending one block removes only its cursor. Retry removes unfinished text blocks and settles running thinking. Server initialization, new runs, user bash commands, successful settlement, and failed settlement reset the added runtime state together.

## Process presentation

Thinking is one muted line: `思考中 · 0:03` with the latest line as a preview while it runs, `思考 · 3s` once done (the duration is measured by Jarvis from `thinking_start` to `thinking_end` and persisted in the `jarvis.generation` custom entry as `thinking`, keyed by content index); it opens to its full content. Commentary inside the process is one step weaker than the final answer (smaller, muted). The token/speed/duration line appears only under a turn's final answer, and only when the values are known and non-zero; thinking and process text no longer carry it. While a run is active, the current turn is wrapped in 过程 like any other turn, but that process is expanded by default, so thinking, commentary, and tool rows are visible as they arrive. When the run becomes idle, an untouched process collapses and the final answer stays outside; once the user has opened or closed a process by hand, that choice is kept while running and after completion. The 过程 header carries the key facts so a collapsed process still tells what happened: elapsed time, category counts over all its tools (for example `读取 2 · 命令 1`), `改了 N 个文件` when edits landed, and a red `N 项失败` marker when a tool or the turn failed. Consecutive tools share a category/count label; an expanded process shows their original ordered rows and results. Command rows show a one-line summary (the first line, with an ellipsis for multi-line commands such as heredocs); the full command is in the row's details. Completed work stays available inside the process.

The process is the only parent fold. Tool groups are labels rather than a second toggle; each tool row keeps its own detail state. Opening a row opens the process, and folding the process hides details without resetting them. Manual expansion of a thought, tool result, or process is preserved across later events and completion. Pending extension input pins its process open. Failed tools and error diagnostics stay accessible. User `!cmd` entries remain outside the process fold.

## File changes

`edit` and `write` tool items carry a `fileChange` (path, added/removed line counts, display diff). It is first derived from the call arguments (edit `oldText`/`newText` pairs, or the whole written content) and replaced by the unified patch in Pi's `details.patch` once the edit succeeds; a failed edit drops it. The diff is capped at 400 lines. The row shows `+a −b` next to its title and opens to a coloured diff. After a turn settles, a `N 个文件 +a −b` line sits under the final answer with clickable file chips (existing text preview); it expands to per-file diffs, with repeated edits to one file merged.

## Verification

`session-pi-events.test.ts` exercises real EventHub envelopes through the client reducer and compares live, snapshot, and history identities/order. Projection, transcript, socket coalescing, tool summaries, and timeline grouping have focused regression tests.

The built-app smoke script starts its own temporary Jarvis/Pi environment on an ephemeral loopback port, injects structured events into the real server handler, and persists authoritative messages through the isolated SessionManager. It checks desktop and mobile layouts, previews, expanded records, ordinary and final replies, failures, pending input, user commands, refresh, and a real WebSocket disconnect/reconnect. It captures DOM snapshots, computed layout/style measurements, screenshots, and a JSON report.

```bash
npm run typecheck
npm test
npm run lint
npm run build
node scripts/ui-fold-smoke.mjs
```

The smoke script uses deterministic fixtures and requires no external model calls. It checks Jarvis behavior for the supplied structured metadata; upstream model/provider classification depends on the metadata Pi emits. Production port 9528 is not used by this script. Production restart remains user-triggered under [BOOTSTRAP.md](../BOOTSTRAP.md).
