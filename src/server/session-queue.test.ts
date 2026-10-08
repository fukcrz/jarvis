import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type ImageContent, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SessionQueue } from "../shared/protocol.js";
import { SessionMessageQueue } from "./session-queue.js";

const model: Model<"openai-completions"> = {
  id: "queue-test", name: "Queue test", api: "openai-completions", provider: "openai", baseUrl: "",
  reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096, maxTokens: 256,
};
const imageA: ImageContent = { type: "image", mimeType: "image/png", data: "image-A" };
const imageB: ImageContent = { type: "image", mimeType: "image/gif", data: "image-B" };

function user(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function createLoop() {
  const requests: UserMessage[][] = [];
  let releaseFirst: (() => void) | undefined;
  const streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"] = (activeModel, context) => {
    requests.push(context.messages.filter((message): message is UserMessage => message.role === "user"));
    const complete = () => {
      const stream = createAssistantMessageEventStream();
      const reply: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Done" }], api: activeModel.api,
        provider: activeModel.provider, model: activeModel.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: { ...reply, stopReason: "pending" } });
      stream.push({ type: "done", reason: "stop", message: reply });
      return stream;
    };
    if (requests.length === 1) {
      return new Promise((resolve) => { releaseFirst = () => resolve(complete()); });
    }
    return complete();
  };
  const agent = new Agent({ initialState: { model, systemPrompt: "Queue test" }, streamFn });
  // AgentSession.clearQueue() delegates to agent.clearAllQueues(); the text arrays it returns
  // are a separate SDK mirror, which this test does not need.
  const session = {
    agent,
    clearQueue: () => {
      agent.clearAllQueues();
      return { steering: [], followUp: [] };
    },
  } satisfies Pick<AgentSession, "agent" | "clearQueue">;
  const changes: SessionQueue[] = [];
  const queue = new SessionMessageQueue(session as unknown as AgentSession, (snapshot) => changes.push(snapshot));
  const delivered: Array<{ message: UserMessage; queue: SessionQueue }> = [];
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_start" && event.message.role === "user") {
      delivered.push({ message: event.message, queue: queue.snapshot() });
    }
  });
  const run = agent.prompt("Initial");
  return {
    agent, queue, changes, requests, delivered, run,
    async release() {
      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      releaseFirst?.();
      await run;
    },
    dispose() { unsubscribe(); queue.dispose(); },
  };
}

