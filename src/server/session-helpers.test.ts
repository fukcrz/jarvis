import { describe, expect, it } from "vitest";
import { clamp, isVisibleSessionId, mergeQueuedMessages, queuedMessage, snippetAround } from "./session-helpers.js";

describe("isVisibleSessionId", () => {
  it("hides pi-subagent child sessions", () => {
    expect(isVisibleSessionId("abc")).toBe(true);
    expect(isVisibleSessionId("subagent.abc")).toBe(false);
  });
});

describe("clamp", () => {
  it("floors and bounds finite numbers", () => {
    expect(clamp(3.9, 1, 5)).toBe(3);
    expect(clamp(0, 1, 5)).toBe(1);
    expect(clamp(9, 1, 5)).toBe(5);
    expect(clamp(Number.NaN, 1, 5)).toBe(5);
  });
});

describe("mergeQueuedMessages", () => {
  it("reuses matching entries to keep ids stable", () => {
    const first = queuedMessage("followUp", "hello");
    const merged = mergeQueuedMessages([first], ["hello", "world"], "followUp");
    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe(first.id);
    expect(merged[1]?.text).toBe("world");
    expect(merged[1]?.kind).toBe("followUp");
  });
});

describe("snippetAround", () => {
  it("returns undefined when the needle is missing", () => {
    expect(snippetAround("alpha beta", "zzz")).toBeUndefined();
  });
});
