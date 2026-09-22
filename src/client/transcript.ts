import { THINKING_LEVELS, type CompactionReason, type ContextSummaryTimelineItem, type ContextUsage, type ErrorTimelineItem, type ExtensionUiRequest, type ExtensionUiTimelineItem, type ImageAttachment, type MessageTimelineItem, type ModelDescriptor, type RetryStatus, type SessionEvent, type SessionModelSnapshot, type SessionQueue, type SessionStatus, type SessionStreamSnapshot, type SessionThinkingSnapshot, type SubagentCallView, type SubagentView, type ThinkingLevel, type ThinkingTimelineItem, type TimelineItem, type TimelinePage, type ToolTimelineItem, emptySessionQueue, recordSessionQueue } from "../shared/protocol";
import { isRecord } from "../shared/protocol";

export interface TranscriptState {
  items: TimelineItem[];
  start: number;
  total: number;
  hasMore: boolean;
  seq: number;
  status: SessionStatus;
  model: SessionModelSnapshot;
  thinking: SessionThinkingSnapshot;
  contextUsage?: ContextUsage;
  streamingMessageId?: string;
  /** 排队等待投递的用户消息。 */
  queue: SessionQueue;
}

export const emptyTranscript: TranscriptState = {
  items: [],
  start: 0,
  total: 0,
  hasMore: false,
  seq: 0,
  status: { sessionId: "", runState: "idle" },
  model: { available: [] },
  thinking: { current: "off", available: ["off"] },
  queue: emptySessionQueue,
};

export function hydrateTranscript(previous: TranscriptState, page: TimelinePage, snapshot: SessionStreamSnapshot): TranscriptState {
  const extensionItems: ExtensionUiTimelineItem[] = snapshot.extensionUi?.cards ?? (snapshot.extensionUi?.dialogs ?? []).map(({ request, createdAt }) => ({ kind: "extension-ui", id: `ext:${request.id}`, createdAt, request }));
  const live = [...snapshot.liveMessages, ...(snapshot.liveErrors ?? []), ...(snapshot.partialThinking === undefined ? [] : [snapshot.partialThinking]), ...snapshot.activeTools, ...(snapshot.partial === undefined ? [] : [snapshot.partial]), ...(snapshot.activeBash === undefined ? [] : [snapshot.activeBash])];
  // History and the snapshot are authoritative after a reconnect. A cached
  // transcript may include earlier pages; retain them only when the server
  // version and size still match, otherwise a rewrite could revive old items.
  // Unconfirmed optimistic user messages are the exception: drop them only
  // once a matching persisted/live user message is present, otherwise a
  // mobile resync would make the just-sent bubble vanish.
  const preserveEarlier = previous.seq === snapshot.seq
    && previous.total === page.total
    && previous.start < page.start;
  const history = preserveEarlier ? mergeTimeline(previous.items, page.items) : page.items;
  const authoritative = reuseUnchangedTimelineItems(previous.items, mergeTimeline(history, live, extensionItems));
  return {
    items: sortTimelineByCreatedAt(mergeTimeline(authoritative, unmatchedOptimisticUserMessages(previous.items, authoritative))),
    start: preserveEarlier ? previous.start : page.start,
    total: page.total,
    hasMore: preserveEarlier ? previous.hasMore : page.hasMore,
    seq: Math.max(previous.seq, snapshot.seq),
    status: snapshot.status,
    model: snapshot.model,
    thinking: snapshot.thinking,
    ...(snapshot.contextUsage === undefined ? {} : { contextUsage: snapshot.contextUsage }),
    ...(snapshot.partial === undefined ? {} : { streamingMessageId: snapshot.partial.id }),
    queue: snapshot.queue ?? emptySessionQueue,
  };
}

export function addOptimisticUserMessage(state: TranscriptState, id: string, text: string, images: MessageTimelineItem["images"] = []): TranscriptState {
  return { ...state, items: mergeTimeline(state.items, [optimisticUserMessage(id, text, images)]) };
}

