import type { SessionEvent, SessionRef, WorkspaceEvent } from "../shared/protocol.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";

interface SocketLike {
  readyState: number;
  send(payload: string): void;
  terminate?: () => void;
  ping?: () => void;
  on(event: "close" | "pong", listener: () => void): unknown;
}

export class EventHub {
  private readonly sessionSockets = new Map<string, Set<SocketLike>>();
  private readonly workspaceSockets = new Map<string, Set<SocketLike>>();
  private readonly seqBySession = new Map<string, number>();
  /** 上一轮心跳 ping 后尚未收到 pong 的连接；下一轮仍无回应则断开。 */
  private readonly pendingPong = new WeakSet<SocketLike>();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(heartbeatMs = 30_000) {
    // 移动端浏览器切后台后连接常被系统静默掐断且不再触发 close（半开连接）。
    // 心跳让服务端主动发现死连接并断开，客户端收到 close 后自动重连。
    // 浏览器对服务端 ping 的 pong 应答由协议层自动发出，无需客户端配合。
    this.heartbeatTimer = setInterval(() => this.sweep(), heartbeatMs);
    // 不阻止进程退出（自重启等场景）。
    this.heartbeatTimer.unref?.();
  }

  addSession(ref: SessionRef, socket: SocketLike): void {
    this.add(this.sessionSockets, sessionKey(ref), socket);
  }

  addWorkspace(workspaceId: string, socket: SocketLike): void {
    this.add(this.workspaceSockets, workspaceId, socket);
  }

  currentSeq(ref: SessionRef): number {
    return this.seqBySession.get(sessionKey(ref)) ?? 0;
  }

  publishSession(ref: SessionRef, event: Omit<SessionEvent, "version" | "sessionId" | "seq" | "emittedAt">): SessionEvent {
    const key = sessionKey(ref);
    const seq = (this.seqBySession.get(key) ?? 0) + 1;
    this.seqBySession.set(key, seq);
    const envelope: SessionEvent = {
      version: 1,
      sessionId: ref.sessionId,
      seq,
      emittedAt: new Date().toISOString(),
      ...event,
    };
    this.send(this.sessionSockets.get(key), envelope);
    return envelope;
  }

  publishWorkspace(workspaceId: string, event: WorkspaceEvent): void {
    this.send(this.workspaceSockets.get(workspaceId), event);
  }

  /** 向所有工作区连接广播同一通知（用于重启等全局状态）。 */
  broadcastWorkspace(event: { version: typeof PROTOCOL_VERSION; type: "extension.notify"; notification: { id: string; message: string; notifyType?: "info" | "warning" | "error"; sessionId?: string } }): void {
    for (const workspaceId of this.workspaceSockets.keys()) {
      this.send(this.workspaceSockets.get(workspaceId), { ...event, workspaceId });
    }
  }

  /** 断开全部连接（优雅停机/自重启前调用，避免 ws 阻止 Fastify close）。 */
  terminateAll(): void {
    this.stopHeartbeat();
    for (const sockets of [...this.sessionSockets.values(), ...this.workspaceSockets.values()]) {
      for (const socket of sockets) {
        try {
          socket.terminate?.();
        } catch {
          // 断开失败不影响其余 socket。
        }
      }
    }
    this.sessionSockets.clear();
    this.workspaceSockets.clear();
  }

  private add(collection: Map<string, Set<SocketLike>>, key: string, socket: SocketLike): void {
    const sockets = collection.get(key) ?? new Set<SocketLike>();
    collection.set(key, sockets);
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) collection.delete(key);
    });
    socket.on("pong", () => {
      this.pendingPong.delete(socket);
    });
  }

  /** 心跳巡检：对无 pong 回应的连接调用 terminate，触发客户端 close → 自动重连。 */
  private sweep(): void {
    for (const sockets of [...this.sessionSockets.values(), ...this.workspaceSockets.values()]) {
      for (const socket of sockets) {
        if (this.pendingPong.has(socket)) {
          // 上一轮 ping 无回应：判定为死连接，主动断开。
          this.pendingPong.delete(socket);
          try {
            socket.terminate?.();
          } catch {
            // 断开失败不影响其余 socket。
          }
          continue;
        }
        this.pendingPong.add(socket);
        try {
          socket.ping?.();
        } catch {
          // ping 失败视同无回应，下一轮 sweep 会断开该连接。
        }
      }
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private send(sockets: Set<SocketLike> | undefined, value: SessionEvent | WorkspaceEvent): void {
    if (sockets === undefined) return;
    const payload = JSON.stringify(value);
    for (const socket of sockets) {
      if (socket.readyState !== 1) continue;
      try {
        socket.send(payload);
      } catch {
        sockets.delete(socket);
        try {
          socket.terminate?.();
        } catch {
          // The set removal above is authoritative.
        }
      }
    }
  }
}

function sessionKey(ref: SessionRef): string {
  return `${ref.workspaceId}:${ref.sessionId}`;
}
