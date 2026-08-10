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

  it("does not leak thinking content into the browser projection", () => {
    const items = projectHistory([{
      type: "message",
      id: "assistant-entry",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Visible answer" }] },
    }]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "message", text: "Visible answer" });
  });

  it("filters harness reasoning incorrectly persisted as a text part", () => {
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
});