export function removeOptimisticUserMessage(state: TranscriptState, id: string): TranscriptState {
  const itemId = `optimistic:user:${id}`;
  return { ...state, items: state.items.filter((item) => item.id !== itemId) };
}

export function replaceUserMessageWithOptimistic(state: TranscriptState, messageId: string, optimisticId: string, text: string, images: MessageTimelineItem["images"] = []): TranscriptState {
  const target = state.items.findIndex((item) => item.kind === "message" && item.id === messageId && item.role === "user");
  if (target === -1) return addOptimisticUserMessage(state, optimisticId, text, images);
  return { ...state, items: [...state.items.slice(0, target), optimisticUserMessage(optimisticId, text, images)] };
}

export function prependTranscript(state: TranscriptState, page: TimelinePage): TranscriptState {
  return {
    ...state,
    items: mergeTimeline(page.items, state.items),
    start: page.start,
    total: page.total,
    hasMore: page.hasMore,
  };
}

export function applySessionEvents(state: TranscriptState, events: SessionEvent[]): TranscriptState {
  return events.reduce(applySessionEvent, state);
}

export function applySessionEvent(state: TranscriptState, event: SessionEvent): TranscriptState {
  if (event.seq <= state.seq) return state;
  const next = { ...state, seq: event.seq };
  if (event.type === "queue.updated") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const queue = recordSessionQueue(payload);
    return queue === undefined ? next : { ...next, queue };
  }
  if (event.type === "session.rewritten") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const items = Array.isArray(payload?.["items"]) ? payload["items"].flatMap(recordTimelineItem) : undefined;
    const status = recordStatus(payload?.["status"]);
    if (items === undefined || status === undefined) return next;
    return { ...next, items, start: 0, total: items.length, hasMore: false, status, streamingMessageId: undefined };
  }
  if (event.type === "context.updated") {
    const payload = isRecord(event.payload) ? event.payload : {};
    const contextUsage = payload["contextUsage"];
    if (isRecord(contextUsage)) {
      const tokens = typeof contextUsage["tokens"] === "number" || contextUsage["tokens"] === null ? contextUsage["tokens"] : null;
      const percent = typeof contextUsage["percent"] === "number" || contextUsage["percent"] === null ? contextUsage["percent"] : null;
      const contextWindow = typeof contextUsage["contextWindow"] === "number" ? contextUsage["contextWindow"] : 0;
      return { ...next, contextUsage: { tokens, percent, contextWindow } };
    }
  }
  if (event.type === "message.created") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const message = recordMessage(payload?.["message"]);
    if (message === undefined) return next;
    // One in-flight send owns at most one optimistic bubble. Matching by exact
    // text fails when the composer still has a trailing newline and the server
    // trims before persisting, so drop every optimistic user message here.
    const items = message.role === "user" ? withoutOptimisticUserMessages(next.items) : next.items;
    return { ...next, items: mergeTimeline(items, [message]) };
  }
  if (event.type === "assistant.delta") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const messageId = typeof payload?.["messageId"] === "string" ? payload["messageId"] : undefined;
    const delta = typeof payload?.["delta"] === "string" ? payload["delta"] : "";
    if (messageId === undefined || delta === "") return next;
    const existing = next.items.find((item) => item.kind === "message" && item.id === messageId) as MessageTimelineItem | undefined;
    const message: MessageTimelineItem = existing === undefined
      ? { kind: "message", id: messageId, role: "assistant", createdAt: event.emittedAt, text: delta }
      : { ...existing, text: existing.text + delta };
    return { ...next, items: upsertStreamingMessage(next.items, message), streamingMessageId: messageId };
  }
  if (event.type === "assistant.completed") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const message = recordMessage(payload?.["message"]);
    if (message === undefined) return next;
    const updated = { ...next, items: mergeTimeline(next.items, [message]) };
    return updated.streamingMessageId === message.id ? withoutStreamingMessage(updated) : updated;
  }
  if (event.type === "thinking.delta") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const id = typeof payload?.["thinkingId"] === "string" ? payload["thinkingId"] : undefined;
    const delta = typeof payload?.["delta"] === "string" ? payload["delta"] : "";
    if (id === undefined || delta === "") return next;
    const createdAt = typeof payload?.["createdAt"] === "string" ? payload["createdAt"] : event.emittedAt;
    const existing = next.items.find((item): item is ThinkingTimelineItem => item.kind === "thinking" && item.id === id);
    const item: ThinkingTimelineItem = existing === undefined
      ? { kind: "thinking", id, createdAt, state: "running", text: delta }
      : { ...existing, text: existing.text + delta };
    return { ...next, items: mergeTimeline(next.items, [item]) };
  }
  if (event.type === "thinking.completed") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const id = typeof payload?.["thinkingId"] === "string" ? payload["thinkingId"] : undefined;
    if (id === undefined) return next;
    const createdAt = typeof payload?.["createdAt"] === "string" ? payload["createdAt"] : event.emittedAt;
    const existing = next.items.find((item): item is ThinkingTimelineItem => item.kind === "thinking" && item.id === id);
    const text = typeof payload?.["text"] === "string" && payload["text"] !== "" ? payload["text"] : (existing?.text ?? "");
    const item: ThinkingTimelineItem = { kind: "thinking", id, createdAt: existing?.createdAt ?? createdAt, state: "completed", text };
    return { ...next, items: mergeTimeline(next.items, [item]) };
  }
  if (event.type === "tool.upsert") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const tool = recordTool(payload?.["tool"]);
    return tool === undefined ? next : { ...next, items: mergeTimeline(next.items, [tool]) };
  }
  if (event.type === "bash.delta") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const runId = typeof payload?.["runId"] === "string" ? payload["runId"] : event.runId;
    const delta = typeof payload?.["delta"] === "string" ? payload["delta"] : "";
    if (runId === undefined || delta === "") return next;
    const id = `bash:${runId}`;
    const existing = next.items.find((item): item is ToolTimelineItem => item.kind === "tool" && item.id === id);
    const item: ToolTimelineItem = existing === undefined
      ? { kind: "tool", id, createdAt: event.emittedAt, name: "bash", title: "Run command", state: "running", output: delta }
      : { ...existing, state: "running", output: (existing.output ?? "") + delta };
    return { ...next, items: mergeTimeline(next.items, [item]) };
  }
  if (event.type === "bash.settled") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const runId = typeof payload?.["runId"] === "string" ? payload["runId"] : event.runId;
    const settled = runId === undefined ? next : { ...next, items: next.items.filter((item) => item.kind !== "tool" || item.id !== `bash:${runId}`) };
    const item = recordTool(payload?.["item"]);
    return item === undefined ? settled : { ...settled, items: mergeTimeline(settled.items, [item]) };
  }
  if (event.type === "timeline.upsert") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const items = recordTimelineItem(payload?.["item"]);
    return items.length === 0 ? next : { ...next, items: mergeTimeline(next.items, items) };
  }
  if (event.type === "extension.uiRequest") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const request = recordExtensionUiRequest(payload?.["request"]);
    if (request === undefined) return next;
    const item: ExtensionUiTimelineItem = { kind: "extension-ui", id: `ext:${request.id}`, createdAt: event.emittedAt, request };
    return { ...next, items: mergeTimeline(next.items, [item]) };
  }
  if (event.type === "extension.uiSettled") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const id = typeof payload?.["id"] === "string" ? `ext:${payload["id"]}` : undefined;
    const outcome = payload?.["outcome"];
    if (id === undefined || (outcome !== "answered" && outcome !== "cancelled" && outcome !== "timeout" && outcome !== "closed")) return next;
    const existing = next.items.find((item): item is ExtensionUiTimelineItem => item.kind === "extension-ui" && item.id === id);
    if (existing === undefined) return next;
    const updated: ExtensionUiTimelineItem = {
      ...existing,
      outcome,
      ...(outcome === "answered" && typeof payload?.["value"] === "string" ? { value: payload["value"] } : {}),
      ...(outcome === "answered" && typeof payload?.["confirmed"] === "boolean" ? { confirmed: payload["confirmed"] } : {}),
    };
    return { ...next, items: mergeTimeline(next.items, [updated]) };
  }
  if (event.type === "model.changed") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const model = recordModelSnapshot(payload?.["model"]);
    return model === undefined ? next : { ...next, model };
  }
  if (event.type === "thinking.changed") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const thinking = recordThinkingSnapshot(payload?.["thinking"]);
    return thinking === undefined ? next : { ...next, thinking };
  }
  if (event.type === "run.started") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const status = recordStatus(payload?.["status"]);
    const bashItem = recordTool(payload?.["bash"]);
    if (status === undefined) return next;
    return bashItem === undefined
      ? { ...next, status }
      : { ...next, status, items: mergeTimeline(next.items, [bashItem]) };
  }
  if (event.type === "run.stopping" || event.type === "run.settled" || event.type === "run.failed" || event.type === "run.retrying" || event.type === "run.retryEnd" || event.type === "run.compactionStarted" || event.type === "run.compactionEnded" || event.type === "run.compactionRetrying" || event.type === "session.updated") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const status = recordStatus(payload?.["status"]);
    if (status === undefined) return next;
    const updated = { ...next, status };
    if (event.type === "run.settled" || event.type === "run.failed" || event.type === "run.retrying") return withoutStreamingMessage(updated, event.type === "run.retrying", event.type === "run.retrying");
    return updated;
  }
  return next;
}

