import { describe, expect, it } from "vitest";
import type { SessionRef } from "../shared/protocol.js";
import { EventHub } from "./event-hub.js";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly closeListeners = new Set<() => void>();

  send(payload: string): void {
    this.sent.push(payload);
  }

  on(event: "close", listener: () => void): void {
    if (event === "close") this.closeListeners.add(listener);
  }

  close(): void {
    this.readyState = 3;
    for (const listener of this.closeListeners) listener();
  }
}

describe("EventHub", () => {
  it("uses session-local monotonic sequences and removes closed subscribers", () => {
    const hub = new EventHub();
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
  });
});
