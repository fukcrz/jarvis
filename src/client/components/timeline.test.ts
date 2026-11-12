import { describe, expect, it } from "vitest";
import type { ErrorTimelineItem, ExtensionUiTimelineItem, MessageTimelineItem, SessionStatus, ThinkingTimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activeTimelineTurn, activeUserMessageAnchor, buildTurnSegments, groupTimelineItems, groupTimelineTurns, isTurnProcessOpen, MarkdownTextPreview, presentTurnProcess, processTextPreview, SettledChoices, isToolActivityRunning, shouldFoldProcess, shouldStopFollowingOnGesture, summarizeProcess, timelineProcessIds, trailingAssistantMessage, turnEndedInFailure, userMessageAnchors, userMessageAnchorsFromOutline, visibleNavigatorAnchorIds, type TimelineRenderItem, type TimelineSegment } from "./timeline";

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
    phase: "final_answer",
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

/** 把回合的段压成可读序列，便于断言顺序与归属。 */
function segmentsOf(turn: { segments: TimelineSegment[] } | undefined): string[] {
  return (turn?.segments ?? []).map((segment) => {
    if (segment.kind === "reply") return `reply:${segment.item.id}`;
    const entries = segment.kind === "inline" ? [segment.item] : segment.entries;
    const ids = entries.map((entry) => entry.kind === "activity" || entry.kind === "error" ? entry.items.map((item) => item.id).join("+") : entry.item.id);
    return `${segment.kind}:${ids.join(",")}`;
  });
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

describe("activeUserMessageAnchor", () => {
  it("prefers the active message and otherwise uses the latest", () => {
    const anchors = userMessageAnchors([user("u1"), user("u2")]);
    expect(activeUserMessageAnchor(anchors, "u1")?.id).toBe("u1");
    expect(activeUserMessageAnchor(anchors)?.id).toBe("u2");
    expect(activeUserMessageAnchor([])).toBeUndefined();
  });
});

describe("visibleNavigatorAnchorIds", () => {
  it("keeps the endpoints and a small window around the active message", () => {
    const anchors = userMessageAnchors(Array.from({ length: 12 }, (_, index) => user(`u${String(index)}`)));
    expect([...visibleNavigatorAnchorIds(anchors, "u6")]).toEqual(expect.arrayContaining(["u0", "u4", "u5", "u6", "u7", "u8", "u11"]));
    expect(visibleNavigatorAnchorIds(anchors, "u6").size).toBe(7);
  });

  it("keeps every node when the session is short", () => {
    const anchors = userMessageAnchors([user("u1"), user("u2"), user("u3"), user("u4")]);
    expect(visibleNavigatorAnchorIds(anchors, "u2").size).toBe(4);
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

  it("keeps run outcome metadata out of visible timeline entries", () => {
    const outcome = { kind: "run-outcome" as const, id: "run-outcome:run", createdAt: "", runId: "run", outcome: "completed" as const };
    expect(groupTimelineItems([message("m"), outcome, tool("t")])).toEqual([
      { kind: "message", item: message("m") },
      { kind: "activity", items: [tool("t")] },
    ]);
  });

});

describe("groupTimelineTurns", () => {
  it("splits turns at user messages and lifts the trailing assistant text out of the process", () => {
    const result = groupTimelineTurns([user("u1"), thinking("t1"), tool("a"), message("m1"), user("u2"), message("m2")]);

    expect(result).toEqual([
      {
        key: "turn:u1",
        user: user("u1"),
        segments: [
          { kind: "process", id: "process:t1", entries: [{ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] }] },
          { kind: "reply", id: "reply:m1", item: message("m1") },
        ],
      },
      { key: "turn:u2", user: user("u2"), segments: [{ kind: "reply", id: "reply:m2", item: message("m2") }] },
    ]);
  });

  it("keeps a response's text inside the process when that response also ran tools", () => {
    const stepText = { ...message("m1"), assistantMessageId: "r" };
    const ranTool = { ...tool("a"), assistantMessageId: "r" };
    const [turn] = groupTimelineTurns([user("u1"), thinking("t1"), stepText, ranTool]);

    expect(segmentsOf(turn)).toEqual(["process:t1,m1,a"]);
  });

  it("keeps the trailing answer visible even when the run ends with an error", () => {
    const [turn] = groupTimelineTurns([user("u1"), message("m1"), error("e1")]);

    expect(segmentsOf(turn)).toEqual(["reply:m1"]);
    expect(turn?.finalError).toEqual([error("e1")]);
  });

  it("treats a recorded phase as metadata instead of the visibility rule", () => {
    const answer = { ...message("m1"), phase: "final_answer" as const, assistantMessageId: "r" };
    const ranTool = { ...tool("a"), assistantMessageId: "r" };
    const [turn] = groupTimelineTurns([user("u1"), answer, ranTool]);

    expect(segmentsOf(turn)).toEqual(["process:m1,a"]);
  });

  it.each(["running", "completed"] as const)("keeps tools and thinking after the latest text in order when %s", (state) => {
    const entries = [user("u1"), thinking("t1"), message("m1"), { ...tool("a"), state }, { ...thinking("t2"), state }];
    expect(segmentsOf(groupTimelineTurns(entries)[0])).toEqual(["process:t1,m1,a,t2"]);
    expect(segmentsOf(groupTimelineTurns([...entries, message("m2")])[0])).toEqual(["process:t1,m1,a,t2", "reply:m2"]);
  });

  it("attaches run outcomes to turns without making them process entries", () => {
    const outcome = { kind: "run-outcome" as const, id: "run-outcome:run", createdAt: "", runId: "run", outcome: "stopped" as const };
    const [turn] = groupTimelineTurns([user("u1"), thinking("t1"), outcome]);
    expect(turn?.outcome).toEqual(outcome);
    expect(segmentsOf(turn)).toEqual(["process:t1"]);
  });

  it("keeps an error after commentary outside the process", () => {
    const [turn] = groupTimelineTurns([user("u1"), message("m1"), tool("a"), error("e1")]);
    expect(segmentsOf(turn)).toEqual(["process:m1,a"]);
    expect(turn?.finalError).toEqual([error("e1")]);
  });

  it("keeps standalone user commands after a completed reply in their own turn", () => {
    const command = tool("bash:command", "bash");
    const [reply, commandTurn] = groupTimelineTurns([user("u1"), thinking("t1"), tool("a"), message("m1"), command]);
    expect(segmentsOf(reply)).toEqual(["process:t1,a", "reply:m1"]);
    expect(segmentsOf(commandTurn)).toEqual(["inline:bash:command"]);
  });

  it("collects leading entries that precede any user message into their own turn", () => {
    const [turn] = groupTimelineTurns([tool("a"), user("u1"), message("m1")]);

    expect(turn).toEqual({ key: "turn:a", segments: [{ kind: "process", id: "process:a", entries: [{ kind: "activity", items: [tool("a")] }] }] });
  });

  it("keeps a leading process key stable when earlier blocks from the same response arrive", () => {
    const firstTool = { ...tool("tool"), assistantMessageId: "response", contentIndex: 1 };
    const earlierThinking = { ...thinking("thought"), assistantMessageId: "response", contentIndex: 0 };

    expect(groupTimelineTurns([firstTool])[0]?.key).toBe("turn:response");
    expect(groupTimelineTurns([earlierThinking, firstTool])[0]?.key).toBe("turn:response");
  });

  it("lifts a trailing unrecovered error out of the process", () => {
    const first = { ...error("e1"), groupId: "a" };
    const second = { ...error("e2"), groupId: "b", message: "HTTP 403" };
    const [turn] = groupTimelineTurns([user("u1"), thinking("t1"), first, second]);

    expect(segmentsOf(turn)).toEqual(["process:t1"]);
    expect(turn?.finalError).toEqual([first, second]);
  });

  it("keeps recovered trailing errors inside the process", () => {
    const recovered = { ...error("e1"), state: "recovered" as const };
    const [turn] = groupTimelineTurns([user("u1"), recovered, message("m1")]);

    expect(turn?.finalError).toBeUndefined();
    expect(segmentsOf(turn)).toEqual(["process:e1", "reply:m1"]);
  });
});

describe("summarizeProcess", () => {
  it("counts operations and the segment duration", () => {
    const entries: TimelineRenderItem[] = [
      { kind: "activity", items: [{ ...tool("a"), createdAt: "2026-01-01T00:00:10.000Z" }, { ...tool("b"), createdAt: "2026-01-01T00:00:20.000Z", state: "failed" }] },
      { kind: "error", items: [{ ...error("e1"), groupId: "g", createdAt: "2026-01-01T00:00:30.000Z" }] },
    ];

    expect(summarizeProcess(entries)).toEqual({ operations: 2, durationMs: 20_000, failures: 2 });
  });

  it("omits durations that cannot be derived from timestamps", () => {
    expect(summarizeProcess([{ kind: "activity", items: [{ ...tool("a"), createdAt: "" }, tool("b")] }])).toEqual({ operations: 2 });
  });
});

describe("structured text phases", () => {
  it.each(["Preparing", "正在检查代码", "字".repeat(250)])("keeps a step's text inside the process whatever it says: %s", (text) => {
    const step = { ...message("plain"), text, phase: undefined, assistantMessageId: "r" };
    const [turn] = groupTimelineTurns([user("u"), step, { ...tool("after"), assistantMessageId: "r" }, message("final")]);
    expect(segmentsOf(turn)).toEqual(["process:plain,after", "reply:final"]);
  });

  it("lifts a trailing commentary summary out of the process", () => {
    const commentary = { ...message("commentary"), phase: "commentary" as const, text: "Reviewing\n".repeat(200) };
    const [turn] = groupTimelineTurns([user("u"), thinking("t"), commentary]);
    expect(segmentsOf(turn)).toEqual(["process:t", "reply:commentary"]);
  });

  it("keeps earlier text inside the process and shows only the trailing answer", () => {
    const first = message("first");
    const second = message("second");
    const [turn] = groupTimelineTurns([user("u"), thinking("t"), first, tool("between"), second]);
    expect(segmentsOf(turn)).toEqual(["process:t,first,between", "reply:second"]);
  });

  it("retains all source blocks when tools follow a final text block", () => {
    const first = { ...message("first"), assistantMessageId: "response", contentIndex: 0 };
    const second = { ...message("second"), assistantMessageId: "response", contentIndex: 2 };
    const between = { ...tool("between"), assistantMessageId: "response", contentIndex: 1 };
    const after = { ...tool("after"), assistantMessageId: "response", contentIndex: 3 };
    const turns = groupTimelineTurns([user("u"), first, between, second, after]);
    expect(turns).toHaveLength(1);
    expect(timelineProcessIds(turns[0])).toEqual(["process:response"]);
    expect(segmentsOf(turns[0])).toEqual(["process:first,between,second,after"]);
  });

  it("keeps a leading process identity stable when a user message is paged in", () => {
    const process = { ...tool("tool"), assistantMessageId: "response", contentIndex: 1 };
    const withoutUser = groupTimelineTurns([process])[0];
    const withUser = groupTimelineTurns([user("u"), process])[0];
    expect(timelineProcessIds(withoutUser)).toEqual(["process:response"]);
    expect(timelineProcessIds(withUser)).toEqual(["process:response"]);
  });
});

describe("presentTurnProcess", () => {
  it("drops internal session updates along with the ask tool and custom follow-up", () => {
    const select: ExtensionUiTimelineItem = {
      kind: "extension-ui",
      id: "select",
      createdAt: "2026-01-01T00:00:00.000Z",
      outcome: "answered",
      value: "2. Type something.",
      request: { id: "select", method: "select", title: "是否按这个方案改？", options: ["1. 按方案改 — 补回归测试", "2. Type something."] },
    };
    const input: ExtensionUiTimelineItem = {
      kind: "extension-ui",
      id: "input",
      createdAt: "2026-01-01T00:00:01.000Z",
      outcome: "answered",
      value: "啥意思？我听不懂",
      request: { id: "input", method: "input", title: "是否按这个方案改？\n\nType your answer:" },
    };
    const presented = presentTurnProcess([
      { kind: "activity", items: [{ ...tool("update", "session_update"), title: "session update" }, { ...tool("ask", "ask_user_question"), title: "ask user question" }] },
      { kind: "extension-ui", item: select },
      { kind: "extension-ui", item: input },
    ]);
    expect(presented.entries).toEqual([{ kind: "extension-ui", item: select }]);
    expect(presented.customAnswers.get("select")).toBe("啥意思？我听不懂");
    expect(shouldFoldProcess(presented.entries)).toBe(true);
  });
});

describe("processTextPreview", () => {
  it("uses the last nonempty line only for the preview without altering the source", () => {
    expect(processTextPreview("Preparing\n正在检查代码\n\n")).toBe("正在检查代码");
    expect(processTextPreview("\n")).toBe("");
  });
});

describe("MarkdownTextPreview", () => {
  it("renders collapsed thinking preview text without Markdown markers", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownTextPreview, { text: "**已检查** `src/server`" }));
    expect(markup).toContain("已检查 src/server");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("`src/server`");
    expect(markup).not.toContain("<strong>");
    expect(markup).not.toContain("<code>");
  });
});