function withoutStreamingMessage(state: TranscriptState, completeThinking = false, removeStreamingMessage = false): TranscriptState {
  const streamingMessageId = state.streamingMessageId;
  return {
    ...state,
    streamingMessageId: undefined,
    items: state.items
      .filter((item) => !removeStreamingMessage || streamingMessageId === undefined || item.id !== streamingMessageId)
      .map((item) => completeThinking && item.kind === "thinking" && item.state === "running" ? { ...item, state: "completed" as const } : item),
  };
}

function mergeTimeline(...groups: TimelineItem[][]): TimelineItem[] {
  const result: TimelineItem[] = [];
  for (const group of groups) {
    for (const item of group) upsert(result, item);
  }
  return result;
}

function reuseUnchangedTimelineItems(previous: TimelineItem[], next: TimelineItem[]): TimelineItem[] {
  if (previous.length === 0) return next;
  const byId = new Map(previous.map((item) => [item.id, item]));
  let reused = false;
  const items = next.map((item) => {
    const prior = byId.get(item.id);
    if (prior !== undefined && sameTimelineItem(prior, item)) {
      reused = true;
      return prior;
    }
    return item;
  });
  return reused ? items : next;
}

function sameTimelineItem(left: TimelineItem, right: TimelineItem): boolean {
  if (left === right) return true;
  // Only messages are reused. Tool/thinking cards have extra fields (title,
  // subagent, error) that a partial compare would leave stale on hydrate.
  return left.kind === "message" && right.kind === "message"
    && left.id === right.id
    && left.createdAt === right.createdAt
    && left.role === right.role
    && left.text === right.text
    && sameImages(left.images, right.images);
}

