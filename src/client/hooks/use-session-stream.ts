import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, sessionPath, socketUrl } from "../api";
import { isRecord, type ModelDescriptor, type SessionEvent, type SessionRef, type SessionThinkingSnapshot, type ThinkingLevel, sessionEventSchema } from "../../shared/protocol";
import { applySessionEvents, emptyTranscript, hydrateTranscript, prependTranscript, type TranscriptState } from "../transcript";

interface StreamState {
  transcript: TranscriptState;
  connection: "connecting" | "live" | "reconnecting" | "offline";
  error?: string;
}

export interface ExtensionPanelState {
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  statuses: Record<string, string>;
  /** 扩展 setEditorText 注入的草稿（nonce 用于触发 effect）。 */
  editorText?: { text: string; nonce: number };
}

type Action =
  | { type: "reset" }
  | { type: "hydrate"; page: Awaited<ReturnType<typeof api.timeline>>; snapshot: Awaited<ReturnType<typeof api.runtime>> }
  | { type: "events"; events: SessionEvent[] }
  | { type: "model"; model: ModelDescriptor }
  | { type: "thinking"; thinking: SessionThinkingSnapshot }
  | { type: "prepend"; page: Awaited<ReturnType<typeof api.timeline>> }
  | { type: "connection"; value: StreamState["connection"]; error?: string };

const initialState: StreamState = { transcript: emptyTranscript, connection: "offline" };

function reducer(state: StreamState, action: Action): StreamState {
  if (action.type === "reset") return initialState;
  if (action.type === "hydrate") return { ...state, transcript: hydrateTranscript(state.transcript, action.page, action.snapshot), error: undefined };
  if (action.type === "events") return { ...state, transcript: applySessionEvents(state.transcript, action.events) };
  if (action.type === "model") return { ...state, transcript: { ...state.transcript, model: { ...state.transcript.model, current: action.model } } };
  if (action.type === "thinking") return { ...state, transcript: { ...state.transcript, thinking: action.thinking } };
  if (action.type === "prepend") return { ...state, transcript: prependTranscript(state.transcript, action.page) };
  return { ...state, connection: action.value, ...(action.error === undefined ? {} : { error: action.error }) };
}

type PanelSideEffect =
  | { kind: "status"; key: string; text: string | undefined }
  | { kind: "widget"; key: string; lines: string[] | undefined; placement: "aboveEditor" | "belowEditor" }
  | { kind: "title"; title: string }
  | { kind: "editor"; text: string };

