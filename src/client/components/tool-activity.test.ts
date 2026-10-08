import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubagentView, ToolTimelineItem } from "../../shared/protocol";
import { collapsedToolActivityItems, SubagentCallBody, SubagentCallList, subagentStatusLine, subagentTaskLine, subagentToolLine, summarizeToolActivity, ToolActivity } from "./tool-activity";

function subagentTool(state: ToolTimelineItem["state"], view: SubagentView): ToolTimelineItem {
  return {
    kind: "tool",
    id: "sa-1",
    createdAt: "2026-08-09T00:00:00.000Z",
    name: "subagent",
    title: "subagent",
    state,
    subagent: view,
  };
}

describe("ToolActivity summaries", () => {
  it("keeps a live preview only until the group is manually collapsed", () => {
    const completed: ToolTimelineItem = { kind: "tool", id: "done", createdAt: "", name: "read", title: "Read file", state: "completed" };
    const queued: ToolTimelineItem = { ...completed, id: "queued", state: "queued" };
    const running: ToolTimelineItem = { ...completed, id: "running", state: "running" };
    const failed: ToolTimelineItem = { ...completed, id: "failed", state: "failed" };
    const items = [completed, queued, running, failed];

    expect(collapsedToolActivityItems(items, true, true)).toEqual([queued, running, failed]);
    expect(collapsedToolActivityItems(items, true, false)).toEqual([failed]);
    expect(collapsedToolActivityItems(items, false, true)).toEqual([failed]);
  });

  it("summarizes consecutive operations while keeping running and failed rows visible", () => {
    const base: ToolTimelineItem = { kind: "tool", id: "a", createdAt: "", name: "read", title: "Read file", state: "completed", target: "a.ts", output: "retained output" };
    const items = [base, { ...base, id: "b", target: "b.ts" }, { ...base, id: "c", state: "running" as const, target: "current.ts" }, { ...base, id: "d", name: "bash", title: "Run command", state: "failed" as const, inputPreview: "npm test", error: "failed output" }];
    expect(summarizeToolActivity(items)).toBe("读取 3 · 命令 1");
    const compact = renderToStaticMarkup(createElement(ToolActivity, { items, active: true }));
    expect(compact).toContain("读取 3 · 命令 1");
    expect(compact).toContain("current.ts");
    expect(compact).toContain("npm test");
    expect(compact).not.toContain("a.ts");
    const processCollapsed = renderToStaticMarkup(createElement(ToolActivity, { items, active: true, showActivePreview: false }));
    expect(processCollapsed).not.toContain("current.ts");
    expect(processCollapsed).toContain("npm test");
    const expanded = renderToStaticMarkup(createElement(ToolActivity, { items, active: false, expanded: true }));
    expect(expanded).toContain("a.ts");
    expect(expanded).toContain("b.ts");
  });
});