function sameImages(left: ImageAttachment[] | undefined, right: ImageAttachment[] | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((image, index) => {
    const other = right[index];
    return other !== undefined && image.mimeType === other.mimeType && image.url === other.url && image.data === other.data;
  });
}

function upsertStreamingMessage(items: TimelineItem[], message: MessageTimelineItem): TimelineItem[] {
  const completedThinking = items.some((item) => item.kind === "thinking" && item.state === "running")
    ? items.map((item) => item.kind === "thinking" && item.state === "running" ? { ...item, state: "completed" as const } : item)
    : items;
  const index = completedThinking.findIndex((item) => item.id === message.id);
  if (index === -1) return mergeTimeline(completedThinking, [message]);
  const next = completedThinking.slice();
  next[index] = message;
  return next;
}

/** Runtime-only cards need to rejoin persisted history at their original time. */
function sortTimelineByCreatedAt(items: TimelineItem[]): TimelineItem[] {
  return items
    .map((item, index) => ({ item, index, timestamp: Date.parse(item.createdAt) }))
    .sort((a, b) => {
      const byTime = (Number.isFinite(a.timestamp) ? a.timestamp : 0) - (Number.isFinite(b.timestamp) ? b.timestamp : 0);
      return byTime === 0 ? a.index - b.index : byTime;
    })
    .map(({ item }) => item);
}

