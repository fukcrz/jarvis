import { describe, expect, it } from "vitest";
import { projectHistory } from "./projection.js";

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
