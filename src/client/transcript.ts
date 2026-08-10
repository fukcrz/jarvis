import type { MessageTimelineItem, ModelDescriptor, SessionEvent, SessionModelSnapshot, SessionStatus, SessionStreamSnapshot, TimelineItem, TimelinePage, ToolTimelineItem } from "../shared/protocol";
import { isRecord } from "../shared/protocol";

export interface TranscriptState {
  items: TimelineItem[];
  start: number;
  total: number;
  hasMore: boolean;
  seq: number;
  status: SessionStatus;
  model: SessionModelSnapshot;
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
};

export function hydrateTranscript(previous: TranscriptState, page: TimelinePage, snapshot: SessionStreamSnapshot): TranscriptState {
  const live = [...snapshot.liveMessages, ...snapshot.activeTools, ...(snapshot.partial === undefined ? [] : [snapshot.partial])];
  return {
    // History and the snapshot are authoritative after a reconnect. Keeping an
    // old in-memory tail here can resurrect an already-settled partial/tool.
    items: mergeTimeline(page.items, live),
    start: page.start,
    total: page.total,
    hasMore: page.hasMore,
    seq: Math.max(previous.seq, snapshot.seq),
    status: snapshot.status,
    model: snapshot.model,
    ...(snapshot.partial === undefined ? {} : { streamingMessageId: snapshot.partial.id }),
  };
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
  if (event.type === "message.created") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const message = recordMessage(payload?.["message"]);
    return message === undefined ? next : { ...next, items: mergeTimeline(next.items, [message]) };
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
  if (event.type === "model.changed") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const model = recordModelSnapshot(payload?.["model"]);
    return model === undefined ? next : { ...next, model };
  }
  if (event.type === "run.started" || event.type === "run.stopping" || event.type === "run.settled" || event.type === "run.failed" || event.type === "session.updated") {
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
  return { kind: "message", id: value["id"], role: value["role"], createdAt: value["createdAt"], text: value["text"] };
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
    ...(typeof value["output"] === "string" ? { output: value["output"] } : {}),
    ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
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
  return { provider: value["provider"], id: value["id"], name: value["name"], reasoning: value["reasoning"] };
}

function recordStatus(value: unknown): SessionStatus | undefined {
  if (!isRecord(value) || typeof value["sessionId"] !== "string") return undefined;
  const runState = value["runState"];
  if (runState !== "idle" && runState !== "running" && runState !== "stopping") return undefined;
  const activeRunValue = isRecord(value["activeRun"]) ? value["activeRun"] : undefined;
  const activeRun = typeof activeRunValue?.["id"] === "string" && typeof activeRunValue["startedAt"] === "string"
    ? { id: activeRunValue["id"], startedAt: activeRunValue["startedAt"] }
    : undefined;
  const lastErrorValue = isRecord(value["lastError"]) ? value["lastError"] : undefined;
  const lastError = typeof lastErrorValue?.["code"] === "string" && typeof lastErrorValue["message"] === "string" && typeof lastErrorValue["occurredAt"] === "string"
    ? { code: lastErrorValue["code"], message: lastErrorValue["message"], occurredAt: lastErrorValue["occurredAt"] }
    : undefined;
  return { sessionId: value["sessionId"], runState, ...(activeRun === undefined ? {} : { activeRun }), ...(lastError === undefined ? {} : { lastError }) };
}
