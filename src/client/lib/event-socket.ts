import { notifyUnauthorized } from "../api";
import {
  parseSocketHeartbeat,
  shouldReconnectVisibleSocket,
  socketHeartbeatMessage,
  SOCKET_CLIENT_PING_INTERVAL_MS,
  SOCKET_PING_TYPE,
  SOCKET_PONG_TYPE,
  SOCKET_WATCHDOG_INTERVAL_MS,
} from "./socket-sync";

/** 全局/工作区事件共用心跳、恢复与认证失效处理。 */
export function subscribeEventSocket(url: string, input: {
  onMessage: (value: unknown) => void;
  onResync: () => void;
}): () => void {
  let disposed = false;
  let unauthorized = false;
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let pingTimer: number | undefined;
  let lastEventAt = Date.now();
  let lastReconnectAt = 0;

  const stopTimers = () => {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    if (pingTimer !== undefined) window.clearInterval(pingTimer);
    reconnectTimer = undefined;
    pingTimer = undefined;
  };
  const replaceSocket = (next: WebSocket | undefined) => {
    const previous = socket;
    socket = next;
    if (previous === undefined || previous === next) return;
    try { previous.close(); } catch { /* A connecting socket can already be closing. */ }
  };
  const connect = () => {
    if (disposed || unauthorized) return;
    stopTimers();
    lastReconnectAt = Date.now();
    const connection = new WebSocket(url);
    replaceSocket(connection);
    connection.addEventListener("open", () => {
      if (disposed || socket !== connection) return;
      lastEventAt = Date.now();
      pingTimer = window.setInterval(() => {
        if (disposed || socket !== connection || connection.readyState !== WebSocket.OPEN || document.hidden) return;
        try { connection.send(socketHeartbeatMessage(SOCKET_PING_TYPE)); } catch { connection.close(); }
      }, SOCKET_CLIENT_PING_INTERVAL_MS);
      // 首次连接也重新取快照，补齐 HTTP 读取与订阅建立之间的事件窗口。
      input.onResync();
    });
    connection.addEventListener("message", (event) => {
      if (disposed || socket !== connection) return;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        lastEventAt = Date.now();
        const heartbeat = parseSocketHeartbeat(parsed);
        if (heartbeat !== undefined) {
          if (heartbeat.type === SOCKET_PING_TYPE && connection.readyState === WebSocket.OPEN) {
            try { connection.send(socketHeartbeatMessage(SOCKET_PONG_TYPE)); } catch { connection.close(); }
          }
          return;
        }
        input.onMessage(parsed);
      } catch {
        // A malformed frame does not invalidate the current view.
      }
    });
    connection.addEventListener("close", (event) => {
      if (disposed || socket !== connection) return;
      replaceSocket(undefined);
      stopTimers();
      if (event.code === 4401) {
        unauthorized = true;
        notifyUnauthorized();
        return;
      }
      reconnectTimer = window.setTimeout(connect, 1_500);
    });
    connection.addEventListener("error", () => {
      if (!disposed && socket === connection) connection.close();
    });
  };
  const needsReconnect = () => shouldReconnectVisibleSocket({
    visible: document.visibilityState === "visible",
    online: navigator.onLine,
    readyState: socket?.readyState ?? WebSocket.CLOSED,
    lastEventAt,
    now: Date.now(),
    lastReconnectAt,
  });
  const resync = () => {
    if (disposed || unauthorized || document.hidden || !navigator.onLine) return;
    // 浏览器回到前台时即使 socket 仍显示 OPEN，也可能漏过事件。
    input.onResync();
    if (needsReconnect()) connect();
  };
  connect();
  const watchdogTimer = window.setInterval(() => {
    if (!disposed && !unauthorized && needsReconnect()) connect();
  }, SOCKET_WATCHDOG_INTERVAL_MS);
  const onVisible = () => { if (!document.hidden) resync(); };
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) resync(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", resync);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    disposed = true;
    stopTimers();
    window.clearInterval(watchdogTimer);
    replaceSocket(undefined);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", resync);
    window.removeEventListener("pageshow", onPageShow);
  };
}