function upsert(items: TimelineItem[], item: TimelineItem): void {
  const byId = items.findIndex((candidate) => candidate.id === item.id);
  if (byId !== -1) {
    items[byId] = item;
    return;
  }
  items.push(item);
}

function recordTimelineItem(value: unknown): TimelineItem[] {
  const message = recordMessage(value);
  if (message !== undefined) return [message];
  const error = recordError(value);
  if (error !== undefined) return [error];
  const tool = recordTool(value);
  if (tool !== undefined) return [tool];
  const thinking = recordThinkingItem(value);
  if (thinking !== undefined) return [thinking];
  const summary = recordContextSummary(value);
  return summary === undefined ? [] : [summary];
}

function optimisticUserMessage(id: string, text: string, images: MessageTimelineItem["images"] = []): MessageTimelineItem {
  return { kind: "message", id: `optimistic:user:${id}`, role: "user", createdAt: new Date().toISOString(), text: text.trim(), ...(images.length === 0 ? {} : { images }) };
}

function isOptimisticUserMessage(item: TimelineItem): item is MessageTimelineItem {
  return item.kind === "message" && item.role === "user" && item.id.startsWith("optimistic:user:");
}

function withoutOptimisticUserMessages(items: TimelineItem[]): TimelineItem[] {
  return items.filter((item) => !isOptimisticUserMessage(item));
}

function unmatchedOptimisticUserMessages(previous: TimelineItem[], authoritative: TimelineItem[]): MessageTimelineItem[] {
  const previousIds = new Set(previous.map((item) => item.id));
  const newlyConfirmed = authoritative.filter((item): item is MessageTimelineItem => item.kind === "message" && item.role === "user" && !item.id.startsWith("optimistic:user:") && !previousIds.has(item.id));
  return previous.filter((item): item is MessageTimelineItem => isOptimisticUserMessage(item) && !newlyConfirmed.some((message) => sameUserMessage(item, message)));
}

function recordMessage(value: unknown): MessageTimelineItem | undefined {
  if (!isRecord(value) || value["kind"] !== "message") return undefined;
  if ((value["role"] !== "user" && value["role"] !== "assistant") || typeof value["id"] !== "string" || typeof value["createdAt"] !== "string" || typeof value["text"] !== "string") return undefined;
  const images = Array.isArray(value["images"]) ? value["images"].flatMap(recordImageAttachment) : [];
  return { kind: "message", id: value["id"], role: value["role"], createdAt: value["createdAt"], text: value["text"], ...(images.length === 0 ? {} : { images }) };
}

function sameUserMessage(a: MessageTimelineItem, b: MessageTimelineItem): boolean {
  if (a.role !== "user" || b.role !== "user" || a.text.trim() !== b.text.trim()) return false;
  const aImages = a.images ?? [];
  const bImages = b.images ?? [];
  return aImages.length === bImages.length && aImages.every((image, index) => sameImageAttachment(image, bImages[index]));
}

function recordImageAttachment(value: unknown): ImageAttachment[] {
  if (!isRecord(value) || typeof value["mimeType"] !== "string" || value["mimeType"] === "") return [];
  const mimeType = value["mimeType"];
  const data = typeof value["data"] === "string" && value["data"] !== "" ? value["data"] : undefined;
  const url = typeof value["url"] === "string" && value["url"] !== "" ? value["url"] : undefined;
  if (data === undefined && url === undefined) return [];
  return [{ mimeType, ...(data === undefined ? {} : { data }), ...(url === undefined ? {} : { url }) }];
}

function sameImageAttachment(a: ImageAttachment, b: ImageAttachment | undefined): boolean {
  if (b === undefined || a.mimeType !== b.mimeType) return false;
  if (a.data !== undefined && b.data !== undefined) return a.data === b.data;
  if (a.url !== undefined && b.url !== undefined) return a.url === b.url;
  return a.data === b.data && a.url === b.url;
}

