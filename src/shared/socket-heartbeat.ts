import { isRecord, PROTOCOL_VERSION } from "./protocol.js";

export const SOCKET_PING_TYPE = "socket.ping" as const;
export const SOCKET_PONG_TYPE = "socket.pong" as const;
/** 服务端巡检间隔；两轮无 pong 才断开。 */
export const SOCKET_HEARTBEAT_INTERVAL_MS = 15_000;

export type SocketHeartbeat = {
  version: typeof PROTOCOL_VERSION;
  type: typeof SOCKET_PING_TYPE | typeof SOCKET_PONG_TYPE;
};

export function socketHeartbeatMessage(type: SocketHeartbeat["type"]): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, type });
}

export function parseSocketHeartbeat(value: unknown): SocketHeartbeat | undefined {
  if (!isRecord(value) || value["version"] !== PROTOCOL_VERSION) return undefined;
  if (value["type"] !== SOCKET_PING_TYPE && value["type"] !== SOCKET_PONG_TYPE) return undefined;
  return { version: PROTOCOL_VERSION, type: value["type"] };
}
