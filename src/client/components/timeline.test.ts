import { describe, expect, it } from "vitest";
import type { ErrorTimelineItem, ExtensionUiTimelineItem, MessageTimelineItem, ThinkingTimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { groupTimelineItems, groupTimelineTurns, isTurnPinned, shouldFoldTurnProcess, shouldLoadEarlierAtTop, shouldStopFollowingOnGesture, summarizeTurnProcess, turnEndedInFailure, userMessageAnchors } from "./timeline";

function tool(id: string, name = "read"): ToolTimelineItem {
  return {
    kind: "tool",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    name,
    title: name === "read" ? "Read file" : "Run command",
    state: "completed",
  };
}

function message(id: string): MessageTimelineItem {
  return {
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    role: "assistant",
    text: "message",
  };
}

function error(id: string): ErrorTimelineItem {
  return {
    kind: "error",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    code: "PI_RUNTIME_ERROR",
    message: "HTTP 503: upstream unavailable",
    state: "failed",
  };
}

function thinking(id: string): ThinkingTimelineItem {
  return {
    kind: "thinking",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "completed",
    text: "thinking",
  };
}

function user(id: string): MessageTimelineItem {
  return { kind: "message", id, createdAt: "2026-01-01T00:00:00.000Z", role: "user", text: "prompt" };
}

function command(id: string): ToolTimelineItem {
  return { ...tool(id, "bash"), id: `bash:${id}` };
}

function dialog(id: string, outcome?: ExtensionUiTimelineItem["outcome"]): ExtensionUiTimelineItem {
  return { kind: "extension-ui", id, createdAt: "2026-01-01T00:00:00.000Z", request: { id, method: "confirm", title: "继续？" }, ...(outcome === undefined ? {} : { outcome }) };
}

describe("userMessageAnchors", () => {
  it("keeps only user messages and creates useful previews", () => {
    const longText = "A".repeat(120);
    expect(userMessageAnchors([
      { kind: "message", id: "a", role: "assistant", createdAt: "", text: "answer" },
      { kind: "message", id: "u", role: "user", createdAt: "", text: `  first\n  ${longText}` },
      { kind: "message", id: "image", role: "user", createdAt: "", text: "", images: [{ mimeType: "image/png", data: "x" }] },
    ])).toEqual([
      { id: "u", preview: `first ${"A".repeat(101)}…` },
      { id: "image", preview: "图片消息" },
    ]);
  });
});

describe("shouldStopFollowingOnGesture", () => {
  it("keeps following when the timeline has no vertical scroll range", () => {
    expect(shouldStopFollowingOnGesture({ scrollTop: 0, scrollHeight: 600, clientHeight: 600 }, -100)).toBe(false);
  });

  it("keeps following when scrolling down or already at the top", () => {
    expect(shouldStopFollowingOnGesture({ scrollTop: 120, scrollHeight: 1_200, clientHeight: 600 }, 100)).toBe(false);
    expect(shouldStopFollowingOnGesture({ scrollTop: 0, scrollHeight: 1_200, clientHeight: 600 }, -100)).toBe(false);
  });

  it("stops following when an upward gesture can move away from the latest messages", () => {
    expect(shouldStopFollowingOnGesture({ scrollTop: 600, scrollHeight: 1_200, clientHeight: 600 }, -100)).toBe(true);
  });
});

describe("shouldLoadEarlierAtTop", () => {
  it("loads more history only when the user reaches the top threshold", () => {
    expect(shouldLoadEarlierAtTop({ scrollTop: 72 }, true, false)).toBe(true);
    expect(shouldLoadEarlierAtTop({ scrollTop: 73 }, true, false)).toBe(false);
  });

  it("does not request history without another page or while a request is active", () => {
    expect(shouldLoadEarlierAtTop({ scrollTop: 0 }, false, false)).toBe(false);
    expect(shouldLoadEarlierAtTop({ scrollTop: 0 }, true, true)).toBe(false);
  });
});

describe("groupTimelineItems", () => {
  it("groups only consecutive tool items", () => {
    const result = groupTimelineItems([tool("a"), tool("b", "bash"), message("m"), tool("c")]);

    expect(result).toEqual([
      { kind: "activity", items: [tool("a"), tool("b", "bash")] },
      { kind: "message", item: message("m") },
      { kind: "activity", items: [tool("c")] },
    ]);
  });

  it("keeps message-only timelines unchanged", () => {
    expect(groupTimelineItems([message("a"), message("b")])).toEqual([
      { kind: "message", item: message("a") },
      { kind: "message", item: message("b") },
    ]);
  });

  it("keeps errors as their own entries and splits tool runs around them", () => {
    const result = groupTimelineItems([tool("a"), error("e"), message("m"), tool("c")]);

    expect(result).toEqual([
      { kind: "activity", items: [tool("a")] },
      { kind: "error", items: [error("e")] },
      { kind: "message", item: message("m") },
      { kind: "activity", items: [tool("c")] },
    ]);
  });

  it("keeps thinking cards as their own entries and splits tool runs around them", () => {
    const result = groupTimelineItems([tool("a"), thinking("t"), message("m"), tool("c")]);

    expect(result).toEqual([
      { kind: "activity", items: [tool("a")] },
      { kind: "thinking", item: thinking("t") },
      { kind: "message", item: message("m") },
      { kind: "activity", items: [tool("c")] },
    ]);
  });

  it("returns an empty list for an empty timeline", () => {
    expect(groupTimelineItems([])).toEqual([]);
  });
});

describe("groupTimelineTurns", () => {
  it("splits turns at user messages and lifts the trailing assistant text out of the process", () => {
    const result = groupTimelineTurns([user("u1"), thinking("t1"), tool("a"), message("m1"), user("u2"), message("m2")]);

    expect(result).toEqual([
      { key: "turn:u1", user: user("u1"), process: [{ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] }], final: message("m1") },
      { key: "turn:u2", user: user("u2"), process: [], final: message("m2") },
    ]);
  });

  it("keeps process entries that follow the last text inside the turn", () => {
    const [turn] = groupTimelineTurns([user("u1"), message("m1"), tool("a")]);

    expect(turn?.final).toBeUndefined();
    expect(turn?.process).toEqual([{ kind: "message", item: message("m1") }, { kind: "activity", items: [tool("a")] }]);
  });

  it("collects leading entries that precede any user message into their own turn", () => {
    const [turn] = groupTimelineTurns([tool("a"), user("u1"), message("m1")]);

    expect(turn).toEqual({ key: "turn:a", process: [{ kind: "activity", items: [tool("a")] }] });
  });

  it("returns an empty list for an empty timeline", () => {
    expect(groupTimelineTurns([])).toEqual([]);
  });
});