function recordError(value: unknown): ErrorTimelineItem | undefined {
  if (!isRecord(value) || value["kind"] !== "error") return undefined;
  if (typeof value["id"] !== "string" || typeof value["createdAt"] !== "string" || typeof value["code"] !== "string" || typeof value["message"] !== "string") return undefined;
  const state = value["state"];
  if (state !== "retrying" && state !== "failed" && state !== "recovered") return undefined;
  const diagnostics = isRecord(value["diagnostics"])
    ? Object.entries(value["diagnostics"]).flatMap(([key, entry]) => typeof entry === "string" && entry !== "" ? [[key, entry] as const] : [])
    : [];
  return {
    kind: "error",
    id: value["id"],
    createdAt: value["createdAt"],
    ...(typeof value["groupId"] === "string" && value["groupId"] !== "" ? { groupId: value["groupId"] } : {}),
    code: value["code"],
    message: value["message"],
    state,
    ...(typeof value["attempt"] === "number" && Number.isFinite(value["attempt"]) ? { attempt: value["attempt"] } : {}),
    ...(typeof value["maxAttempts"] === "number" && Number.isFinite(value["maxAttempts"]) ? { maxAttempts: value["maxAttempts"] } : {}),
    ...(typeof value["retryAt"] === "string" ? { retryAt: value["retryAt"] } : {}),
    ...(diagnostics.length === 0 ? {} : { diagnostics: Object.fromEntries(diagnostics) }),
  };
}

function recordThinkingItem(value: unknown): ThinkingTimelineItem | undefined {
  if (!isRecord(value) || value["kind"] !== "thinking") return undefined;
  const state = value["state"];
  if (state !== "running" && state !== "completed") return undefined;
  if (typeof value["id"] !== "string" || typeof value["createdAt"] !== "string" || typeof value["text"] !== "string") return undefined;
  return { kind: "thinking", id: value["id"], createdAt: value["createdAt"], state, text: value["text"] };
}

function recordTool(value: unknown): ToolTimelineItem | undefined {
  if (!isRecord(value) || value["kind"] !== "tool") return undefined;
  if (typeof value["id"] !== "string" || typeof value["createdAt"] !== "string" || typeof value["name"] !== "string" || typeof value["title"] !== "string") return undefined;
  const state = value["state"];
  if (state !== "queued" && state !== "running" && state !== "completed" && state !== "failed" && state !== "cancelled") return undefined;
  return {
    kind: "tool",
    id: value["id"],
    createdAt: value["createdAt"],
    name: value["name"],
    title: value["title"],
    state,
    ...(typeof value["target"] === "string" ? { target: value["target"] } : {}),
    ...(typeof value["inputPreview"] === "string" ? { inputPreview: value["inputPreview"] } : {}),
    ...(typeof value["cwd"] === "string" ? { cwd: value["cwd"] } : {}),
    ...(typeof value["exitCode"] === "number" && Number.isFinite(value["exitCode"]) ? { exitCode: value["exitCode"] } : {}),
    ...(typeof value["durationMs"] === "number" && Number.isFinite(value["durationMs"]) ? { durationMs: value["durationMs"] } : {}),
    ...(value["truncated"] === true ? { truncated: true } : {}),
    ...(value["excludeFromContext"] === true ? { excludeFromContext: true } : {}),
    ...(typeof value["output"] === "string" ? { output: value["output"] } : {}),
    ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
    ...toolImagesFromValue(value["images"]),
    ...recordSubagentView(value["subagent"]),
  };
}

function recordSubagentView(value: unknown): { subagent: SubagentView } | Record<string, never> {
  if (!isRecord(value) || value["kind"] !== "pi-subagent" || !Array.isArray(value["results"])) return {};
  const results = value["results"].flatMap(recordSubagentCall);
  if (results.length === 0) return {};
  return {
    subagent: {
      kind: "pi-subagent",
      results,
      total: results.length,
      completed: results.filter((call) => call.state === "completed").length,
      running: results.filter((call) => call.state === "running").length,
      failed: results.filter((call) => call.state === "failed").length,
    },
  };
}

