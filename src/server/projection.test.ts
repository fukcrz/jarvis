import { describe, expect, it } from "vitest";
import { projectHistory, toolFromCall, toolWithResult } from "./projection.js";

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
