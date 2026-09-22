import { describe, expect, it } from "vitest";
import type { TimelineItem } from "./protocol.js";
import { appendUserMessageOutline, earlierPageLimit, userMessageOutline, userMessagePreview } from "./user-message.js";

describe("userMessagePreview", () => {
  it("collapses whitespace and truncates long text", () => {
    const longText = "A".repeat(120);
    expect(userMessagePreview({ text: `  first\n  ${longText}` })).toBe(`first ${"A".repeat(101)}…`);
  });

  it("labels image-only and empty messages", () => {
    expect(userMessagePreview({ text: "  ", images: [{ mimeType: "image/png" }] })).toBe("图片消息");
    expect(userMessagePreview({ text: "" })).toBe("空消息");
  });
});

describe("userMessageOutline", () => {
  it("keeps user messages with session-absolute item indexes", () => {
    const items: TimelineItem[] = [
      { kind: "message", id: "a", role: "assistant", createdAt: "", text: "answer" },
      { kind: "message", id: "u", role: "user", createdAt: "", text: "first" },
      { kind: "tool", id: "t", createdAt: "", name: "read", title: "Read", state: "completed" },
      { kind: "message", id: "u2", role: "user", createdAt: "", text: "second" },
    ];
    expect(userMessageOutline(items)).toEqual([
      { id: "u", preview: "first", itemIndex: 1 },
      { id: "u2", preview: "second", itemIndex: 3 },
    ]);
  });
});

describe("appendUserMessageOutline", () => {
  it("appends unseen user messages and ignores duplicates", () => {
    const first = appendUserMessageOutline([], { id: "u1", text: "hi" }, 4);
    expect(first).toEqual([{ id: "u1", preview: "hi", itemIndex: 4 }]);
    expect(appendUserMessageOutline(first, { id: "u1", text: "hi" }, 9)).toBe(first);
  });
});

describe("earlierPageLimit", () => {
  it("loads from the target item to the current start, capped at 500", () => {
    expect(earlierPageLimit(40, 0)).toBe(40);
    expect(earlierPageLimit(800, 0)).toBe(500);
    expect(earlierPageLimit(40)).toBe(120);
    expect(earlierPageLimit(40, 40)).toBe(120);
  });
});