function recordSubagentCall(value: unknown): SubagentCallView[] {
  if (!isRecord(value) || typeof value["agent"] !== "string" || value["agent"] === "" || typeof value["prompt"] !== "string") return [];
  const state = value["state"];
  if (state !== "running" && state !== "completed" && state !== "failed" && state !== "cancelled") return [];
  const source = value["source"];
  const toolCalls = Array.isArray(value["toolCalls"])
    ? value["toolCalls"].flatMap((entry) => {
      if (!isRecord(entry) || typeof entry["name"] !== "string" || entry["name"] === "" || typeof entry["summary"] !== "string") return [];
      return [{ name: entry["name"], summary: entry["summary"] }];
    }).slice(0, 4)
    : [];
  return [{
    agent: value["agent"],
    prompt: value["prompt"],
    state,
    ...(source === "user" || source === "project" || source === "unknown" ? { source } : {}),
    ...(typeof value["model"] === "string" && value["model"] !== "" ? { model: value["model"] } : {}),
    ...(typeof value["turns"] === "number" && Number.isFinite(value["turns"]) && value["turns"] > 0 ? { turns: value["turns"] } : {}),
    ...(typeof value["sessionHandle"] === "string" && value["sessionHandle"] !== "" ? { sessionHandle: value["sessionHandle"] } : {}),
    ...(typeof value["output"] === "string" && value["output"] !== "" ? { output: value["output"] } : {}),
    ...(typeof value["error"] === "string" && value["error"] !== "" ? { error: value["error"] } : {}),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  }];
}

function toolImagesFromValue(value: unknown): { images: ImageAttachment[] } | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const images = value.flatMap(recordImageAttachment);
  return images.length === 0 ? {} : { images };
}

function recordExtensionUiRequest(value: unknown): ExtensionUiRequest | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["method"] !== "string") return undefined;
  const method = value["method"];
  if (method === "select") {
    if (!Array.isArray(value["options"]) || !value["options"].every((option) => typeof option === "string") || typeof value["title"] !== "string") return undefined;
    return { id: value["id"], method, title: value["title"], options: value["options"], ...(typeof value["timeout"] === "number" ? { timeout: value["timeout"] } : {}) };
  }
  if (method === "confirm") {
    if (typeof value["title"] !== "string") return undefined;
    return { id: value["id"], method, title: value["title"], ...(typeof value["message"] === "string" ? { message: value["message"] } : {}), ...(typeof value["timeout"] === "number" ? { timeout: value["timeout"] } : {}) };
  }
  if (method === "input") {
    if (typeof value["title"] !== "string") return undefined;
    return { id: value["id"], method, title: value["title"], ...(typeof value["placeholder"] === "string" ? { placeholder: value["placeholder"] } : {}), ...(typeof value["timeout"] === "number" ? { timeout: value["timeout"] } : {}) };
  }
  if (method === "editor") {
    if (typeof value["title"] !== "string") return undefined;
    return { id: value["id"], method, title: value["title"], ...(typeof value["prefill"] === "string" ? { prefill: value["prefill"] } : {}), ...(typeof value["timeout"] === "number" ? { timeout: value["timeout"] } : {}) };
  }
  if (method === "notify") {
    if (typeof value["message"] !== "string") return undefined;
    const notifyType = value["notifyType"];
    if (notifyType !== undefined && notifyType !== "info" && notifyType !== "warning" && notifyType !== "error") return undefined;
    return { id: value["id"], method, message: value["message"], notifyType };
  }
  return undefined;
}

function recordContextSummary(value: unknown): ContextSummaryTimelineItem | undefined {
  if (!isRecord(value) || value["kind"] !== "context-summary") return undefined;
  if (typeof value["id"] !== "string" || typeof value["createdAt"] !== "string" || typeof value["summary"] !== "string") return undefined;
  if (value["summaryType"] !== "compaction" && value["summaryType"] !== "branch") return undefined;
  return {
    kind: "context-summary",
    id: value["id"],
    createdAt: value["createdAt"],
    summaryType: value["summaryType"],
    summary: value["summary"],
    ...(typeof value["tokensBefore"] === "number" && Number.isFinite(value["tokensBefore"]) ? { tokensBefore: value["tokensBefore"] } : {}),
  };
}