export function useSessionStream(ref: SessionRef | undefined) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [extensionPanels, setExtensionPanels] = useState<ExtensionPanelState>({ widgets: {}, statuses: {} });
  const stateRef = useRef(state);
  const refKey = ref === undefined ? undefined : `${ref.workspaceId}:${ref.sessionId}`;
  const refKeyRef = useRef(refKey);
  const requestFrame = useRef<number | undefined>(undefined);
  const queuedEvents = useRef<SessionEvent[]>([]);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { refKeyRef.current = refKey; }, [refKey]);

  const flushEvents = useCallback(() => {
    requestFrame.current = undefined;
    const events = queuedEvents.current.splice(0);
    const transcriptEvents: SessionEvent[] = [];
    const sideEffects: PanelSideEffect[] = [];
    for (const event of events) {
      if (event.type === "extension.uiRequest") {
        const effect = sideEffectFor(event);
        if (effect !== undefined) sideEffects.push(effect);
        else transcriptEvents.push(event);
      } else {
        transcriptEvents.push(event);
      }
    }
    if (transcriptEvents.length > 0) {
      dispatch({ type: "events", events: coalesceStreamEvents(transcriptEvents) });
    }
    if (sideEffects.length > 0) {
      setExtensionPanels((previous) => applySideEffects(previous, sideEffects));
    }
  }, []);

  const receiveEvent = useCallback((event: SessionEvent) => {
    queuedEvents.current.push(event);
    if (requestFrame.current === undefined) requestFrame.current = requestAnimationFrame(flushEvents);
  }, [flushEvents]);

  useEffect(() => {
    queuedEvents.current = [];
    if (requestFrame.current !== undefined) {
      cancelAnimationFrame(requestFrame.current);
      requestFrame.current = undefined;
    }
    if (ref === undefined) {
      dispatch({ type: "reset" });
      return;
    }
    dispatch({ type: "reset" });
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let attempt = 0;
    let hydrated = false;
    let buffered: SessionEvent[] = [];

    const connect = () => {
      if (disposed) return;
      dispatch({ type: "connection", value: attempt === 0 ? "connecting" : "reconnecting" });
      const connection = new WebSocket(socketUrl(`${sessionPath(ref)}/events`));
      socket = connection;
      connection.addEventListener("message", (message) => {
        if (disposed) return;
        try {
          const parsed = sessionEventSchema.safeParse(JSON.parse(String(message.data)));
          if (!parsed.success) return;
          if (!hydrated) buffered.push(parsed.data);
          else receiveEvent(parsed.data);
        } catch {
          // Invalid socket frames do not affect the established transcript.
        }
      });
      connection.addEventListener("open", () => {
        void Promise.all([api.timeline(ref), api.runtime(ref)]).then(([page, snapshot]) => {
          if (disposed || socket !== connection) return;
          dispatch({ type: "hydrate", page, snapshot });
          hydrated = true;
          for (const event of buffered.filter((event) => event.seq > snapshot.seq)) receiveEvent(event);
          buffered = [];
          attempt = 0;
          dispatch({ type: "connection", value: "live" });
        }).catch((error: unknown) => {
          if (disposed || socket !== connection) return;
          hydrated = false;
          buffered = [];
          dispatch({ type: "connection", value: "reconnecting", error: error instanceof Error ? error.message : "无法加载此会话" });
          connection.close();
        });
      });
      connection.addEventListener("close", () => {
        if (disposed || socket !== connection) return;
        socket = undefined;
        hydrated = false;
        buffered = [];
        attempt += 1;
        dispatch({ type: "connection", value: "reconnecting" });
        reconnectTimer = window.setTimeout(connect, Math.min(10_000, 700 * (2 ** Math.min(attempt, 4))));
      });
      connection.addEventListener("error", () => connection.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [refKey, receiveEvent]);

  useEffect(() => () => {
    if (requestFrame.current !== undefined) cancelAnimationFrame(requestFrame.current);
  }, []);

  // Keep the displayed model responsive before the matching socket frame arrives.
  const selectModel = useCallback(async (model: ModelDescriptor): Promise<void> => {
    if (ref === undefined) return;
    const selectedKey = refKey;
    const selected = await api.setModel(ref, model);
    if (refKeyRef.current === selectedKey) dispatch({ type: "model", model: selected });
  }, [refKey]);

  const setThinkingLevel = useCallback(async (level: ThinkingLevel): Promise<void> => {
    if (ref === undefined) return;
    const selectedKey = refKey;
    const thinking = await api.setThinkingLevel(ref, level);
    if (refKeyRef.current === selectedKey) dispatch({ type: "thinking", thinking });
  }, [refKey]);

  const loadEarlier = useCallback(async () => {
    if (ref === undefined || !stateRef.current.transcript.hasMore || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await api.timeline(ref, stateRef.current.transcript.start);
      dispatch({ type: "prepend", page });
    } finally {
      setLoadingEarlier(false);
    }
  }, [refKey, loadingEarlier]);

  const respondExtensionUi = useCallback(async (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> => {
    if (ref === undefined) return;
    try {
      await api.respondExtensionUi(ref, id, response);
    } catch (error) {
      // 请求已超时/关闭时服务端返回 404，卡片会收到 uiSettled 事件自行收敛。
      console.warn("extension UI respond failed", error);
    }
  }, [refKey]);

  return { ...state, loadEarlier, loadingEarlier, selectModel, setThinkingLevel, extensionPanels, respondExtensionUi };
}

function sideEffectFor(event: SessionEvent): PanelSideEffect | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const request = isRecord(payload?.["request"]) ? payload["request"] : undefined;
  if (request === undefined) return undefined;
  const method = request["method"];
  if (method === "setStatus") {
    const key = request["statusKey"];
    if (typeof key !== "string") return undefined;
    const text = request["statusText"];
    return { kind: "status", key, text: typeof text === "string" ? text : undefined };
  }
  if (method === "setWidget") {
    const key = request["widgetKey"];
    if (typeof key !== "string") return undefined;
    const lines = request["widgetLines"];
    if (lines !== undefined && (!Array.isArray(lines) || !lines.every((line) => typeof line === "string"))) return undefined;
    const placement = request["widgetPlacement"] === "belowEditor" ? "belowEditor" : "aboveEditor";
    return { kind: "widget", key, lines: lines === undefined ? undefined : lines, placement };
  }
  if (method === "setTitle") {
    const title = request["title"];
    if (typeof title !== "string") return undefined;
    return { kind: "title", title };
  }
  if (method === "set_editor_text") {
    const text = request["text"];
    if (typeof text !== "string") return undefined;
    return { kind: "editor", text };
  }
  return undefined;
}

function applySideEffects(previous: ExtensionPanelState, effects: PanelSideEffect[]): ExtensionPanelState {
  let next: ExtensionPanelState = previous;
  let title: string | undefined;
  let editor: string | undefined;
  for (const effect of effects) {
    if (effect.kind === "status") {
      const statuses = { ...next.statuses };
      if (effect.text === undefined) delete statuses[effect.key];
      else statuses[effect.key] = effect.text;
      next = { ...next, statuses };
    } else if (effect.kind === "widget") {
      const widgets = { ...next.widgets };
      if (effect.lines === undefined) delete widgets[effect.key];
      else widgets[effect.key] = { lines: effect.lines, placement: effect.placement };
      next = { ...next, widgets };
    } else if (effect.kind === "title") {
      title = effect.title;
    } else {
      editor = effect.text;
    }
  }
  if (title !== undefined) document.title = title;
  if (editor !== undefined) next = { ...next, editorText: { text: editor, nonce: (next.editorText?.nonce ?? 0) + 1 } };
  return next;
}

function coalesceStreamEvents(events: SessionEvent[]): SessionEvent[] {
  const result: SessionEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    const previousPayload = previous?.type === "assistant.delta" && isRecord(previous.payload) ? previous.payload : undefined;
    const payload = event.type === "assistant.delta" && isRecord(event.payload) ? event.payload : undefined;
    const sameMessage = previousPayload?.["messageId"] === payload?.["messageId"];
    if (previous !== undefined && previous.type === "assistant.delta" && event.type === "assistant.delta" && sameMessage && typeof previousPayload?.["delta"] === "string" && typeof payload?.["delta"] === "string") {
      result[result.length - 1] = { ...event, payload: { messageId: payload["messageId"], delta: previousPayload["delta"] + payload["delta"] } };
      continue;
    }
    const previousBash = previous?.type === "bash.delta" && isRecord(previous.payload) ? previous.payload : undefined;
    const bashPayload = event.type === "bash.delta" && isRecord(event.payload) ? event.payload : undefined;
    if (previous !== undefined && previous.type === "bash.delta" && event.type === "bash.delta" && previous.runId === event.runId && typeof previousBash?.["delta"] === "string" && typeof bashPayload?.["delta"] === "string") {
      result[result.length - 1] = { ...event, payload: { delta: previousBash["delta"] + bashPayload["delta"] } };
      continue;
    }
    result.push(event);
  }
  return result;
}
