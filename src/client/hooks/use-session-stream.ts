import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, notifyUnauthorized, sessionPath, socketUrl } from "../api";
import { isRecord, type ExtensionUiSnapshot, type ModelDescriptor, type SessionEvent, type SessionRef, type SessionThinkingSnapshot, type ThinkingLevel, type TimelineItem, sessionEventSchema } from "../../shared/protocol";
import { notifyRunFinished, type RunNotificationInfo } from "../notifications";
import {
  coalesceStreamEvents,
  parseSocketHeartbeat,
  shouldFlushStreamEventImmediately,
  shouldReconnectVisibleSocket,
  socketHeartbeatMessage,
  SOCKET_CLIENT_PING_INTERVAL_MS,
  SOCKET_PING_TYPE,
  SOCKET_PONG_TYPE,
  SOCKET_WATCHDOG_INTERVAL_MS,
} from "../lib/socket-sync";
import { addOptimisticUserMessage, applySessionEvents, emptyTranscript, hydrateTranscript, prependTranscript, removeOptimisticUserMessage, replaceUserMessageWithOptimistic, type TranscriptState } from "../transcript";

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
  | { type: "optimistic-user"; id: string; text: string; images: import("../../shared/protocol").ImageAttachment[] }
  | { type: "discard-optimistic-user"; id: string }
  | { type: "replace-user"; messageId: string; id: string; text: string; images: import("../../shared/protocol").ImageAttachment[] }
  | { type: "connection"; value: StreamState["connection"]; error?: string };

const initialState: StreamState = { transcript: emptyTranscript, connection: "offline" };

function reducer(state: StreamState, action: Action): StreamState {
  if (action.type === "reset") return initialState;
  if (action.type === "hydrate") return { ...state, transcript: hydrateTranscript(state.transcript, action.page, action.snapshot), error: undefined };
  if (action.type === "events") return { ...state, transcript: applySessionEvents(state.transcript, action.events) };
  if (action.type === "model") return { ...state, transcript: { ...state.transcript, model: { ...state.transcript.model, current: action.model } } };
  if (action.type === "thinking") return { ...state, transcript: { ...state.transcript, thinking: action.thinking } };
  if (action.type === "prepend") return { ...state, transcript: prependTranscript(state.transcript, action.page) };
  if (action.type === "optimistic-user") return { ...state, transcript: addOptimisticUserMessage(state.transcript, action.id, action.text, action.images) };
  if (action.type === "discard-optimistic-user") return { ...state, transcript: removeOptimisticUserMessage(state.transcript, action.id) };
  if (action.type === "replace-user") return { ...state, transcript: replaceUserMessageWithOptimistic(state.transcript, action.messageId, action.id, action.text, action.images) };
  return { ...state, connection: action.value, ...(action.error === undefined ? {} : { error: action.error }) };
}

type PanelSideEffect =
  | { kind: "status"; key: string; text: string | undefined }
  | { kind: "widget"; key: string; lines: string[] | undefined; placement: "aboveEditor" | "belowEditor" }
  | { kind: "title"; title: string }
  | { kind: "editor"; text: string };