function recordModelSnapshot(value: unknown): SessionModelSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value["available"])) return undefined;
  const available = value["available"].flatMap((item) => {
    const model = recordModel(item);
    return model === undefined ? [] : [model];
  });
  const current = recordModel(value["current"]);
  return { ...(current === undefined ? {} : { current }), available };
}

function recordModel(value: unknown): ModelDescriptor | undefined {
  if (!isRecord(value) || typeof value["provider"] !== "string" || typeof value["id"] !== "string" || typeof value["name"] !== "string" || typeof value["reasoning"] !== "boolean") return undefined;
  return { provider: value["provider"], id: value["id"], name: value["name"], reasoning: value["reasoning"], vision: value["vision"] === true, inScope: value["inScope"] === true };
}

function recordThinkingSnapshot(value: unknown): SessionThinkingSnapshot | undefined {
  if (!isRecord(value) || !isThinkingLevel(value["current"]) || !Array.isArray(value["available"])) return undefined;
  const available = value["available"].filter(isThinkingLevel);
  return { current: value["current"], available };
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function recordStatus(value: unknown): SessionStatus | undefined {
  if (!isRecord(value) || typeof value["sessionId"] !== "string") return undefined;
  const runState = value["runState"];
  if (runState !== "idle" && runState !== "running" && runState !== "stopping") return undefined;
  const activeRunValue = isRecord(value["activeRun"]) ? value["activeRun"] : undefined;
  const activeRun = typeof activeRunValue?.["id"] === "string" && typeof activeRunValue["startedAt"] === "string"
    ? { id: activeRunValue["id"], startedAt: activeRunValue["startedAt"], kind: activeRunValue["kind"] === "bash" ? "bash" as const : activeRunValue["kind"] === "compaction" ? "compaction" as const : "llm" as const }
    : undefined;
  const lastErrorValue = isRecord(value["lastError"]) ? value["lastError"] : undefined;
  const lastError = typeof lastErrorValue?.["code"] === "string" && typeof lastErrorValue["message"] === "string" && typeof lastErrorValue["occurredAt"] === "string"
    ? { code: lastErrorValue["code"], message: lastErrorValue["message"], occurredAt: lastErrorValue["occurredAt"] }
    : undefined;
  const retrying = recordRetryStatus(value["retrying"]);
  const compactingValue = isRecord(value["compacting"]) ? value["compacting"] : undefined;
  const compactingReason = compactingValue?.["reason"];
  const compactionRetrying = recordRetryStatus(compactingValue?.["retrying"]);
  const compacting = isCompactionReason(compactingReason) && typeof compactingValue?.["startedAt"] === "string"
    ? {
        reason: compactingReason,
        startedAt: compactingValue["startedAt"],
        ...(compactionRetrying === undefined ? {} : { retrying: compactionRetrying }),
      }
    : undefined;
  return { sessionId: value["sessionId"], runState, ...(activeRun === undefined ? {} : { activeRun }), ...(retrying === undefined ? {} : { retrying }), ...(compacting === undefined ? {} : { compacting }), ...(lastError === undefined ? {} : { lastError }) };
}

function isCompactionReason(value: unknown): value is CompactionReason {
  return value === "manual" || value === "threshold" || value === "overflow";
}

function recordRetryStatus(value: unknown): RetryStatus | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value["attempt"] !== "number" || !Number.isFinite(value["attempt"]) || typeof value["maxAttempts"] !== "number" || !Number.isFinite(value["maxAttempts"]) || typeof value["delayMs"] !== "number" || !Number.isFinite(value["delayMs"]) || typeof value["retryAt"] !== "string" || typeof value["errorMessage"] !== "string") return undefined;
  return {
    attempt: value["attempt"],
    maxAttempts: value["maxAttempts"],
    delayMs: value["delayMs"],
    retryAt: value["retryAt"],
    errorMessage: value["errorMessage"],
  };
}
