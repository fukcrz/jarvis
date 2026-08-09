import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, sessionPath, socketUrl } from "../api";
import { isRecord, type ModelDescriptor, type SessionEvent, type SessionRef, sessionEventSchema } from "../../shared/protocol";
import { applySessionEvents, emptyTranscript, hydrateTranscript, prependTranscript, type TranscriptState } from "../transcript";

interface StreamState {
  transcript: TranscriptState;
  connection: "connecting" | "live" | "reconnecting" | "offline";
  error?: string;
}

type Action =
  | { type: "reset" }
  | { type: "hydrate"; page: Awaited<ReturnType<typeof api.timeline>>; snapshot: Awaited<ReturnType<typeof api.runtime>> }
  | { type: "events"; events: SessionEvent[] }
  | { type: "model"; model: ModelDescriptor }
  | { type: "prepend"; page: Awaited<ReturnType<typeof api.timeline>> }
  | { type: "connection"; value: StreamState["connection"]; error?: string };

const initialState: StreamState = { transcript: emptyTranscript, connection: "offline" };

function reducer(state: StreamState, action: Action): StreamState {
  if (action.type === "reset") return initialState;
  if (action.type === "hydrate") return { ...state, transcript: hydrateTranscript(state.transcript, action.page, action.snapshot), error: undefined };
  if (action.type === "events") return { ...state, transcript: applySessionEvents(state.transcript, action.events) };
  if (action.type === "model") return { ...state, transcript: { ...state.transcript, model: { ...state.transcript.model, current: action.model } } };
  if (action.type === "prepend") return { ...state, transcript: prependTranscript(state.transcript, action.page) };
  return { ...state, connection: action.value, ...(action.error === undefined ? {} : { error: action.error }) };
}

export function useSessionStream(ref: SessionRef | undefined) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const stateRef = useRef(state);
  const refKey = ref === undefined ? undefined : `${ref.workspaceId}:${ref.sessionId}`;
  const refKeyRef = useRef(refKey);
  const requestFrame = useRef<number | undefined>(undefined);
  const queuedEvents = useRef<SessionEvent[]>([]);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { refKeyRef.current = refKey; }, [refKey]);

  const flushEvents = useCallback(() => {
    requestFrame.current = undefined;
    const events = coalesceStreamEvents(queuedEvents.current.splice(0));
    if (events.length > 0) dispatch({ type: "events", events });
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
          dispatch({ type: "connection", value: "reconnecting", error: error instanceof Error ? error.message : "Unable to load this session" });
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

  return { ...state, loadEarlier, loadingEarlier, selectModel };
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
    } else {
      result.push(event);
    }
  }
  return result;
}
