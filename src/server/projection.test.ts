import { describe, expect, it } from "vitest";
import { encodeTimelineMediaItemId, projectHistory, toExternalTimelineItem, toExternalTimelineItems, toolFromCall, toolWithPartial, toolWithResult, toolImageUrl } from "./projection.js";

describe("projectHistory", () => {
  it("turns Pi messages and tool results into a stable linear timeline", () => {
    const items = projectHistory([
      {
        type: "message",
        id: "user-entry",
        timestamp: "2026-08-09T00:00:00.000Z",
        message: { role: "user", content: "Inspect the repository" },
      },
      {
        type: "message",
        id: "assistant-entry",
        timestamp: "2026-08-09T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "I will inspect it." },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "package.json" } },
          ],
        },
      },
      {
        type: "message",
        id: "tool-entry",
        timestamp: "2026-08-09T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "{\"name\":\"jarvis\"}" }] },
      },
    ]);

    expect(items).toEqual([
      expect.objectContaining({ kind: "message", role: "user", text: "Inspect the repository" }),
      expect.objectContaining({ kind: "thinking", state: "completed", text: "hidden" }),
      expect.objectContaining({ kind: "message", role: "assistant", text: "I will inspect it." }),
      expect.objectContaining({ kind: "tool", id: "tool-1", name: "read", state: "completed", target: "package.json", output: "{\"name\":\"jarvis\"}" }),
    ]);
  });

  it("projects bash exit codes as command status instead of output text", () => {
    const items = projectHistory([
      {
        type: "message",
        id: "bash-success",
        timestamp: "2026-08-09T00:00:03.000Z",
        message: { role: "bashExecution", command: "npm test", output: "29 passed", exitCode: 0, cancelled: false, truncated: false },
      },
      {
        type: "message",
        id: "bash-failure",
        timestamp: "2026-08-09T00:00:04.000Z",
        message: { role: "bashExecution", command: "npm run build", output: "TypeScript error", exitCode: 1, cancelled: false, truncated: true },
      },
    ]);

    expect(items).toEqual([
      expect.objectContaining({ kind: "tool", name: "bash", state: "completed", exitCode: 0, output: "29 passed" }),
      expect.objectContaining({ kind: "tool", name: "bash", state: "failed", exitCode: 1, truncated: true, error: "TypeScript error" }),
    ]);
    expect(items[0]).not.toHaveProperty("error");
    expect(items[1]).not.toHaveProperty("output");
  });

  it("projects live tool result metadata without changing Pi result content", () => {
    const running = toolFromCall("bash-1", "bash", { command: "npm test" }, "2026-08-09T00:00:00.000Z", "running", { cwd: "D:/projects/jarvis" });
    const completed = toolWithResult(running, {
      content: [{ type: "text", text: "29 passed" }],
      details: { exitCode: 0, truncation: { truncated: true } },
    }, false, 1250);

    expect(completed).toMatchObject({ kind: "tool", name: "bash", cwd: "D:/projects/jarvis", state: "completed", exitCode: 0, durationMs: 1250, truncated: true, output: "29 passed" });
  });

  it("carries image parts from read tool results onto the tool item", () => {
    const running = toolFromCall("read-1", "read", { path: "screenshot.png" }, "2026-08-09T00:00:00.000Z", "running");
    const completed = toolWithResult(running, {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    }, false);

    expect(completed).toMatchObject({
      kind: "tool",
      name: "read",
      state: "completed",
      output: "Read image file [image/png]",
      images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
    });
  });

  it("strips in-flight tool images the same way as persisted ones", () => {
    const running = toolFromCall("read-live", "read", { path: "shot.png" }, "2026-08-09T00:00:00.000Z", "running");
    const partial = toolWithPartial(running, {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    });
    const ref = { workspaceId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" };
    const external = toExternalTimelineItem(partial, ref);
    expect(external).toMatchObject({
      kind: "tool",
      id: "read-live",
      state: "running",
      images: [{ mimeType: "image/png", url: `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/media/read-live/0` }],
    });
    expect(external.kind === "tool" ? external.images?.[0] : undefined).not.toHaveProperty("data");
    expect(partial.images?.[0]).toHaveProperty("data");
  });

  it("replays image-bearing tool results from persisted history", () => {
    const items = projectHistory([
      {
        type: "message",
        id: "tool-call",
        message: { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "screenshot.png" } }] },
      },
      {
        type: "message",
        id: "tool-result",
        message: {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
        },
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", name: "read", state: "completed", output: "Read image file [image/png]", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] });

    const ref = { workspaceId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" };
    const external = toExternalTimelineItems(items, ref);
    expect(external[0]).toMatchObject({
      kind: "tool",
      id: "call_1",
      images: [{ mimeType: "image/png", url: `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/media/call_1/0` }],
    });
    expect(external[0]?.kind === "tool" ? external[0].images?.[0] : undefined).not.toHaveProperty("data");
    expect(items[0]?.kind === "tool" ? items[0].images?.[0] : undefined).toHaveProperty("data");
  });

  it("leaves user-message attachments inlined when stripping tool images", () => {
    const ref = { workspaceId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" };
    const user = {
      kind: "message" as const,
      id: "message:user:1",
      role: "user" as const,
      createdAt: "2026-08-09T00:00:00.000Z",
      text: "see this",
      images: [{ mimeType: "image/png", data: "user-bytes" }],
    };
    const tool = {
      kind: "tool" as const,
      id: "call_1",
      createdAt: "2026-08-09T00:00:01.000Z",
      name: "read",
      title: "Read file",
      state: "completed" as const,
      images: [{ mimeType: "image/png", data: "tool-bytes" }],
    };
    const [externalUser, externalTool] = toExternalTimelineItems([user, tool], ref);
    expect(externalUser).toEqual(user);
    expect(externalTool).toMatchObject({ kind: "tool", images: [{ mimeType: "image/png", url: `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/media/call_1/0` }] });
    expect(externalTool?.kind === "tool" ? externalTool.images?.[0] : undefined).not.toHaveProperty("data");
  });

  it("percent-encodes tool ids in media urls", () => {
    const ref = { workspaceId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" };
    const toolId = "call:read/image";
    expect(encodeTimelineMediaItemId(toolId)).toBe("call%3Aread%2Fimage");
    expect(toolImageUrl(ref, toolId, 0)).toBe(`/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/media/call%3Aread%2Fimage/0`);
  });

  it("drops oversized or non-image tool result parts", () => {
    const running = toolFromCall("read-2", "read", { path: "big.png" }, "2026-08-09T00:00:00.000Z", "running");
    const completed = toolWithResult(running, {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "x".repeat(10_000_001), mimeType: "image/png" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "application/octet-stream" },
      ],
    }, false);

    expect(completed).toMatchObject({ kind: "tool", name: "read", state: "completed", output: "Read image file [image/png]" });
    expect(completed).not.toHaveProperty("images");
  });

  it("projects persisted compaction and branch summaries as distinct context markers", () => {
    const items = projectHistory([
      { type: "compaction", id: "compact-entry", timestamp: "2026-08-09T00:00:03.000Z", summary: "## Current work\n- Added retry feedback", firstKeptEntryId: "kept", tokensBefore: 128_400 },
      { type: "branch_summary", id: "branch-entry", timestamp: "2026-08-09T00:00:04.000Z", summary: "Prior branch investigated session history.", fromId: "root" },
    ]);

    expect(items).toEqual([
      expect.objectContaining({ kind: "context-summary", id: "context-summary:compact-entry", summaryType: "compaction", tokensBefore: 128_400, summary: "## Current work\n- Added retry feedback" }),
      expect.objectContaining({ kind: "context-summary", id: "context-summary:branch-entry", summaryType: "branch", summary: "Prior branch investigated session history." }),
    ]);
  });

  it("projects thinking blocks as collapsible cards before the answer", () => {
    const items = projectHistory([{
      type: "message",
      id: "assistant-entry",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Visible answer" }] },
    }]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "thinking", id: "thinking:assistant-entry", state: "completed", text: "private" });
    expect(items[1]).toMatchObject({ kind: "message", text: "Visible answer" });
    // 思考内容不进消息正文，正文仍只含可见回答。
    expect(items[1]).not.toHaveProperty("text", expect.stringContaining("private"));
  });

  it("recovers harness reasoning persisted as a <thinking> text part", () => {
    const items = projectHistory([{
      type: "message",
      id: "assistant-entry",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "<thinking>private planning</thinking> Visible answer" },
        ],
      },
    }]);

    expect(items).toEqual([
      expect.objectContaining({ kind: "thinking", state: "completed", text: "private planning" }),
      expect.objectContaining({ kind: "message", text: "Visible answer" }),
    ]);
  });

  it("keeps unclosed <thinking> markers out of the visible answer", () => {
    const items = projectHistory([{
      type: "message",
      id: "assistant-entry",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "<thinking>private planning without a closing tag" },
          { type: "text", text: "Visible answer" },
        ],
      },
    }]);

    expect(items).toEqual([expect.objectContaining({ kind: "message", text: "Visible answer" })]);
  });

  it("projects model errors as diagnostic items instead of assistant messages", () => {
    const items = projectHistory([{
      type: "message",
      id: "failed-entry",
      timestamp: "2026-08-09T00:00:05.000Z",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 503: upstream unavailable" },
    }]);

    expect(items).toEqual([expect.objectContaining({ kind: "error", code: "PI_RUNTIME_ERROR", message: "HTTP 503: upstream unavailable", state: "failed" })]);
    expect(items).not.toEqual([expect.objectContaining({ kind: "message" })]);
  });

  it("retains failed retry diagnostics but marks them recovered after a successful continuation", () => {
    const items = projectHistory([
      {
        type: "message",
        id: "failed-entry",
        timestamp: "2026-08-09T00:00:05.000Z",
        message: { id: "attempt-1", role: "assistant", content: [], stopReason: "error", errorMessage: "Temporary failure" },
      },
      {
        type: "message",
        id: "success-entry",
        timestamp: "2026-08-09T00:00:06.000Z",
        message: { role: "assistant", parentId: "attempt-1", content: [{ type: "text", text: "Recovered answer" }], stopReason: "stop" },
      },
    ]);

    expect(items[0]).toMatchObject({ kind: "error", id: "error:attempt-1", groupId: "attempt-1", state: "recovered", message: "Temporary failure" });
    expect(items[1]).toMatchObject({ kind: "message", text: "Recovered answer" });
  });

  it("preserves producer-supplied diagnostics without parsing error text", () => {
    const items = projectHistory([{
      type: "message",
      id: "failed-entry",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Gateway rejected request",
        errorCode: "UPSTREAM_FAILURE",
        errorDetails: { requestId: "req-123", route: "primary", ignored: 12 },
      },
    }]);

    expect(items).toEqual([expect.objectContaining({ kind: "error", code: "UPSTREAM_FAILURE", diagnostics: { requestId: "req-123", route: "primary" } })]);
  });

  it("projects image attachments from user messages", () => {
    const items = projectHistory([{
      type: "message",
      id: "user-entry",
      message: {
        role: "user",
        content: [
          { type: "text", text: "What is in this picture?" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    }]);

    expect(items).toEqual([expect.objectContaining({
      kind: "message",
      role: "user",
      text: "What is in this picture?",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    })]);
  });

  it("projects image-only user messages without dropping them", () => {
    const items = projectHistory([{
      type: "message",
      id: "user-entry",
      message: {
        role: "user",
        content: [{ type: "image", data: "aGVsbG8=", mediaType: "image/jpeg" }],
      },
    }]);

    expect(items).toEqual([expect.objectContaining({
      kind: "message",
      role: "user",
      text: "",
      images: [{ mimeType: "image/jpeg", data: "aGVsbG8=" }],
    })]);
  });
});

describe("pi-subagent snapshots", () => {
  const longPrompt = `${"Find the auth flow ".repeat(20)}end`;
  const childMessages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "read", arguments: { path: "src/server/auth-service.ts" } },
        { type: "text", text: "Auth lives in auth-service." },
      ],
    },
  ];

  it("seeds running calls from args before details arrive", () => {
    const running = toolFromCall("sa-1", "subagent", {
      calls: [{ agent: "scout", prompt: longPrompt, session: "explore-auth" }],
    }, "2026-08-09T00:00:00.000Z", "running");

    expect(running.subagent).toEqual({
      kind: "pi-subagent",
      results: [{
        agent: "scout",
        prompt: `${longPrompt.replace(/\s+/g, " ").trim().slice(0, 159)}…`,
        state: "running",
        sessionHandle: "explore-auth",
      }],
      total: 1,
      completed: 0,
      running: 1,
      failed: 0,
    });
    expect(JSON.stringify(running.subagent)).not.toContain("messages");
  });

  it("overlays live progress without copying child message trees", () => {
    const running = toolFromCall("sa-1", "subagent", {
      calls: [{ agent: "scout", prompt: "Find auth" }],
    }, "2026-08-09T00:00:00.000Z", "running");
    const partial = toolWithPartial(running, {
      content: [{ type: "text", text: "Subagents: 0/1 done, 1 running..." }],
      details: {
        kind: "pi-subagent",
        projectAgentsDir: "/secret/agents",
        results: [{
          agent: "scout",
          prompt: "Find auth",
          agentSource: "user",
          exitCode: -1,
          messages: childMessages,
          stderr: "noise",
          model: "gpt-test",
          usage: { turns: 1 },
        }],
      },
    });

    expect(partial.subagent).toMatchObject({
      kind: "pi-subagent",
      running: 1,
      completed: 0,
      failed: 0,
      results: [{
        agent: "scout",
        state: "running",
        source: "user",
        model: "gpt-test",
        turns: 1,
        output: "Auth lives in auth-service.",
        toolCalls: [{ name: "read", summary: "src/server/auth-service.ts" }],
      }],
    });
    expect(partial.subagent?.results[0]).not.toHaveProperty("messages");
    expect(JSON.stringify(partial.subagent)).not.toContain("projectAgentsDir");
    expect(JSON.stringify(partial.subagent)).not.toContain("stderr");
  });

  it("maps completed, failed, and cancelled child states from mjakl details", () => {
    const running = toolFromCall("sa-2", "subagent", {
      calls: [
        { agent: "scout", prompt: "A" },
        { agent: "worker", prompt: "B" },
        { agent: "reviewer", prompt: "C" },
      ],
    }, "2026-08-09T00:00:00.000Z", "running");
    const completed = toolWithResult(running, {
      content: [{ type: "text", text: "1/3 succeeded" }],
      details: {
        kind: "pi-subagent",
        failed: true,
        results: [
          {
            agent: "scout",
            prompt: "A",
            exitCode: 0,
            messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
          },
          {
            agent: "worker",
            prompt: "B",
            exitCode: 1,
            processError: true,
            errorMessage: "child crashed",
            messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }],
          },
          {
            agent: "reviewer",
            prompt: "C",
            exitCode: 130,
            stopReason: "aborted",
            errorMessage: "Subagent was aborted.",
            messages: [],
          },
        ],
      },
    }, true);

    expect(completed.state).toBe("failed");
    expect(completed.subagent).toMatchObject({
      total: 3,
      completed: 1,
      running: 0,
      failed: 1,
      results: [
        { agent: "scout", state: "completed", output: "ok" },
        { agent: "worker", state: "failed", output: "partial", error: "child crashed" },
        { agent: "reviewer", state: "cancelled", error: "Subagent was aborted." },
      ],
    });
  });

  it("replays persisted history details onto the tool call", () => {
    const items = projectHistory([
      {
        type: "message",
        id: "call",
        timestamp: "2026-08-09T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "sa-1", name: "subagent", arguments: { calls: [{ agent: "scout", prompt: "Find auth" }] } }],
        },
      },
      {
        type: "message",
        id: "result",
        timestamp: "2026-08-09T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "sa-1",
          toolName: "subagent",
          isError: true,
          content: [{ type: "text", text: "0/1 succeeded\n[1: scout] failed: boom" }],
          details: {
            kind: "pi-subagent",
            failed: true,
            projectAgentsDir: "/secret/agents",
            results: [{
              agent: "scout",
              prompt: "Find auth",
              agentSource: "user",
              exitCode: 1,
              errorMessage: "boom",
              processError: true,
              stderr: "lots of stderr",
              messages: childMessages,
            }],
          },
        },
      },
    ]);

    const tool = items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      id: "sa-1",
      name: "subagent",
      state: "failed",
      subagent: {
        kind: "pi-subagent",
        total: 1,
        failed: 1,
        results: [{ agent: "scout", state: "failed", error: "boom", output: "Auth lives in auth-service." }],
      },
    });
    expect(JSON.stringify(tool)).not.toContain("projectAgentsDir");
    expect(JSON.stringify(tool)).not.toContain("lots of stderr");
  });

  it("keeps args-seeded agents when details.results is empty", () => {
    const running = toolFromCall("sa-3", "subagent", {
      calls: [{ agent: "scout", prompt: "Find auth" }],
    }, "2026-08-09T00:00:00.000Z", "running");
    const failed = toolWithResult(running, {
      content: [{ type: "text", text: "Invalid subagent parameters: missing calls array." }],
      details: { kind: "pi-subagent", results: [], failed: true, projectAgentsDir: null },
    }, true);

    expect(failed.state).toBe("failed");
    expect(failed.subagent).toMatchObject({
      total: 1,
      running: 0,
      failed: 1,
      results: [{ agent: "scout", prompt: "Find auth", state: "failed", error: "Invalid subagent parameters: missing calls array." }],
    });
  });

  it("does not attach snapshots to unrelated tools", () => {
    const running = toolFromCall("bash-1", "bash", { command: "npm test" }, "2026-08-09T00:00:00.000Z", "running");
    const completed = toolWithResult(running, {
      content: [{ type: "text", text: "ok" }],
      details: { kind: "pi-subagent", results: [{ agent: "scout", prompt: "nope", exitCode: 0, messages: [] }] },
    }, false);
    expect(completed).not.toHaveProperty("subagent");
  });
});
