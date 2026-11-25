import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SubagentRecord, ToolTimelineItem } from "../../shared/protocol";
import { collapsedToolActivityItems, SubagentRecordRow, subagentToolLine, summarizeToolActivity, ToolActivity } from "./tool-activity";

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

  it("renders each operation without a grouped summary", () => {
    const base: ToolTimelineItem = { kind: "tool", id: "a", createdAt: "", name: "read", title: "Read file", state: "completed", target: "a.ts", output: "retained output" };
    const items = [base, { ...base, id: "b", target: "b.ts" }, { ...base, id: "c", state: "running" as const, target: "current.ts" }, { ...base, id: "d", name: "bash", title: "Run command", state: "failed" as const, inputPreview: "npm test", error: "failed output" }];
    expect(summarizeToolActivity(items)).toBe("读取 3 · 命令 1");
    const compact = renderToStaticMarkup(createElement(ToolActivity, { items, active: true, showAll: false }));
    expect(compact).not.toContain("读取 3 · 命令 1");
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
    expect(expanded).not.toContain("activity-group-label");
    expect(expanded).not.toContain("activity-narration");
    expect(expanded).toContain("读取了 a.ts");
    expect(expanded).toContain("读取了 b.ts");
    expect(expanded).not.toContain("读取 3 · 命令 1");
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

  it("renders queued calls as separate rows", () => {
    const base: ToolTimelineItem = { kind: "tool", id: "a", createdAt: "", name: "read", title: "Read file", state: "completed" };
    const queued = { ...base, state: "queued" as const };
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items: [{ ...queued, id: "q1" }, { ...queued, id: "q2" }], active: true }));
    expect(markup.match(/aria-label="等待执行"/g)).toHaveLength(2);
  });

  it("renders repeated and failed steps individually", () => {
    const base: ToolTimelineItem = { kind: "tool", id: "a", createdAt: "", name: "read", title: "Read file", state: "completed", target: "a.ts" };
    const items = [base, { ...base, id: "b" }, { ...base, id: "bad", state: "failed" as const, error: "boom" }];
    const markup = renderToStaticMarkup(createElement(ToolActivity, { items, active: true }));
    expect(markup.match(/读取了 a.ts/g)).toHaveLength(3);
  });

  it("writes a subagent tool line in the same words as the main session", () => {
    expect(subagentToolLine("read", "src/auth.ts")).toBe("读取了 auth.ts");
    expect(subagentToolLine("edit", "D:/projects/a/src/auth.ts")).toBe("编辑了 auth.ts");
    expect(subagentToolLine("grep", "subagent")).toBe("搜索了 subagent");
    expect(subagentToolLine("ls", "src/server")).toBe("查看了 server");
    expect(subagentToolLine("bash", "cd /tmp && git diff --check")).toBe("执行了 git diff --check");
  });
});

describe("subagent records", () => {
  const record: SubagentRecord = {
    kind: "subagent-record",
    id: "subagent-record:/root/audit:dispatched",
    createdAt: "2026-08-09T00:00:00.000Z",
    path: "/root/audit",
    agent: "executor",
    prompt: "只读审计任务",
    state: "dispatched",
    threadSessionId: "11111111-1111-4111-8111-111111111111",
  };

  it("keeps the dispatch on one row with its type colour", () => {
    const markup = renderToStaticMarkup(createElement(SubagentRecordRow, { record }));
    expect(markup).toContain('class="subagent-record running"');
    expect(markup).toContain('data-subagent-paths="/root/audit"');
    expect(markup).toContain('<span class="subagent-record-verb">派发</span>');
    expect(markup).toContain('<span class="subagent-role">executor</span>');
    expect(markup).toContain("只读审计任务");
    expect(markup).not.toContain("11111111");
  });

  it("shows the frozen duration and token usage on a finished record", () => {
    const markup = renderToStaticMarkup(createElement(SubagentRecordRow, { record: { ...record, state: "completed", durationMs: 83_000, tokens: 261_958 } }));
    expect(markup).toContain('<span class="subagent-record-verb">完成</span>');
    expect(markup).toContain('<span class="subagent-record-facts">1:23 · 262.0k tok</span>');
  });

  it("hands the whole record to the shared detail instead of opening its own drawer", () => {
    const opened: SubagentRecord[] = [];
    const markup = renderToStaticMarkup(createElement(SubagentRecordRow, { record, onOpen: (next) => { opened.push(next); } }));
    expect(markup).not.toContain("subagent-drawer");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(opened).toHaveLength(0);
  });

  it("keeps a failed record visible in a folded process", () => {
    const item: ToolTimelineItem = { kind: "tool", id: "failed", createdAt: "", name: "read", title: "Read file", state: "failed", subagent: undefined };
    expect(collapsedToolActivityItems([item], false, false)).toEqual([item]);
  });
});