describe("ToolActivity subagent rows", () => {
  it("collapses a single running call to agent and status", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [subagentTool("running", {
        kind: "pi-subagent",
        results: [{ agent: "scout", prompt: "Find the auth flow", state: "running" }],
        total: 1,
        completed: 0,
        running: 1,
        failed: 0,
      })],
      active: true,
    }));
    expect(markup).toContain("scout · 执行中");
    expect(markup).not.toContain("Find the auth flow");
  });

  it("names the running agents instead of a bare fraction", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [subagentTool("running", {
        kind: "pi-subagent",
        results: [
          { agent: "scout", prompt: "Map the auth flow", state: "completed", output: "done" },
          { agent: "worker", prompt: "Fix the return path", state: "running" },
          { agent: "reviewer", prompt: "Check the permission boundary", state: "running" },
        ],
        total: 3,
        completed: 1,
        running: 2,
        failed: 0,
      })],
      active: true,
    }));
    expect(markup).toContain("子代理 1/3 · worker、reviewer");
    expect(markup).not.toContain("done");
    expect(markup).not.toContain("Map the auth flow");
  });

  it("puts progress on the group title and the running agent on the row", () => {
    const sessionUpdate: ToolTimelineItem = { kind: "tool", id: "su", createdAt: "", name: "session_update", title: "session update", state: "completed" };
    const items = [sessionUpdate, subagentTool("running", {
      kind: "pi-subagent",
      results: [
        { agent: "scout", prompt: "Map the auth flow", state: "completed", output: "done" },
        { agent: "worker", prompt: "实施工作流 A：修复批发商无权店铺的返回", state: "running", output: "**Verifying test contracts before running**\n静态覆盖已补完。现在执行目标单测。" },
      ],
      total: 2,
      completed: 1,
      running: 1,
      failed: 0,
    })];
    expect(summarizeToolActivity(items)).toBe("更新会话 · 子代理 1/2");
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items, active: true }));
    expect(markup).toContain("更新会话 · 子代理 1/2");
    expect(markup).toContain("worker · 执行中");
    expect(markup).toContain("现在执行目标单测。");
    expect(markup).not.toContain("session update");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("修复批发商无权店铺的返回");
    expect(markup).not.toContain("done");
  });

  it("keeps finished calls to one line until opened", () => {
    const markup = renderToStaticMarkup(createElement(SubagentCallList, {
      results: [
        { agent: "scout", prompt: "Map the auth flow", state: "completed", output: "done", toolCalls: [{ name: "read", summary: "src/auth.ts" }] },
        { agent: "worker", prompt: "Fix the return path", state: "running", output: "现在执行目标单测。" },
      ],
    }));
    expect(markup).toContain("scout · 完成");
    expect(markup).toContain("worker · 执行中");
    expect(markup).toContain("现在执行目标单测。");
    expect(markup).not.toContain("Map the auth flow");
    expect(markup).not.toContain("src/auth.ts");
    expect(markup).not.toContain("done");
  });

  it("shows the task and recent steps as plain lines", () => {
    const markup = renderToStaticMarkup(createElement(SubagentCallBody, {
      call: {
        agent: "worker",
        prompt: "实施工作流 A（仅限以下文件及必要的同模块测试）：修复批发商空间中供应商链接进入无权采购店铺页",
        state: "running",
        output: "**Verifying test contracts before running**\n静态覆盖已补完。现在执行目标单测。",
        toolCalls: [
          { name: "edit", summary: "packages/tests/unit/supermarket/procurement-orders-ui.test.ts" },
          { name: "read", summary: "packages/tests/package.json" },
          { name: "bash", summary: "git diff --check && git status --short" },
        ],
      },
    }));
    expect(markup).toContain("修复批发商空间中供应商链接进入无权采购店铺页");
    expect(markup).toContain("编辑了 procurement-orders-ui.test.ts");
    expect(markup).toContain("读取了 package.json");
    expect(markup).toContain("执行了 git diff --check");
    expect(markup).toContain("Verifying test contracts before running");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("edit packages");
    expect(markup).not.toContain("<code>");
  });

  it("collapses a failed call without dumping output", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [subagentTool("failed", {
        kind: "pi-subagent",
        results: [{ agent: "scout", prompt: "Find auth", state: "failed", error: "boom" }],
        total: 1,
        completed: 0,
        running: 0,
        failed: 1,
      })],
      active: false,
    }));
    expect(markup).toContain("scout · 失败");
    expect(markup).not.toContain("boom");
  });

  it("shortens the task, the latest sentence, and tool targets", () => {
    expect(subagentTaskLine("实施工作流 A：修复批发商无权店铺的返回")).toBe("修复批发商无权店铺的返回");
    expect(subagentStatusLine("**Verifying**\n静态覆盖已补完。现在执行目标单测。")).toBe("现在执行目标单测。");
    expect(subagentToolLine("bash", "cd /tmp && git diff --check")).toBe("执行了 git diff --check");
    expect(subagentStatusLine("没有句号的很长进展".repeat(8)).endsWith("…")).toBe(true);
  });
});