describe("SettledChoices", () => {
  it("defaults to the question and selected result, with the offered options collapsed", () => {
    const markup = renderToStaticMarkup(createElement(SettledChoices, {
      header: "发布确认",
      question: "是否推送？",
      rows: [
        { key: "a", index: 1, label: "推送并跟进", description: "创建 tag", preview: "变更预览", selected: true },
        { key: "b", index: 2, label: "暂不推送", description: "保留现状", selected: false },
      ],
    }));
    expect(markup).toContain("发布确认");
    expect(markup).toContain("是否推送？");
    expect(markup).toContain("推送并跟进");
    expect(markup).toContain("选项历史（2）");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("暂不推送");
    expect(markup).not.toContain("创建 tag");
    expect(markup).not.toContain("变更预览");
    expect(markup).not.toContain("extension-select-option");
  });

  it("shows custom answers and selected multi-options in the result without a placeholder row", () => {
    const custom = renderToStaticMarkup(createElement(SettledChoices, {
      question: "是否按这个方案修改？",
      rows: [
        { key: "a", index: 1, label: "按方案改", selected: false },
        { key: "typed", label: "还需要说明", selected: true },
      ],
    }));
    expect(custom).toContain("还需要说明");
    expect(custom).toContain("选项历史（1）");
    expect(custom).not.toContain("按方案改");
    expect(custom).not.toContain("Type something");

    const multi = renderToStaticMarkup(createElement(SettledChoices, {
      question: "选择范围",
      rows: [
        { key: "a", index: 1, label: "搜索", selected: true },
        { key: "b", index: 2, label: "批量", selected: false },
        { key: "c", index: 3, label: "导出", selected: true },
        { key: "typed", label: "还要权限", selected: true },
      ],
    }));
    expect(multi).toContain("搜索、导出 · 还要权限");
    expect(multi).toContain("选项历史（3）");
    expect(multi).not.toContain("批量");
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

describe("shouldFoldProcess", () => {
  it("folds a settled segment of any size", () => {
    expect(shouldFoldProcess([{ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] }])).toBe(true);
    expect(shouldFoldProcess([{ kind: "message", item: message("m1") }])).toBe(true);
    expect(shouldFoldProcess([{ kind: "activity", items: [tool("a")] }])).toBe(true);
    expect(shouldFoldProcess([])).toBe(false);
  });

  it("waits for the whole run to settle before folding its process", () => {
    const entries: TimelineRenderItem[] = [{ kind: "thinking", item: thinking("t1") }, { kind: "activity", items: [tool("a")] }];
    expect(shouldFoldProcess(entries, true)).toBe(false);
    expect(shouldFoldProcess(entries, false)).toBe(true);
  });
});

describe("activeTimelineTurn", () => {
  it("keeps previous replies completed during manual compaction and standalone commands", () => {
    const turns = groupTimelineTurns([user("u1"), thinking("t1"), message("m1")]);
    const status: SessionStatus = { sessionId: "s", runState: "running", activeRun: { id: "run", startedAt: "2026-01-01T00:01:00.000Z", kind: "llm" } };
    expect(activeTimelineTurn(turns, status)).toBe(turns[0]);
    expect(activeTimelineTurn(turns, { ...status, compacting: { reason: "overflow", startedAt: status.activeRun!.startedAt } })).toBe(turns[0]);
    expect(activeTimelineTurn(turns, { ...status, activeRun: { ...status.activeRun!, kind: "compaction" } })).toBeUndefined();
    expect(activeTimelineTurn(turns, { ...status, activeRun: { ...status.activeRun!, kind: "bash" } })).toBeUndefined();
    expect(activeTimelineTurn(turns, { sessionId: "s", runState: "idle" })).toBeUndefined();
  });
});

describe("isTurnProcessOpen", () => {
  it("stays collapsed until the user opens it", () => {
    expect(isTurnProcessOpen({ openProcessIds: new Set<string>() }, "p")).toBe(false);
    expect(isTurnProcessOpen({ openProcessIds: new Set<string>() }, undefined)).toBe(false);
    expect(isTurnProcessOpen({ openProcessIds: new Set(["p"]) }, "p")).toBe(true);
  });
});

describe("buildTurnSegments", () => {
  it("cuts segments in source order and keeps dialogs and commands visible", () => {
    const segments = buildTurnSegments([
      { kind: "thinking", item: thinking("t1") },
      { kind: "activity", items: [{ ...tool("a"), assistantMessageId: "r" }] },
      { kind: "message", item: { ...message("a1"), assistantMessageId: "r1" } },
      { kind: "activity", items: [command("c1")] },
      { kind: "extension-ui", item: dialog("d1") },
      { kind: "extension-ui", item: dialog("d2", "answered") },
      { kind: "message", item: { ...message("a2"), assistantMessageId: "r3" } },
    ]);

    expect(segments.map((segment) => segment.kind)).toEqual(["process", "reply", "inline", "inline", "process", "reply"]);
    expect(segments.flatMap((segment) => segment.kind === "process" ? [segment.id] : [])).toEqual(["process:r", "process:d2"]);
  });

  it("keeps several replies in their original positions", () => {
    const segments = buildTurnSegments([
      { kind: "activity", items: [{ ...tool("a"), assistantMessageId: "r1" }] },
      { kind: "message", item: { ...message("a1"), assistantMessageId: "r2" } },
      { kind: "activity", items: [{ ...tool("b"), assistantMessageId: "r3" }] },
      { kind: "message", item: { ...message("a2"), assistantMessageId: "r4" } },
    ]);

    expect(segments.map((segment) => segment.kind === "reply" ? segment.item.id : segment.kind)).toEqual(["process", "a1", "process", "a2"]);
  });
});

describe("trailingAssistantMessage", () => {
  it("keeps the run indicator inside the message when it ends the process", () => {
    expect(trailingAssistantMessage([{ kind: "activity", items: [tool("a")] }, { kind: "message", item: message("a1") }])?.item.id).toBe("a1");
  });

  it("does not hold the run indicator above later steps", () => {
    expect(trailingAssistantMessage([{ kind: "message", item: message("a1") }, { kind: "activity", items: [tool("b", "edit")] }])).toBeUndefined();
    expect(trailingAssistantMessage([])).toBeUndefined();
  });
});

describe("turnEndedInFailure", () => {
  it("flags unrecovered errors and ignores recovered attempts", () => {
    expect(turnEndedInFailure({ key: "t", segments: [{ kind: "process", id: "p", entries: [{ kind: "error", items: [{ ...error("e1"), state: "recovered" }] }] }] })).toBe(false);
    expect(turnEndedInFailure({ key: "t", segments: [{ kind: "process", id: "p", entries: [{ kind: "error", items: [error("e1")] }] }] })).toBe(true);
    expect(turnEndedInFailure({ key: "t", segments: [], finalError: [error("e1")] })).toBe(true);
  });
});