describe("summarizeTurnProcess", () => {
  it("counts operations, failures, and the process duration", () => {
    const [turn] = groupTimelineTurns([
      user("u1"),
      { ...tool("a"), createdAt: "2026-01-01T00:00:10.000Z" },
      { ...tool("b"), createdAt: "2026-01-01T00:00:20.000Z", state: "failed" },
      { ...error("e1"), groupId: "g", createdAt: "2026-01-01T00:00:30.000Z" },
      message("m1"),
    ]);

    expect(turn === undefined ? undefined : summarizeTurnProcess(turn)).toEqual({ operations: 2, failed: 2, durationMs: 20_000 });
  });

  it("omits durations that cannot be derived from timestamps", () => {
    const [turn] = groupTimelineTurns([user("u1"), { ...tool("a"), createdAt: "" }, tool("b")]);

    expect(turn === undefined ? undefined : summarizeTurnProcess(turn)).toEqual({ operations: 2, failed: 0 });
  });
});

describe("shouldFoldTurnProcess", () => {
  it("folds multi-entry processes and single process messages", () => {
    expect(shouldFoldTurnProcess({ key: "t", process: [{ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] }] })).toBe(true);
    expect(shouldFoldTurnProcess({ key: "t", process: [{ kind: "message", item: message("m1") }] })).toBe(true);
  });

  it("does not fold a single summary row or an empty process", () => {
    expect(shouldFoldTurnProcess({ key: "t", process: [{ kind: "thinking", item: thinking("t1") }] })).toBe(false);
    expect(shouldFoldTurnProcess({ key: "t", process: [{ kind: "activity", items: [tool("a")] }] })).toBe(false);
    expect(shouldFoldTurnProcess({ key: "t", process: [] })).toBe(false);
  });
});

describe("isTurnPinned", () => {
  it("pins turns with a pending interaction or a user !cmd", () => {
    expect(isTurnPinned({ key: "t", process: [{ kind: "extension-ui", item: dialog("d1") }] })).toBe(true);
    expect(isTurnPinned({ key: "t", process: [{ kind: "activity", items: [command("c1")] }] })).toBe(true);
  });

  it("leaves settled interactions unaffected", () => {
    expect(isTurnPinned({ key: "t", process: [{ kind: "extension-ui", item: dialog("d1", "answered") }] })).toBe(false);
    expect(isTurnPinned({ key: "t", process: [{ kind: "activity", items: [tool("a", "bash")] }] })).toBe(false);
  });
});

describe("turnEndedInFailure", () => {
  it("flags unrecovered errors and ignores recovered attempts", () => {
    expect(turnEndedInFailure({ key: "t", process: [{ kind: "error", items: [{ ...error("e1"), state: "recovered" }] }] })).toBe(false);
    expect(turnEndedInFailure({ key: "t", process: [{ kind: "error", items: [error("e1")] }] })).toBe(true);
  });
});
