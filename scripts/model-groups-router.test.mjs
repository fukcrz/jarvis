import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import router from "../plugins/bundled/model-groups-router.ts";

// The bundled router compacts mid-task by aborting the run and queueing a
// continuation. In a pi-subagent child that abort emits agent_settled(aborted),
// pi-subagent ends the child on it, and the delegated task fails with
// "This operation was aborted". Subagents must use Pi's in-run compaction.

function loadRouter() {
  const handlers = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  router(pi);
  const ctx = {
    hasUI: false,
    model: { provider: "fake", id: "fake-1", contextWindow: 200_000 },
    sessionManager: { getSessionId: () => `s-${Math.random()}`, getBranch: () => [], getSessionFile: () => undefined },
    getContextUsage: () => ({ tokens: 190_000 }),
    compact: vi.fn(),
  };
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start");
  return { emit, ctx };
}

describe("model-groups router compaction", () => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousDepth = process.env.PI_SUBAGENT_DEPTH;

  beforeEach(() => {
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "jarvis-router-"));
    delete process.env.PI_SUBAGENT_DEPTH;
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previousDepth;
  });

  it("keeps abort-and-continue compaction for normal sessions", () => {
    const { emit, ctx } = loadRouter();
    emit("agent_start");
    expect(emit("session_before_compact", { reason: "threshold" })).toEqual({ cancel: true });
    emit("turn_start", { turnIndex: 1 });
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it("lets a subagent compact in-run instead of aborting it", () => {
    process.env.PI_SUBAGENT_DEPTH = "1";
    const { emit, ctx } = loadRouter();
    emit("agent_start");
    emit("turn_start", { turnIndex: 1 });
    expect(ctx.compact).not.toHaveBeenCalled();
    expect(emit("session_before_compact", { reason: "threshold" })).toBeUndefined();
    expect(emit("session_before_compact", { reason: "overflow" })).toBeUndefined();
  });

  it("skips a subagent's threshold compaction after its final answer", () => {
    process.env.PI_SUBAGENT_DEPTH = "2";
    const { emit } = loadRouter();
    emit("agent_start");
    emit("agent_end");
    expect(emit("session_before_compact", { reason: "threshold" })).toEqual({ cancel: true });
    expect(emit("session_before_compact", { reason: "overflow" })).toBeUndefined();
    emit("agent_start");
    expect(emit("session_before_compact", { reason: "threshold" })).toBeUndefined();
  });
});
