import { describe, expect, it, vi } from "vitest";
import type { SessionRef } from "../shared/protocol.js";
import { parseSocketHeartbeat, SOCKET_HEARTBEAT_INTERVAL_MS, SOCKET_PING_TYPE, SOCKET_PONG_TYPE, socketHeartbeatMessage } from "../shared/socket-heartbeat.js";
import { EventHub } from "./event-hub.js";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  terminated = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  /** false 时协议层 ping 不回 pong。 */
  respondToProtocolPing = true;
  /** false 时应用层 ping 不回 pong。 */
  respondToAppPing = true;
  private readonly closeListeners = new Set<() => void>();
  private readonly pongListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(raw?: unknown) => void>();

  send(payload: string): void {
    this.sent.push(payload);
    const heartbeat = parseSocketHeartbeat(JSON.parse(payload) as unknown);
    if (heartbeat?.type === SOCKET_PING_TYPE && this.respondToAppPing) {
      for (const listener of this.messageListeners) listener(JSON.stringify({ version: 1, type: SOCKET_PONG_TYPE }));
    }
  }

  on(event: "close" | "pong" | "message", listener: ((raw?: unknown) => void) | (() => void)): void {
    if (event === "close") this.closeListeners.add(listener as () => void);
    else if (event === "pong") this.pongListeners.add(listener as () => void);
    else this.messageListeners.add(listener);
  }

  receive(raw: string): void {
    for (const listener of this.messageListeners) listener(raw);
  }

  ping(): void {
    if (this.respondToProtocolPing) for (const listener of this.pongListeners) listener();
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }
}

