import { describe, expect, it } from "vitest";
import { mergeQueuedMessagesIntoSideChatDrafts, sideChatDraftKey } from "./side-chat-draft";

describe("sideChatDraftKey", () => {
  it("keeps workspace and session identity in the cache key", () => {
    expect(sideChatDraftKey({ workspaceId: "workspace-a", sessionId: "session-a" })).toBe("workspace-a:session-a");
    expect(sideChatDraftKey({ workspaceId: "workspace-b", sessionId: "session-a" })).toBe("workspace-b:session-a");
  });
});

describe("mergeQueuedMessagesIntoSideChatDrafts", () => {
  it("merges into the target session without changing another session", () => {
    const other = { draft: "另一个草稿", attachments: [{ mimeType: "image/png", data: "other" }] };
    const current = new Map([
      ["workspace-a:session-a", { draft: "当前草稿", attachments: [{ mimeType: "image/jpeg", data: "current" }] }],
      ["workspace-b:session-a", other],
    ]);

    const next = mergeQueuedMessagesIntoSideChatDrafts(current, { workspaceId: "workspace-a", sessionId: "session-a" }, [{ text: "取回消息", images: [{ mimeType: "image/gif", data: "queued" }] }]);

    expect(next.get("workspace-a:session-a")).toEqual({
      draft: "取回消息\n\n当前草稿",
      attachments: [{ mimeType: "image/gif", data: "queued" }, { mimeType: "image/jpeg", data: "current" }],
    });
    expect(next.get("workspace-b:session-a")).toBe(other);
    expect(current.get("workspace-a:session-a")).toEqual({
      draft: "当前草稿",
      attachments: [{ mimeType: "image/jpeg", data: "current" }],
    });
  });
});
