import { describe, expect, it, vi } from "vitest";
import type { SessionRef } from "../shared/protocol.js";
import { parseSocketHeartbeat, SOCKET_HEARTBEAT_INTERVAL_MS, SOCKET_PING_TYPE, SOCKET_PONG_TYPE, socketHeartbeatMessage } from "../shared/socket-heartbeat.js";
import { EventHub } from "./event-hub.js";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  terminated = false;
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

  close(): void {
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
