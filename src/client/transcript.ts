import { THINKING_LEVELS, type CompactionReason, type ContextSummaryTimelineItem, type ContextUsage, type ExtensionUiRequest, type ExtensionUiTimelineItem, type MessageTimelineItem, type ModelDescriptor, type RetryStatus, type SessionEvent, type SessionModelSnapshot, type SessionStatus, type SessionStreamSnapshot, type SessionThinkingSnapshot, type ThinkingLevel, type TimelineItem, type TimelinePage, type ToolTimelineItem } from "../shared/protocol";
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
};

export function hydrateTranscript(previous: TranscriptState, page: TimelinePage, snapshot: SessionStreamSnapshot): TranscriptState {
  const extensionItems: ExtensionUiTimelineItem[] = (snapshot.extensionUi?.cards ?? (snapshot.extensionUi?.dialogs ?? []).map(({ request, createdAt }) => ({ kind: "extension-ui", id: `ext:${request.id}`, createdAt, request }))).filter((item) => item.request.method !== "notify");
  const live = [...snapshot.liveMessages, ...snapshot.activeTools, ...(snapshot.partial === undefined ? [] : [snapshot.partial]), ...(snapshot.activeBash === undefined ? [] : [snapshot.activeBash])];
  return {
    // History and the snapshot are authoritative after a reconnect. Keeping an
    // old in-memory tail here can resurrect an already-settled partial/tool.
    items: sortTimelineByCreatedAt(mergeTimeline(page.items, live, extensionItems)),
    start: page.start,
    total: page.total,
    hasMore: page.hasMore,
    seq: Math.max(previous.seq, snapshot.seq),
    status: snapshot.status,
    model: snapshot.model,
    thinking: snapshot.thinking,
    ...(snapshot.contextUsage === undefined ? {} : { contextUsage: snapshot.contextUsage }),
    ...(snapshot.partial === undefined ? {} : { streamingMessageId: snapshot.partial.id }),
  };
}

export function addOptimisticUserMessage(state: TranscriptState, id: string, text: string, images: MessageTimelineItem["images"] = []): TranscriptState {
  const item: MessageTimelineItem = { kind: "message", id: `optimistic:user:${id}`, role: "user", createdAt: new Date().toISOString(), text, ...(images.length === 0 ? {} : { images }) };
  return { ...state, items: mergeTimeline(state.items, [item]) };
}

export function removeOptimisticUserMessage(state: TranscriptState, id: string): TranscriptState {
  const itemId = `optimistic:user:${id}`;
  return { ...state, items: state.items.filter((item) => item.id !== itemId) };
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
    const withoutMatchingOptimistic = next.items.filter((item) => item.kind !== "message" || item.role !== "user" || !item.id.startsWith("optimistic:user:") || !sameUserMessage(item, message));
    return { ...next, items: mergeTimeline(withoutMatchingOptimistic, [message]) };
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
    return { ...next, items: mergeTimeline(next.items, [message]), streamingMessageId: messageId };
  }
  if (event.type === "assistant.completed") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const message = recordMessage(payload?.["message"]);
    if (message === undefined) return next;
    const updated = { ...next, items: mergeTimeline(next.items, [message]) };
    return updated.streamingMessageId === message.id ? withoutStreamingMessage(updated) : updated;
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
    const item = recordContextSummary(payload?.["item"]);
    return item === undefined ? next : { ...next, items: mergeTimeline(next.items, [item]) };
  }
  if (event.type === "extension.uiRequest") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const request = recordExtensionUiRequest(payload?.["request"]);
    // Notifications are transient browser chrome, never transcript history.
    if (request === undefined || request.method === "notify") return next;
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
    return event.type === "run.settled" || event.type === "run.failed" ? withoutStreamingMessage(updated) : updated;
  }
  return next;
}

function withoutStreamingMessage(state: TranscriptState): TranscriptState {
  return { ...state, streamingMessageId: undefined };
}

function mergeTimeline(...groups: TimelineItem[][]): TimelineItem[] {
  const result: TimelineItem[] = [];
  for (const group of groups) {
    for (const item of group) upsert(result, item);
  }
  return result;
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

function recordMessage(value: unknown): MessageTimelineItem | undefined {
  if (!isRecord(value) || value["kind"] !== "message") return undefined;
  if ((value["role"] !== "user" && value["role"] !== "assistant") || typeof value["id"] !== "string" || typeof value["createdAt"] !== "string" || typeof value["text"] !== "string") return undefined;
  const images = Array.isArray(value["images"])
    ? value["images"].flatMap((image) => isRecord(image) && typeof image["mimeType"] === "string" && typeof image["data"] === "string" ? [{ mimeType: image["mimeType"], data: image["data"] }] : [])
    : [];
  return { kind: "message", id: value["id"], role: value["role"], createdAt: value["createdAt"], text: value["text"], ...(images.length === 0 ? {} : { images }) };
}

function sameUserMessage(a: MessageTimelineItem, b: MessageTimelineItem): boolean {
  if (a.role !== "user" || b.role !== "user" || a.text !== b.text) return false;
  const aImages = a.images ?? [];
  const bImages = b.images ?? [];
  return aImages.length === bImages.length && aImages.every((image, index) => image.mimeType === bImages[index]?.mimeType && image.data === bImages[index]?.data);
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
  };
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
  return { provider: value["provider"], id: value["id"], name: value["name"], reasoning: value["reasoning"], vision: value["vision"] === true };
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
