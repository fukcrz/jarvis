import { describe, expect, it } from "vitest";
import type { ErrorTimelineItem, ExtensionUiTimelineItem, MessageTimelineItem, SessionStatus, ThinkingTimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { activeUserMessageAnchor, ACTIVITY_NARRATION_MAX_CHARS, formatUserMessageIndex, groupTimelineItems, groupTimelineTurns, isActivityNarratedBy, isFollowingLatest, isShortAssistantNarration, isToolActivityRunning, isTurnPinned, jumpLatestBottomForDock, mobileUserMessageRows, shouldFoldTurnProcess, shouldHideJumpLatestForComposer, shouldLoadEarlierAtTop, shouldShowJumpLatest, shouldStopFollowingOnGesture, summarizeTurnProcess, turnEndedInFailure, userMessageAnchors, userMessageAnchorsFromOutline } from "./timeline";

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
      { id: "u", index: 1, preview: `first ${"A".repeat(101)}…`, itemIndex: 1 },
      { id: "image", index: 2, preview: "图片消息", itemIndex: 2 },
    ]);
  });
});

describe("userMessageAnchorsFromOutline", () => {
  it("uses session-absolute indexes from the outline", () => {
    expect(userMessageAnchorsFromOutline([
      { id: "u1", preview: "first", itemIndex: 0 },
      { id: "u2", preview: "second", itemIndex: 4 },
    ])).toEqual([
      { id: "u1", index: 1, preview: "first", itemIndex: 0 },
      { id: "u2", index: 2, preview: "second", itemIndex: 4 },
    ]);
  });
});

describe("mobileUserMessageRows", () => {
  it("lists newest user messages first without changing indexes", () => {
    const anchors = userMessageAnchors([user("u1"), user("u2"), user("u3")]);
    expect(mobileUserMessageRows(anchors).map((anchor) => [anchor.id, anchor.index])).toEqual([
      ["u3", 3],
      ["u2", 2],
      ["u1", 1],
    ]);
  });
});

describe("activeUserMessageAnchor", () => {
  it("prefers the active message and otherwise uses the latest", () => {
    const anchors = userMessageAnchors([user("u1"), user("u2")]);
    expect(activeUserMessageAnchor(anchors, "u1")?.id).toBe("u1");
    expect(activeUserMessageAnchor(anchors)?.id).toBe("u2");
    expect(activeUserMessageAnchor([])).toBeUndefined();
  });
});

