import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubagentCallView, SubagentView, ToolTimelineItem } from "../../shared/protocol";
import { collapsedToolActivityItems, formatElapsedMs, liveStreamRows, promptText, SubagentCallBody, SubagentCallList, subagentRowLabel, subagentToolLine, summarizeToolActivity, ToolActivity, visibleSubagentSteps } from "./tool-activity";

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
  it("limits an untouched closed process to current work and failures", () => {
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
    const compact = renderToStaticMarkup(createElement(ToolActivity, { items, active: true, showAll: false }));
    expect(compact).toContain("读取 3 · 命令 1");
    expect(compact).toContain('<div><article class="tool-item tool-list-item running"');
    expect(compact).toContain("npm test");
    expect(compact).toContain('<div hidden=""><article class="tool-item tool-list-item completed"><button class="tool-summary" type="button" aria-expanded="false"><svg');
    expect(compact).toContain('<span class="tool-title">读取了 a.ts</span>');
    const processCollapsed = renderToStaticMarkup(createElement(ToolActivity, { items, active: true, showAll: false, showActivePreview: false }));
    expect(processCollapsed).toContain('<div hidden=""><article class="tool-item tool-list-item running"');
    expect(processCollapsed).toContain("npm test");
    const expanded = renderToStaticMarkup(createElement(ToolActivity, { items, active: false, showAll: true }));
    expect(expanded).toContain("a.ts");
    expect(expanded).toContain("b.ts");
    expect(expanded).toContain('class="activity-group-label"');
    expect(expanded).not.toContain("activity-narration");
    expect(expanded).not.toContain('<div class="activity-group-label" aria-expanded');
    const foldable = renderToStaticMarkup(createElement(ToolActivity, { items, active: false, showAll: true, onToggleGroup: () => undefined }));
    expect(foldable).toContain('aria-expanded="true"');
    expect(foldable).toContain("读取了 a.ts");
    const folded = renderToStaticMarkup(createElement(ToolActivity, { items, active: false, showAll: true, groupCollapsed: true, onToggleGroup: () => undefined }));
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain('class="activity-items" hidden=""');
    const activeFoldable = renderToStaticMarkup(createElement(ToolActivity, { items, active: true, showAll: true, groupCollapsed: true, onToggleGroup: () => undefined }));
    expect(activeFoldable).toContain('aria-expanded="false"');
    expect(activeFoldable).toContain('class="activity-items" hidden=""');
    const preview = renderToStaticMarkup(createElement(ToolActivity, { items, active: true, showAll: false, onToggleGroup: () => undefined }));
    expect(preview).toContain('<button type="button" class="activity-group-label" aria-expanded="true">');
  });
});