export function useSessionStream(ref: SessionRef | undefined, assistantName = document.title, sessionName?: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [extensionPanels, setExtensionPanels] = useState<ExtensionPanelState>({ widgets: {}, statuses: {} });
  const stateRef = useRef(state);
  const sessionNameRef = useRef(sessionName);
  const refKey = ref === undefined ? undefined : `${ref.workspaceId}:${ref.sessionId}`;
  const refKeyRef = useRef(refKey);
  const requestFrame = useRef<number | undefined>(undefined);
  const flushTimeout = useRef<number | undefined>(undefined);
  const queuedEvents = useRef<SessionEvent[]>([]);
  const defaultDocumentTitle = useRef(assistantName);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { sessionNameRef.current = sessionName; }, [sessionName]);
  useEffect(() => {
    const previous = defaultDocumentTitle.current;
    defaultDocumentTitle.current = assistantName;
    if (ref === undefined || document.title === previous) document.title = assistantName;
  }, [assistantName, refKey]);
  useEffect(() => { refKeyRef.current = refKey; }, [refKey]);

  const cancelScheduledFlush = useCallback(() => {
    if (requestFrame.current !== undefined) {
      cancelAnimationFrame(requestFrame.current);
      requestFrame.current = undefined;
    }
    if (flushTimeout.current !== undefined) {
      window.clearTimeout(flushTimeout.current);
      flushTimeout.current = undefined;
    }
  }, []);

  const flushEvents = useCallback(() => {
    cancelScheduledFlush();
    const events = queuedEvents.current.splice(0);
    const transcriptEvents: SessionEvent[] = [];
    const sideEffects: PanelSideEffect[] = [];
    const historyRewritten = events.some((event) => event.type === "session.rewritten");
    for (const event of events) {
      if (event.type === "extension.uiRequest") {
        const effect = sideEffectFor(event);
        if (effect !== undefined) sideEffects.push(effect);
        // Stateful panels are ambient; interactions and notifications belong to the session timeline.
        if (effect === undefined) transcriptEvents.push(event);
      } else {
        transcriptEvents.push(event);
      }
    }
    if (transcriptEvents.length > 0) {
      dispatch({ type: "events", events: coalesceStreamEvents(transcriptEvents) });
    }
    // 会话 run 结束（完成/失败）：页面在后台时弹浏览器通知。
    // 同步冲刷时 React 的 stateRef 尚未更新（useEffect 异步），通知正文需基于
    // “当前 transcript 应用本批事件后”的结果计算，否则会漏掉刚完成的最后一条助手消息。
    const settledEvents = events.filter((event) => event.type === "run.settled" || event.type === "run.failed");
    if (settledEvents.length > 0) {
      const items = applySessionEvents(stateRef.current.transcript, coalesceStreamEvents(transcriptEvents)).items;
      for (const event of settledEvents) {
        const notification = runNotificationFor(event, items);
        if (notification !== undefined) {
          notifyRunFinished({ ...notification, sessionName: sessionNameRef.current });
        }
      }
    }
    if (historyRewritten || sideEffects.length > 0) {
      setExtensionPanels((previous) => applySideEffects(historyRewritten ? { widgets: {}, statuses: {} } : previous, sideEffects));
      if (historyRewritten) document.title = defaultDocumentTitle.current;
    }
  }, [cancelScheduledFlush]);

  const receiveEvent = useCallback((event: SessionEvent) => {
    queuedEvents.current.push(event);
    // 后台标签页会暂停 rAF：所有事件必须立刻冲刷，否则切回前台才看到过期流。
    // 前台仍用 rAF 合并 delta；结算事件同步冲刷，保证后台通知不丢。
    if (shouldFlushStreamEventImmediately(document.hidden, event.type)) {
      flushEvents();
      return;
    }
    if (requestFrame.current === undefined) requestFrame.current = requestAnimationFrame(flushEvents);
    if (flushTimeout.current === undefined) flushTimeout.current = window.setTimeout(flushEvents, 80);
  }, [flushEvents]);

  const refresh = useCallback(async () => {
    if (ref === undefined) return;
    const selectedKey = refKey;
    const [page, snapshot] = await Promise.all([api.timeline(ref), api.runtime(ref)]);
    if (refKeyRef.current !== selectedKey) return;
    dispatch({ type: "hydrate", page, snapshot });
    setExtensionPanels(extensionPanelsFromSnapshot(snapshot.extensionUi));
    document.title = snapshot.extensionUi?.title ?? defaultDocumentTitle.current;
  }, [refKey]);

  useEffect(() => {
    queuedEvents.current = [];
    cancelScheduledFlush();
    if (ref === undefined) {
      dispatch({ type: "reset" });
      setExtensionPanels({ widgets: {}, statuses: {} });
      document.title = defaultDocumentTitle.current;
      return;
    }
    dispatch({ type: "reset" });
    setExtensionPanels({ widgets: {}, statuses: {} });
    document.title = defaultDocumentTitle.current;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;
    let attempt = 0;
    let hydrated = false;
    let buffered: SessionEvent[] = [];
    let lastEventAt = Date.now();
    let lastReconnectAt = 0;

    const stopReconnectAndPing = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (pingTimer !== undefined) {
        window.clearInterval(pingTimer);
        pingTimer = undefined;
      }
    };

    const markAlive = () => {
      lastEventAt = Date.now();
    };

    const startKeepalive = (connection: WebSocket) => {
      if (pingTimer !== undefined) window.clearInterval(pingTimer);
      pingTimer = window.setInterval(() => {
        if (disposed || socket !== connection || connection.readyState !== WebSocket.OPEN || document.hidden) return;
        try {
          connection.send(socketHeartbeatMessage(SOCKET_PING_TYPE));
        } catch {
          connection.close();
        }
      }, SOCKET_CLIENT_PING_INTERVAL_MS);
    };

    const replaceSocket = (next: WebSocket | undefined) => {
      const previous = socket;
      socket = next;
      if (previous !== undefined && previous !== next) {
        try {
          previous.close();
        } catch {
          // CONNECTING 状态下 close 会抛 InvalidStateError，直接弃用旧连接。
        }
      }
    };

    const connect = () => {
      if (disposed) return;
      stopReconnectAndPing();
      lastReconnectAt = Date.now();
      dispatch({ type: "connection", value: attempt === 0 ? "connecting" : "reconnecting" });
      const connection = new WebSocket(socketUrl(`${sessionPath(ref)}/events`));
      replaceSocket(connection);
      connection.addEventListener("message", (message) => {
        if (disposed || socket !== connection) return;
        try {
          const parsed: unknown = JSON.parse(String(message.data));
          const heartbeat = parseSocketHeartbeat(parsed);
          if (heartbeat !== undefined) {
            markAlive();
            if (heartbeat.type === SOCKET_PING_TYPE && connection.readyState === WebSocket.OPEN) {
              try {
                connection.send(socketHeartbeatMessage(SOCKET_PONG_TYPE));
              } catch {
                connection.close();
              }
            }
            return;
          }
          const event = sessionEventSchema.safeParse(parsed);
          if (!event.success) return;
          markAlive();
          if (!hydrated) buffered.push(event.data);
          else receiveEvent(event.data);
        } catch {
          // Invalid socket frames do not affect the established transcript.
        }
      });
      connection.addEventListener("open", () => {
        if (disposed || socket !== connection) return;
        markAlive();
        startKeepalive(connection);
        void Promise.all([api.timeline(ref), api.runtime(ref)]).then(([page, snapshot]) => {
          if (disposed || socket !== connection) return;
          dispatch({ type: "hydrate", page, snapshot });
          setExtensionPanels(extensionPanelsFromSnapshot(snapshot.extensionUi));
          document.title = snapshot.extensionUi?.title ?? defaultDocumentTitle.current;
          hydrated = true;
          // Most buffered events are covered by the authoritative snapshot.
          for (const event of buffered.filter((bufferedEvent) => bufferedEvent.seq > snapshot.seq)) receiveEvent(event);
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
      connection.addEventListener("close", (event) => {
        if (disposed || socket !== connection) return;
        replaceSocket(undefined);
        hydrated = false;
        buffered = [];
        if (pingTimer !== undefined) {
          window.clearInterval(pingTimer);
          pingTimer = undefined;
        }
        // 4401：服务端因未登录关闭握手，不再重连，交由 AuthGate 回到登录页。
        if (event.code === 4401) {
          notifyUnauthorized();
          return;
        }
        attempt += 1;
        dispatch({ type: "connection", value: "reconnecting" });
        reconnectTimer = window.setTimeout(connect, Math.min(10_000, 700 * (2 ** Math.min(attempt, 4))));
      });
      connection.addEventListener("error", () => connection.close());
    };

    const reconnectNow = () => {
      if (disposed) return;
      hydrated = false;
      buffered = [];
      attempt = 0;
      connect();
    };

    const resync = () => {
      if (disposed) return;
      const readyState = socket?.readyState ?? WebSocket.CLOSED;
      if (shouldReconnectVisibleSocket({
        visible: document.visibilityState === "visible",
        online: navigator.onLine,
        readyState,
        lastEventAt,
        now: Date.now(),
        lastReconnectAt,
      })) {
        reconnectNow();
        return;
      }
      if (readyState === WebSocket.OPEN) void refresh();
    };

    connect();
    const watchdogTimer = window.setInterval(() => {
      if (disposed || document.hidden) return;
      if (shouldReconnectVisibleSocket({
        visible: true,
        online: navigator.onLine,
        readyState: socket?.readyState ?? WebSocket.CLOSED,
        lastEventAt,
        now: Date.now(),
        lastReconnectAt,
      })) reconnectNow();
    }, SOCKET_WATCHDOG_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (queuedEvents.current.length > 0) flushEvents();
      if (document.visibilityState === "visible") resync();
    };
    const onOnline = () => { resync(); };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resync();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      disposed = true;
      stopReconnectAndPing();
      window.clearInterval(watchdogTimer);
      socket?.close();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [refKey, receiveEvent, refresh, flushEvents, cancelScheduledFlush]);

  useEffect(() => () => {
    cancelScheduledFlush();
  }, [cancelScheduledFlush]);

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
    if (ref === undefined) throw new Error("会话已关闭");
    try {
      await api.respondExtensionUi(ref, id, response);
    } catch (error) {
      console.warn("extension UI respond failed", error);
      throw error;
    }
  }, [refKey]);

  const addOptimisticUser = useCallback((id: string, text: string, images: import("../../shared/protocol").ImageAttachment[]) => {
    dispatch({ type: "optimistic-user", id, text, images });
  }, []);
  const discardOptimisticUser = useCallback((id: string) => { dispatch({ type: "discard-optimistic-user", id }); }, []);
  const replaceUserMessage = useCallback((messageId: string, id: string, text: string, images: import("../../shared/protocol").ImageAttachment[]) => { dispatch({ type: "replace-user", messageId, id, text, images }); }, []);
  return { ...state, refresh, loadEarlier, loadingEarlier, selectModel, setThinkingLevel, extensionPanels, respondExtensionUi, addOptimisticUser, discardOptimisticUser, replaceUserMessage };
}

function runNotificationFor(event: SessionEvent, items: TimelineItem[]): RunNotificationInfo | undefined {
  if (event.runId === undefined || (event.type !== "run.settled" && event.type !== "run.failed")) return undefined;
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const status = isRecord(payload?.["status"]) ? payload["status"] : undefined;
  const lastError = isRecord(status?.["lastError"]) ? status["lastError"] : undefined;
  return {
    runId: event.runId,
    failed: event.type === "run.failed",
    text: lastAssistantText(items),
    ...(typeof lastError?.["message"] === "string" ? { errorMessage: lastError["message"] } : {}),
  };
}

function lastAssistantText(items: TimelineItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "message" && item.role === "assistant") return item.text;
  }
  return "";
}

function extensionPanelsFromSnapshot(snapshot: ExtensionUiSnapshot | undefined): ExtensionPanelState {
  if (snapshot === undefined) return { widgets: {}, statuses: {} };
  return {
    statuses: { ...snapshot.statuses },
    widgets: Object.fromEntries(Object.entries(snapshot.widgets).map(([key, widget]) => [key, { lines: [...widget.lines], placement: widget.placement }])),
    ...(snapshot.editorText === undefined ? {} : { editorText: { text: snapshot.editorText.text, nonce: snapshot.editorText.revision } }),
  };
}

function sideEffectFor(event: SessionEvent): PanelSideEffect | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const request = isRecord(payload?.["request"]) ? payload["request"] : undefined;
  if (request === undefined) return undefined;
  const method = request["method"];
  if (method === "notify") return undefined;
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
    } else if (effect.kind === "editor") {
      editor = effect.text;
    }
  }
  if (title !== undefined) document.title = title;
  if (editor !== undefined) next = { ...next, editorText: { text: editor, nonce: (next.editorText?.nonce ?? 0) + 1 } };
  return next;
}