describe("formatUserMessageIndex", () => {
  it("pads chronological indexes to two digits", () => {
    expect(formatUserMessageIndex(1)).toBe("01");
    expect(formatUserMessageIndex(12)).toBe("12");
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

describe("isFollowingLatest", () => {
  it("is true only inside the near-bottom threshold", () => {
    const viewport = { scrollHeight: 1_200, clientHeight: 600 };
    expect(isFollowingLatest({ ...viewport, scrollTop: 528 })).toBe(false);
    expect(isFollowingLatest({ ...viewport, scrollTop: 529 })).toBe(true);
    expect(isFollowingLatest({ ...viewport, scrollTop: 600 })).toBe(true);
  });
});

describe("shouldShowJumpLatest", () => {
  it("hides the button while the viewport is at most 160px from the bottom", () => {
    const viewport = { scrollHeight: 1_200, clientHeight: 600 };
    expect(shouldShowJumpLatest({ ...viewport, scrollTop: 440 })).toBe(false);
    expect(shouldShowJumpLatest({ ...viewport, scrollTop: 439 })).toBe(true);
  });

  it("hides the button at the latest content", () => {
    expect(shouldShowJumpLatest({ scrollHeight: 600, clientHeight: 600, scrollTop: 0 })).toBe(false);
  });
});

describe("jumpLatestBottomForDock", () => {
  it("places the button above the dock with a small gap", () => {
    expect(jumpLatestBottomForDock(900, 700)).toBe(212);
  });

  it("does not return a negative offset when the dock reaches the shell top", () => {
    expect(jumpLatestBottomForDock(900, 960)).toBe(0);
  });
});

describe("shouldHideJumpLatestForComposer", () => {
  it("hides only on mobile after the editor exceeds 140px", () => {
    expect(shouldHideJumpLatestForComposer(true, 140)).toBe(false);
    expect(shouldHideJumpLatestForComposer(true, 141)).toBe(true);
    expect(shouldHideJumpLatestForComposer(false, 300)).toBe(false);
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

  it("merges consecutive errors even when group ids differ", () => {
    const first = { ...error("e1"), groupId: "run-a" };
    const second = { ...error("e2"), groupId: "run-b", message: "HTTP 403" };
    expect(groupTimelineItems([first, second])).toEqual([{ kind: "error", items: [first, second] }]);
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

  it("lifts a trailing unrecovered error out of the process", () => {
    const first = { ...error("e1"), groupId: "a" };
    const second = { ...error("e2"), groupId: "b", message: "HTTP 403" };
    const [turn] = groupTimelineTurns([user("u1"), thinking("t1"), first, second]);

    expect(turn?.process).toEqual([{ kind: "thinking", item: thinking("t1") }]);
    expect(turn?.finalError).toEqual([first, second]);
    expect(turn?.final).toBeUndefined();
  });

  it("keeps recovered trailing errors inside the process", () => {
    const recovered = { ...error("e1"), state: "recovered" as const };
    const [turn] = groupTimelineTurns([user("u1"), recovered, message("m1")]);

    expect(turn?.finalError).toBeUndefined();
    expect(turn?.final).toEqual(message("m1"));
    expect(turn?.process).toEqual([{ kind: "error", items: [recovered] }]);
  });
});

describe("summarizeTurnProcess", () => {
  it("counts operations and the process duration", () => {
    const [turn] = groupTimelineTurns([
      user("u1"),
      { ...tool("a"), createdAt: "2026-01-01T00:00:10.000Z" },
      { ...tool("b"), createdAt: "2026-01-01T00:00:20.000Z", state: "failed" },
      { ...error("e1"), groupId: "g", createdAt: "2026-01-01T00:00:30.000Z" },
      message("m1"),
    ]);

    expect(turn === undefined ? undefined : summarizeTurnProcess(turn)).toEqual({ operations: 2, durationMs: 20_000 });
  });

  it("omits durations that cannot be derived from timestamps", () => {
    const [turn] = groupTimelineTurns([user("u1"), { ...tool("a"), createdAt: "" }, tool("b")]);

    expect(turn === undefined ? undefined : summarizeTurnProcess(turn)).toEqual({ operations: 2 });
  });
});

describe("isShortAssistantNarration", () => {
  it("accepts a short assistant line and rejects longer text or images", () => {
    expect(isShortAssistantNarration(message("m1"))).toBe(true);
    expect(isShortAssistantNarration({ ...message("long"), text: "字".repeat(ACTIVITY_NARRATION_MAX_CHARS + 1) })).toBe(false);
    expect(isShortAssistantNarration({ ...message("image"), images: [{ mimeType: "image/png", data: "x" }] })).toBe(false);
    expect(isShortAssistantNarration(user("u1"))).toBe(false);
  });
});

describe("isActivityNarratedBy", () => {
  it("pairs a short assistant message with the following tool group", () => {
    expect(isActivityNarratedBy({ kind: "message", item: message("m1") }, { kind: "activity", items: [tool("a")] })).toBe(true);
  });

  it("does not pair tools with long text, thinking, errors, or a missing previous entry", () => {
    expect(isActivityNarratedBy({ kind: "message", item: { ...message("long"), text: "字".repeat(ACTIVITY_NARRATION_MAX_CHARS + 1) } }, { kind: "activity", items: [tool("a")] })).toBe(false);
    expect(isActivityNarratedBy({ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] })).toBe(false);
    expect(isActivityNarratedBy({ kind: "error", items: [error("e1")] }, { kind: "activity", items: [tool("a")] })).toBe(false);
    expect(isActivityNarratedBy(undefined, { kind: "activity", items: [tool("a")] })).toBe(false);
    expect(isActivityNarratedBy({ kind: "message", item: message("m1") }, { kind: "thinking", item: thinking("t1") })).toBe(false);
    expect(isActivityNarratedBy({ kind: "message", item: user("u1") }, { kind: "activity", items: [tool("a")] })).toBe(false);
  });
});

describe("isToolActivityRunning", () => {
  const running: SessionStatus = { sessionId: "s", runState: "running" };
  const idle: SessionStatus = { sessionId: "s", runState: "idle" };

  it("stays running only while the tail tool group still has a pending tool", () => {
    expect(isToolActivityRunning([{ ...tool("a"), state: "running" }], running)).toBe(true);
    expect(isToolActivityRunning([tool("a"), { ...tool("b"), state: "queued" }], running)).toBe(true);
    expect(isToolActivityRunning([tool("a")], running)).toBe(false);
    expect(isToolActivityRunning([{ ...tool("a"), state: "running" }, { ...thinking("t1"), state: "running" }], running)).toBe(false);
    expect(isToolActivityRunning([{ ...tool("a"), state: "running" }, message("m1")], running)).toBe(false);
    expect(isToolActivityRunning([{ ...tool("a"), state: "running" }], idle)).toBe(false);
  });
});

describe("shouldFoldTurnProcess", () => {
  it("folds multi-entry processes and single process messages", () => {
    expect(shouldFoldTurnProcess({ key: "t", process: [{ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] }] })).toBe(true);
    expect(shouldFoldTurnProcess({ key: "t", process: [{ kind: "message", item: message("m1") }] })).toBe(true);
    expect(shouldFoldTurnProcess({ key: "t", process: [{ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] }], finalError: [error("e1")] })).toBe(true);
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
    expect(turnEndedInFailure({ key: "t", process: [], finalError: [error("e1")] })).toBe(true);
  });
});