describe("ToolActivity command rows", () => {
  it("parses the real command out of env prefixes and keeps it on one row", () => {
    const command = 'export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" node "c:/tools/example-skill/scripts/client.mjs" api list';
    const item: ToolTimelineItem = { kind: "tool", id: "cmd-1", createdAt: "", name: "bash", title: "Run command", state: "completed", inputPreview: command };
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [item], active: false }));
    expect(markup).toContain('<span class="tool-target">node &quot;c:/tools/example-skill/scripts/client.mjs&quot; api list</span>');
    expect(markup).not.toContain("MSYS_NO_PATHCONV");
    const opened = renderToStaticMarkup(createElement(ToolActivity, { items: [item], active: false, openItems: new Set(["cmd-1"]) }));
    expect(opened).toContain('<span class="tool-target">命令</span>');
    expect(opened.match(/MSYS_NO_PATHCONV=1/g)).toHaveLength(1);
  });

  it("uses the single-command row for PowerShell tools too", () => {
    const command = "node validate-site.mjs prototypes/site --json";
    const item: ToolTimelineItem = { kind: "tool", id: "powershell-1", createdAt: "", name: "powershell", title: "Run PowerShell", state: "completed", inputPreview: command };
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [item], active: false, openItems: new Set([item.id]) }));
    expect(markup).toContain('class="tool-summary command-summary"');
    expect(markup).toContain('<span class="tool-target">命令</span>');
    expect(markup.match(/node validate-site\.mjs/g)).toHaveLength(1);
  });

  it("shows only the first line of a multi-line command and keeps the full command in the details", () => {
    const command = "python - << 'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY";
    const item: ToolTimelineItem = { kind: "tool", id: "cmd-2", createdAt: "", name: "bash", title: "Run command", state: "completed", inputPreview: command };
    const collapsed = renderToStaticMarkup(createElement(ToolActivity, { items: [item], active: false }));
    expect(collapsed).toContain('<span class="tool-target">python - &lt;&lt; &#x27;PY&#x27;</span>');
    expect(collapsed).toMatch(/class="[^"]*turn-process-chevron/);
    expect(collapsed).not.toContain("import json");
    const opened = renderToStaticMarkup(createElement(ToolActivity, { items: [item], active: false, openItems: new Set(["cmd-2"]) }));
    expect(opened).toContain('<span class="tool-target">命令</span>');
    expect(opened).toContain("print(json.dumps");
    expect(opened.indexOf("import json")).toBeGreaterThan(opened.indexOf("detail-command-line"));
    const commandLine = "$ python - &lt;&lt; &#x27;PY&#x27;\nimport json\nprint(json.dumps({&#x27;ok&#x27;: True}))\nPY";
    expect(opened.match(/python - &lt;&lt; &#x27;PY&#x27;/g)).toHaveLength(1);
    expect(opened).toContain(commandLine);
  });

  it("parses the command behind assignments and cd prefixes", () => {
    expect(subagentToolLine("bash", "python - << 'PY'\nprint(1)\nPY")).toBe("执行了 python - << 'PY'");
    const item: ToolTimelineItem = {
      kind: "tool", id: "cmd-3", createdAt: "", name: "bash", title: "Run command", state: "completed",
      inputPreview: 'D="/tmp/dist"\ncd "$D" && tar czf /tmp/out/h5.tar.gz . && echo 上传完成',
    };
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [item], active: false }));
    expect(markup).toContain('<span class="tool-target">tar czf /tmp/out/h5.tar.gz .</span>');
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

  it("keeps a partial subagent failure visible while another child runs", () => {
    const item = subagentTool("running", {
      kind: "pi-subagent",
      results: [
        { agent: "scout", prompt: "Find the auth flow", state: "failed", error: "boom" },
        { agent: "worker", prompt: "Fix the return path", state: "running" },
      ],
      total: 2,
      completed: 0,
      running: 1,
      failed: 1,
    });
    expect(collapsedToolActivityItems([item], true, false)).toEqual([item]);
    expect(subagentRowLabel(item.subagent!, true)).toBe("1 失败 · worker · 执行中");
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
    expect(markup).not.toContain("现在执行目标单测。");
    expect(markup).not.toContain("session update");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("修复批发商无权店铺的返回");
    expect(markup).not.toContain("done");
  });

  it("keeps the collapsed row to a single line", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, {
      items: [subagentTool("running", {
        kind: "pi-subagent",
        results: [{ agent: "worker", prompt: "Fix auth", state: "running", output: "静态覆盖已补完。现在执行目标单测。" }],
        total: 1,
        completed: 0,
        running: 1,
        failed: 0,
      })],
      active: true,
    }));
    const summary = /<button class="tool-summary subagent-summary"[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(summary).toContain("worker · 执行中");
    expect(summary).not.toContain("现在执行目标单测");
  });

  it("shows the finished duration instead of a clock", () => {
    const item: ToolTimelineItem = { ...subagentTool("completed", {
      kind: "pi-subagent",
      results: [{ agent: "worker", prompt: "Fix auth", state: "completed" }],
      total: 1, completed: 1, running: 0, failed: 0,
    }), durationMs: 83_000 };
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [item], active: false }));
    expect(markup).toContain('class="run-elapsed">1:23</time>');
    expect(formatElapsedMs(3_723_000)).toBe("1:02:03");
  });

  it("shows every finished call's process without a second fold", () => {
    const markup = renderToStaticMarkup(createElement(SubagentCallList, {
      results: [
        { agent: "scout", prompt: "Map the auth flow", state: "completed", toolCalls: [{ name: "read", summary: "src/auth.ts" }] },
        { agent: "worker", prompt: "Fix the return path", state: "running", output: "现在执行目标单测。" },
      ],
    }));
    expect(markup).toContain("scout");
    expect(markup).toContain("worker");
    expect(markup).not.toContain("subagent-call-summary");
    expect(markup).toContain("读取了 auth.ts");
    expect(markup).toContain("现在执行目标单测。");
    expect(markup).not.toContain("Map the auth flow");
  });

  it("shows flat actions and the last text for old snapshots without repeating the prompt", () => {
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
    expect(markup).not.toContain("修复批发商空间中供应商链接进入无权采购店铺页");
    expect(markup).toContain("编辑了 procurement-orders-ui.test.ts");
    expect(markup).toContain("读取了 package.json");
    expect(markup).toContain("执行了 git diff --check");
    expect(markup).toContain("Verifying test contracts before running");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("edit packages");
    expect(markup).not.toContain("<code>");
  });

  it("keeps model and thinking level inside the expanded body", () => {
    const items = [subagentTool("running", {
      kind: "pi-subagent",
      results: [{ agent: "worker", prompt: "Fix the return path", state: "running", model: "gpt-test (fast)", thinkingLevel: "high", turns: 12 }],
      total: 1,
      completed: 0,
      running: 1,
      failed: 0,
    })];
    const collapsed = renderToStaticMarkup(createElement(ToolActivity, { items, active: true }));
    expect(collapsed).not.toContain("gpt-test");
    expect(collapsed).not.toContain("high");

    const expanded = renderToStaticMarkup(createElement(ToolActivity, { items, active: true, openItems: new Set(["sa-1"]) }));
    expect(expanded).toContain("gpt-test · high");
    expect(expanded).toContain("12 轮");
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

  it("renders the child process in order without labelling the thinking", () => {
    expect(subagentToolLine("bash", "cd /tmp && git diff --check")).toBe("执行了 git diff --check");
    const first = new Date(Date.now() - 120_000).toISOString();
    const second = new Date(Date.now() - 5_000).toISOString();
    const markup = renderToStaticMarkup(createElement(SubagentCallBody, {
      call: {
        agent: "worker",
        prompt: "Fix the return path",
        fullPrompt: "Fix the return path\n\n## 范围\n只改 auth.ts",
        state: "running",
        turns: 9,
        recentSteps: [
          { kind: "thinking", at: first, text: "先看读取逻辑" },
          { kind: "text", at: first, text: "**旧路径** 还在用 hash 资源" },
          { kind: "tool", at: first, name: "read", summary: "src/auth.ts" },
          { kind: "thinking", at: second, text: "改成新入口" },
          { kind: "tool", at: second, name: "edit", summary: "D:/projects/a/src/auth.ts" },
        ],
      },
    }));
    expect(markup).not.toContain("思考");
    expect(markup).not.toContain("**");
    // 同一轮既说了正文又有思考时，思考是草稿，只留正文。
    expect(markup).not.toContain("先看读取逻辑");
    expect(markup).toContain("旧路径");
    expect(markup.indexOf("旧路径")).toBeLessThan(markup.indexOf("读取了 auth.ts"));
    expect(markup.indexOf("读取了 auth.ts")).toBeLessThan(markup.indexOf("改成新入口"));
    expect(markup.indexOf("改成新入口")).toBeLessThan(markup.indexOf("编辑了 auth.ts"));
  });

  it("drops thinking that a message already says as text", () => {
    const steps: NonNullable<SubagentCallView["recentSteps"]> = [
      { kind: "thinking", at: "2026-01-01T00:00:00.000Z", text: "草稿" },
      { kind: "text", at: "2026-01-01T00:00:00.000Z", text: "正文" },
      { kind: "thinking", at: "2026-01-01T00:00:10.000Z", text: "只在思考里说" },
      { kind: "tool", at: "2026-01-01T00:00:10.000Z", name: "read", summary: "a.ts" },
    ];
    expect(visibleSubagentSteps(steps).map((step) => step.text ?? step.name)).toEqual(["正文", "只在思考里说", "read"]);
  });

  it("strips markdown markers from the prompt but keeps line breaks", () => {
    expect(promptText("## 范围\n**只改** a.ts\n- 第一条")).toBe("范围\n只改 a.ts\n· 第一条");
  });

  it("keeps the prompt behind a collapsed toggle above the process", () => {
    const call: SubagentCallView = {
      agent: "worker",
      prompt: "Fix the return path",
      fullPrompt: "Fix the return path\n\n## 范围\n只改 auth.ts",
      state: "running",
      recentSteps: [{ kind: "tool", name: "read", summary: "src/auth.ts" }],
    };
    const markup = renderToStaticMarkup(createElement(SubagentCallBody, { call }));
    expect(markup).toContain('class="subagent-prompt-toggle" aria-expanded="false"');
    expect(markup.indexOf("提示词")).toBeLessThan(markup.indexOf("读取了 auth.ts"));
    expect(markup).not.toContain("只改 auth.ts");
  });

  it("falls back to flat actions and the last text for old snapshots", () => {
    const markup = renderToStaticMarkup(createElement(SubagentCallBody, {
      call: {
        agent: "worker",
        prompt: "Fix the return path",
        state: "completed",
        output: "静态覆盖已补完。现在执行目标单测。",
        toolCalls: [{ name: "read", summary: "src/auth.ts" }],
      },
    }));
    expect(markup).toContain("读取了 auth.ts");
    expect(markup).toContain("静态覆盖已补完。现在执行目标单测。");
    expect(markup).not.toContain("思考");
  });
});

