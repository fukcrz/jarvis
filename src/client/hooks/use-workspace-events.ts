import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { workspaceEventSchema } from "../../shared/protocol";
import { notifyUnauthorized, socketUrl } from "../api";
import type { SessionContextMenuTarget } from "../components/session-context-menu";
import { mergeExtensionToast, type ExtensionToast, type ExtensionToastInput } from "../extension-notifications";
import {
  mergeSession,
  parseSocketHeartbeat,
  sessionKey,
  touchViewedIdleKeys,
  shouldReconnectVisibleSocket,
  socketHeartbeatMessage,
  withoutDraft,
  withoutSession,
  SOCKET_CLIENT_PING_INTERVAL_MS,
  SOCKET_PING_TYPE,
  SOCKET_PONG_TYPE,
  SOCKET_WATCHDOG_INTERVAL_MS,
} from "../lib/socket-sync";

export function useWorkspaceEvents(input: {
  workspaces: Workspace[];
  deletedSessionsRef: MutableRefObject<Record<string, Set<string>>>;
  viewedIdleKeysRef: MutableRefObject<Set<string>>;
  setSessionsByWorkspace: Dispatch<SetStateAction<Record<string, SessionSummary[]>>>;
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setSessionMenu: Dispatch<SetStateAction<SessionContextMenuTarget | undefined>>;
  setGlobalExtensionToasts: Dispatch<SetStateAction<ExtensionToast[]>>;
  onSocketReconnect?: (workspaceId: string) => void;
}): void {
  const { workspaces, deletedSessionsRef, viewedIdleKeysRef, setSessionsByWorkspace, setDrafts, setSessionMenu, setGlobalExtensionToasts, onSocketReconnect } = input;

  useEffect(() => {
    let disposed = false;
    const cleanups = workspaces.map((workspace) => {
      let socket: WebSocket | undefined;
      let reconnect: number | undefined;
      let pingTimer: number | undefined;
      let lastEventAt = Date.now();
      let lastReconnectAt = 0;
      let hasOpened = false;
      const stopReconnectAndPing = () => {
        if (reconnect !== undefined) {
          window.clearTimeout(reconnect);
          reconnect = undefined;
        }
        if (pingTimer !== undefined) {
          window.clearInterval(pingTimer);
          pingTimer = undefined;
        }
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
      const connect = () => {
        if (disposed) return;
        stopReconnectAndPing();
        lastReconnectAt = Date.now();
        const connection = new WebSocket(socketUrl(`/api/workspaces/${workspace.id}/events`));
        replaceSocket(connection);
        connection.addEventListener("open", () => {
          if (disposed || socket !== connection) return;
          lastEventAt = Date.now();
          startKeepalive(connection);
          const resync = hasOpened;
          hasOpened = true;
          if (resync) onSocketReconnect?.(workspace.id);
        });
        connection.addEventListener("message", (event) => {
          if (disposed || socket !== connection) return;
          try {
            const parsed: unknown = JSON.parse(String(event.data));
            const heartbeat = parseSocketHeartbeat(parsed);
            if (heartbeat !== undefined) {
              lastEventAt = Date.now();
              if (heartbeat.type === SOCKET_PING_TYPE && connection.readyState === WebSocket.OPEN) {
                try {
                  connection.send(socketHeartbeatMessage(SOCKET_PONG_TYPE));
                } catch {
                  connection.close();
                }
              }
              return;
            }
            const parsedEvent = workspaceEventSchema.safeParse(parsed);
            if (!parsedEvent.success) return;
            lastEventAt = Date.now();
            const workspaceEvent = parsedEvent.data;
            if (workspaceEvent.type === "extension.notify") {
              const { notification } = workspaceEvent;
              const tone: "info" | "warning" | "error" = notification.notifyType === "warning" || notification.notifyType === "error" ? notification.notifyType : "info";
              const incoming: ExtensionToastInput = { id: notification.id, workspaceId: workspaceEvent.workspaceId, sessionId: notification.sessionId, message: notification.message, tone };
              setGlobalExtensionToasts((current) => {
                const merged = mergeExtensionToast(current[0], incoming);
                return merged === current[0] ? current : [merged];
              });
              return;
            }
            if (workspaceEvent.type === "session.deleted") {
              (deletedSessionsRef.current[workspace.id] ??= new Set()).add(workspaceEvent.sessionId);
              viewedIdleKeysRef.current.delete(sessionKey(workspace.id, workspaceEvent.sessionId));
              setSessionsByWorkspace((current) => {
                const sessions = current[workspace.id] ?? [];
                const next = withoutSession(sessions, workspaceEvent.sessionId);
                return next === sessions ? current : { ...current, [workspace.id]: next };
              });
              setDrafts((current) => withoutDraft(current, workspaceEvent.sessionId));
              setSessionMenu((current) => current?.workspaceId === workspace.id && current.session.id === workspaceEvent.sessionId ? undefined : current);
              return;
            }
            touchViewedIdleKeys(viewedIdleKeysRef.current, workspaceEvent.session);
            setSessionsByWorkspace((current) => ({ ...current, [workspace.id]: mergeSession(current[workspace.id] ?? [], workspaceEvent.session, viewedIdleKeysRef.current) }));
          } catch {
            // A malformed workspace event does not invalidate the active view.
          }
        });
        connection.addEventListener("close", (event) => {
          if (disposed || socket !== connection) return;
          replaceSocket(undefined);
          if (pingTimer !== undefined) {
            window.clearInterval(pingTimer);
            pingTimer = undefined;
          }
          if (event.code === 4401) {
            notifyUnauthorized();
            return;
          }
          reconnect = window.setTimeout(connect, 1_500);
        });
        connection.addEventListener("error", () => connection.close());
      };
      const reconnectNow = () => {
        if (disposed) return;
        connect();
      };
      const resync = () => {
        if (disposed) return;
        if (shouldReconnectVisibleSocket({
          visible: document.visibilityState === "visible",
          online: navigator.onLine,
          readyState: socket?.readyState ?? WebSocket.CLOSED,
          lastEventAt,
          now: Date.now(),
          lastReconnectAt,
        })) reconnectNow();
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
        stopReconnectAndPing();
        window.clearInterval(watchdogTimer);
        socket?.close();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("pageshow", onPageShow);
      };
    });
    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [workspaces, deletedSessionsRef, viewedIdleKeysRef, setSessionsByWorkspace, setDrafts, setSessionMenu, setGlobalExtensionToasts, onSocketReconnect]);
}