describe("SessionMessageQueue with a real Agent loop", () => {
  it("consumes a pure-image follow-up only when its complete message starts", async () => {
    const loop = createLoop();
    try {
      await vi.waitFor(() => expect(loop.requests).toHaveLength(1));
      const imageOnly = user([imageA, imageB]);
      loop.agent.followUp(imageOnly);
      const pending = loop.queue.snapshot().followUp[0]!;
      expect(pending).toMatchObject({ text: "", images: [
        { mimeType: imageA.mimeType, data: imageA.data }, { mimeType: imageB.mimeType, data: imageB.data },
      ] });
      expect(loop.agent.peekQueuedMessages()[0]).toBe(imageOnly);
      await loop.release();
      expect(loop.requests).toHaveLength(2);
      expect(loop.requests[1]![1]).toBe(imageOnly);
      expect(loop.delivered[1]!.message).toBe(imageOnly);
      expect(loop.delivered[1]!.queue).toEqual({ steering: [], followUp: [] });
      expect(loop.changes.at(-1)).toEqual({ steering: [], followUp: [] });
      expect(loop.agent.hasQueuedMessages()).toBe(false);
    } finally {
      loop.dispose();
    }
  });

  it("consumes same-text, different-image messages by object identity, not text", async () => {
    const loop = createLoop();
    try {
      await vi.waitFor(() => expect(loop.requests).toHaveLength(1));
      const first = user([{ type: "text", text: "Same" }, imageA]);
      const second = user([{ type: "text", text: "Same" }, imageB]);
      loop.agent.followUp(first);
      loop.agent.followUp(second);
      const initial = loop.queue.snapshot();
      expect(initial.followUp).toMatchObject([
        { text: "Same", images: [{ mimeType: "image/png", data: "image-A" }] },
        { text: "Same", images: [{ mimeType: "image/gif", data: "image-B" }] },
      ]);
      expect(initial.followUp[0]!.id).not.toBe(initial.followUp[1]!.id);
      await loop.release();
      expect(loop.requests).toHaveLength(3);
      expect(loop.requests[1]![1]).toBe(first);
      expect(loop.requests[2]![2]).toBe(second);
      expect(loop.delivered[1]!.message).toBe(first);
      expect(loop.delivered[1]!.queue).toEqual({ steering: [], followUp: [initial.followUp[1]!] });
      expect(loop.delivered[2]!.message).toBe(second);
      expect(loop.delivered[2]!.queue).toEqual({ steering: [], followUp: [] });
      expect(loop.changes).toEqual([
        { steering: [], followUp: [initial.followUp[0]!] }, initial,
        { steering: [], followUp: [initial.followUp[1]!] }, { steering: [], followUp: [] },
      ]);
    } finally {
      loop.dispose();
    }
  });

  it("keeps same-text steering and follow-up images distinct as each is consumed", async () => {
    const loop = createLoop();
    try {
      await vi.waitFor(() => expect(loop.requests).toHaveLength(1));
      const steer = user([{ type: "text", text: "Same" }, imageA]);
      const followUp = user([{ type: "text", text: "Same" }, imageB]);
      loop.agent.followUp(followUp);
      loop.agent.steer(steer);
      const initial = loop.queue.snapshot();
      expect(initial.steering[0]).toMatchObject({ text: "Same", images: [{ mimeType: "image/png", data: "image-A" }] });
      expect(initial.followUp[0]).toMatchObject({ text: "Same", images: [{ mimeType: "image/gif", data: "image-B" }] });
      await loop.release();
      expect(loop.delivered[1]!.message).toBe(steer);
      expect(loop.delivered[1]!.queue).toEqual({ steering: [], followUp: initial.followUp });
      expect(loop.delivered[2]!.message).toBe(followUp);
      expect(loop.delivered[2]!.queue).toEqual({ steering: [], followUp: [] });
      expect(loop.requests[1]![1]).toBe(steer);
      expect(loop.requests[2]![2]).toBe(followUp);
    } finally {
      loop.dispose();
    }
  });

  it.each(["all", "one-at-a-time"] as const)("drains steering before follow-up in %s mode", async (mode) => {
    const loop = createLoop();
    try {
      await vi.waitFor(() => expect(loop.requests).toHaveLength(1));
      loop.agent.steeringMode = mode;
      loop.agent.followUpMode = mode;
      const steerA = user([{ type: "text", text: "Steer" }, imageA]);
      const steerB = user([{ type: "text", text: "Steer" }, imageB]);
      const followA = user([imageA]);
      const followB = user([imageB]);
      loop.agent.steer(steerA);
      loop.agent.followUp(followA);
      loop.agent.steer(steerB);
      loop.agent.followUp(followB);
      const initial = loop.queue.snapshot();
      expect(loop.agent.peekQueuedMessages()).toEqual(mode === "all" ? [steerA, steerB] : [steerA]);
      await loop.release();
      const expected = [steerA, steerB, followA, followB];
      for (const [index, message] of expected.entries()) {
        expect(loop.delivered[index + 1]!.message).toBe(message);
      }
      expect(loop.requests.map((request) => request.length)).toEqual(mode === "all" ? [1, 3, 5] : [1, 2, 3, 4, 5]);
      // "all" drains the complete selected batch before its first message_start,
      // so none of those entries remain available for a late queue restore.
      expect(loop.delivered[1]!.queue.steering).toEqual(mode === "all" ? [] : [initial.steering[1]]);
      expect(loop.delivered[2]!.queue).toEqual({ steering: [], followUp: initial.followUp });
      expect(loop.delivered[3]!.queue.followUp).toEqual(mode === "all" ? [] : [initial.followUp[1]]);
      expect(loop.delivered[4]!.queue).toEqual({ steering: [], followUp: [] });
      expect(loop.agent.hasQueuedMessages()).toBe(false);
    } finally {
      loop.dispose();
    }
  });
});