describe("ToolActivity live stream", () => {
  const base: ToolTimelineItem = { kind: "tool", id: "a", createdAt: "2026-08-09T00:00:00.000Z", name: "read", title: "Read file", state: "completed", target: "a.ts" };

  it("merges consecutive completed tools of the same kind into one counted row", () => {
    const rows = liveStreamRows([base, { ...base, id: "b", target: "b.ts" }, { ...base, id: "c", name: "powershell", title: "Run command", inputPreview: "npm test" }]);
    expect(rows.map((row) => row.kind)).toEqual(["run", "item"]);
    expect(rows[0]).toMatchObject({ label: "读取 ×2" });
    expect(rows[1]).toMatchObject({ kind: "item", item: { id: "c" } });
  });

  it("treats consecutive PowerShell and bash commands as the same kind", () => {
    const rows = liveStreamRows([{ ...base, id: "c1", name: "bash", inputPreview: "ls" }, { ...base, id: "c2", name: "powershell", inputPreview: "dir" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "run", label: "命令 ×2" });
  });

  it("folds queued rows into one waiting line and never spins them", () => {
    const queued = { ...base, state: "queued" as const };
    const rows = liveStreamRows([{ ...queued, id: "q1" }, { ...queued, id: "q2" }, { ...base, id: "run", state: "running" as const }]);
    expect(rows.map((row) => row.kind)).toEqual(["waiting", "item"]);
    expect(rows[0]).toMatchObject({ count: 2 });
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [{ ...queued, id: "q1" }, { ...queued, id: "q2" }], active: true, liveStream: true }));
    expect(markup).toContain("等待 2 步");
    expect(markup).not.toContain("spin");
    expect(markup).not.toContain("run-elapsed");
  });

  it("keeps a failed step as its own readable row and skips the group heading", () => {
    const rows = liveStreamRows([base, { ...base, id: "b" }, { ...base, id: "bad", state: "failed" as const, error: "boom" }, { ...base, id: "c" }, { ...base, id: "d" }]);
    expect(rows.map((row) => row.kind)).toEqual(["run", "item", "run"]);
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [base, { ...base, id: "b" }, { ...base, id: "bad", state: "failed" as const, error: "boom" }], active: true, liveStream: true }));
    expect(markup).toContain('class="activity-group live-stream running"');
    expect(markup).not.toContain("activity-group-label");
    expect(markup).toContain("读取 ×2");
    expect(markup).toContain('aria-expanded="false"');
  });

  it("opens a merged row into its individual steps", () => {
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [base, { ...base, id: "b", target: "b.ts" }], active: true, liveStream: true, openItems: new Set(["stream:a"]) }));
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("读取了 a.ts");
    expect(markup).toContain("读取了 b.ts");
  });

  it("does not merge subagent rows", () => {
    const subagent = subagentTool("completed", { kind: "pi-subagent", results: [{ agent: "scout", prompt: "a", state: "completed" }], total: 1, completed: 1, running: 0, failed: 0 });
    const rows = liveStreamRows([subagent, { ...subagent, id: "sa-2" }]);
    expect(rows.map((row) => row.kind)).toEqual(["item", "item"]);
  });
});