describe("EventHub", () => {
  it("uses session-local monotonic sequences and removes closed subscribers", () => {
    const hub = new EventHub();
    try {
      const ref: SessionRef = {
        workspaceId: "b3ddf4b5-0e72-4b1d-a4a6-dc7b3ee69b11",
        sessionId: "8d7a61c9-ccbe-4663-ab0f-8bc8dd5375b8",
      };
      const subscriber = new FakeSocket();
      const otherSession = new FakeSocket();
      hub.addSession(ref, subscriber);
      hub.addSession({ ...ref, sessionId: "4b9bf733-2b1e-4b97-a886-84196d225d36" }, otherSession);

      const first = hub.publishSession(ref, { type: "run.started", runId: "run-1", payload: {} });
      const second = hub.publishSession(ref, { type: "run.settled", runId: "run-1", payload: {} });

      expect(first.seq).toBe(1);
      expect(second.seq).toBe(2);
      expect(hub.currentSeq(ref)).toBe(2);
      expect(subscriber.sent.map((payload) => JSON.parse(payload).seq)).toEqual([1, 2]);
      expect(otherSession.sent).toEqual([]);

      subscriber.close();
      hub.publishSession(ref, { type: "session.updated", payload: {} });

      expect(subscriber.sent).toHaveLength(2);
      expect(hub.currentSeq(ref)).toBe(3);
    } finally {
      hub.terminateAll();
    }
  });

  it("delivers global invalidations only to global subscribers and removes closed ones", () => {
    const hub = new EventHub();
    try {
      const global = new FakeSocket();
      const workspace = new FakeSocket();
      hub.addGlobal(global);
      hub.addWorkspace("workspace", workspace);
      hub.publishGlobal({ version: 1, type: "settings.changed" });
      expect(global.sent.map((payload) => JSON.parse(payload))).toEqual([{ version: 1, type: "settings.changed" }]);
      expect(workspace.sent).toEqual([]);
      global.close();
      hub.publishGlobal({ version: 1, type: "workspaces.changed" });
      expect(global.sent).toHaveLength(1);
    } finally {
      hub.terminateAll();
    }
  });

  it("terminates only the logging-out token across global, workspace and session subscriptions", () => {
    const hub = new EventHub();
    try {
      const global = new FakeSocket();
      const workspace = new FakeSocket();
      const session = new FakeSocket();
      const other = new FakeSocket();
      const anonymous = new FakeSocket();
      hub.addGlobal(global, "first");
      hub.addWorkspace("workspace", workspace, "first");
      hub.addSession({ workspaceId: "workspace", sessionId: "session" }, session, "first");
      hub.addGlobal(other, "second");
      hub.addGlobal(anonymous);
      hub.terminateAuthenticated("first");
      for (const socket of [global, workspace, session]) expect(socket.closeCode).toBe(4401);
      expect(other.readyState).toBe(1);
      expect(anonymous.readyState).toBe(1);
      hub.publishGlobal({ version: 1, type: "models.changed" });
      expect(global.sent).toEqual([]);
      expect(other.sent).toHaveLength(1);
      hub.terminateAuthenticated();
      expect(other.closeCode).toBe(4401);
      expect(anonymous.closeCode).toBe(4401);
    } finally {
      hub.terminateAll();
    }
  });

  it("keeps the newly issued token on password changes and anonymous sockets when authentication is disabled", () => {
    const hub = new EventHub();
    try {
      const old = new FakeSocket();
      const current = new FakeSocket();
      const anonymous = new FakeSocket();
      hub.addGlobal(old, "old");
      hub.addWorkspace("workspace", current, "new");
      hub.addGlobal(anonymous);
      hub.terminateAuthenticatedExcept("new");
      expect(old.closeCode).toBe(4401);
      expect(anonymous.closeCode).toBe(4401);
      expect(current.readyState).toBe(1);
      const open = new FakeSocket();
      hub.addGlobal(open);
      hub.terminateAuthenticatedExcept(undefined, 1012, "Authentication changed");
      expect(current.closeCode).toBe(1012);
      expect(open.readyState).toBe(1);
    } finally {
      hub.terminateAll();
    }
  });

  it("keeps global sockets in the heartbeat and shutdown lifecycle", () => {
    vi.useFakeTimers();
    const hub = new EventHub();
    try {
      const alive = new FakeSocket();
      const dead = new FakeSocket();
      dead.respondToProtocolPing = false;
      dead.respondToAppPing = false;
      hub.addGlobal(alive);
      hub.addGlobal(dead);
      vi.advanceTimersByTime(SOCKET_HEARTBEAT_INTERVAL_MS * 2);
      expect(alive.terminated).toBe(false);
      expect(dead.terminated).toBe(true);
      hub.terminateAll();
      expect(alive.terminated).toBe(true);
    } finally {
      hub.terminateAll();
      vi.useRealTimers();
    }
  });

  it("answers a client application ping with pong", () => {
    const hub = new EventHub();
    try {
      const ref: SessionRef = {
        workspaceId: "b3ddf4b5-0e72-4b1d-a4a6-dc7b3ee69b11",
        sessionId: "8d7a61c9-ccbe-4663-ab0f-8bc8dd5375b8",
      };
      const subscriber = new FakeSocket();
      hub.addSession(ref, subscriber);
      subscriber.receive(socketHeartbeatMessage(SOCKET_PING_TYPE));
      expect(subscriber.sent).toEqual([socketHeartbeatMessage(SOCKET_PONG_TYPE)]);
    } finally {
      hub.terminateAll();
    }
  });

  it("terminates subscribers that miss heartbeat pings and keeps responsive ones", () => {
    vi.useFakeTimers();
    const hub = new EventHub();
    try {
      const ref: SessionRef = {
        workspaceId: "b3ddf4b5-0e72-4b1d-a4a6-dc7b3ee69b11",
        sessionId: "8d7a61c9-ccbe-4663-ab0f-8bc8dd5375b8",
      };
      const alive = new FakeSocket();
      const dead = new FakeSocket();
      dead.respondToProtocolPing = false;
      dead.respondToAppPing = false;
      hub.addSession(ref, alive);
      hub.addSession(ref, dead);

      // 第一轮心跳：双方都收到 ping，均未断开。
      vi.advanceTimersByTime(SOCKET_HEARTBEAT_INTERVAL_MS);
      expect(alive.terminated).toBe(false);
      expect(dead.terminated).toBe(false);

      // 第二轮心跳：alive 已回 pong 保持存活，dead 无回应被断开。
      vi.advanceTimersByTime(SOCKET_HEARTBEAT_INTERVAL_MS);
      expect(alive.terminated).toBe(false);
      expect(dead.terminated).toBe(true);

      // 断开后不再收到发布事件。
      const event = hub.publishSession(ref, { type: "run.started", runId: "run-1", payload: {} });
      expect(alive.sent.map((payload) => JSON.parse(payload).type)).toEqual([SOCKET_PING_TYPE, SOCKET_PING_TYPE, "run.started"]);
      expect(dead.sent.map((payload) => JSON.parse(payload).type)).toEqual([SOCKET_PING_TYPE]);
      expect(hub.currentSeq(ref)).toBe(event.seq);
    } finally {
      hub.terminateAll();
      vi.useRealTimers();
    }
  });

  it("keeps a subscriber alive when only the application heartbeat answers", () => {
    vi.useFakeTimers();
    const hub = new EventHub();
    try {
      const ref: SessionRef = {
        workspaceId: "b3ddf4b5-0e72-4b1d-a4a6-dc7b3ee69b11",
        sessionId: "8d7a61c9-ccbe-4663-ab0f-8bc8dd5375b8",
      };
      const appOnly = new FakeSocket();
      appOnly.respondToProtocolPing = false;
      hub.addSession(ref, appOnly);

      vi.advanceTimersByTime(SOCKET_HEARTBEAT_INTERVAL_MS * 2);
      expect(appOnly.terminated).toBe(false);
      hub.publishSession(ref, { type: "run.started", runId: "run-1", payload: {} });
      expect(appOnly.sent.map((payload) => JSON.parse(payload).type)).toContain("run.started");
    } finally {
      hub.terminateAll();
      vi.useRealTimers();
    }
  });
});
