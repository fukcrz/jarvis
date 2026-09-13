import { describe, expect, it } from "vitest";
import type { SessionSummary } from "./protocol.js";
import { compareSessionSummaries, sortSessionSummaries } from "./session-sort.js";

const base: SessionSummary = {
  id: "session-1",
  workspaceId: "workspace-1",
  name: "Session",
  preview: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-09T00:00:00.000Z",
  runState: "idle",
};

function ids(items: SessionSummary[]): string[] {
  return items.map((item) => item.id);
}

describe("session summary order", () => {
  it("keeps attention rank ahead of timestamps", () => {
    const ordered = sortSessionSummaries([
      { ...base, id: "completed", attentionState: "completed_unread", attentionAt: "2026-01-08T00:00:00.000Z" },
      { ...base, id: "waiting", attentionState: "waiting_interaction", attentionAt: "2026-01-02T00:00:00.000Z" },
      { ...base, id: "failed", attentionState: "failed", attentionAt: "2026-01-07T00:00:00.000Z" },
      { ...base, id: "running", runState: "running", attentionState: "running", attentionAt: "2026-01-03T00:00:00.000Z" },
      { ...base, id: "idle", lastUserMessageAt: "2026-01-09T00:00:00.000Z" },
      { ...base, id: "starred", starred: true, lastUserMessageAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(ids(ordered)).toEqual(["waiting", "running", "failed", "completed", "idle", "starred"]);
  });

  it("orders the same attention state by when that state was entered", () => {
    const ordered = sortSessionSummaries([
      { ...base, id: "old-failed", attentionState: "failed", attentionAt: "2026-01-02T00:00:00.000Z", lastUserMessageAt: "2026-01-08T00:00:00.000Z" },
      { ...base, id: "new-failed", attentionState: "failed", attentionAt: "2026-01-04T00:00:00.000Z", lastUserMessageAt: "2026-01-03T00:00:00.000Z" },
    ]);
    expect(ids(ordered)).toEqual(["new-failed", "old-failed"]);
  });

  it("ignores live updatedAt and uses last user send within a rank", () => {
    const ordered = sortSessionSummaries([
      { ...base, id: "older-send", lastUserMessageAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-09T00:00:00.000Z" },
      { ...base, id: "newer-send", lastUserMessageAt: "2026-01-04T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
    ]);
    expect(ids(ordered)).toEqual(["newer-send", "older-send"]);
  });

  it("falls back to createdAt, then keeps the original order", () => {
    expect(compareSessionSummaries(
      { ...base, id: "a", createdAt: "2026-01-02T00:00:00.000Z" },
      { ...base, id: "b", createdAt: "2026-01-01T00:00:00.000Z" },
    )).toBeLessThan(0);
    expect(ids(sortSessionSummaries([
      { ...base, id: "first", createdAt: "2026-01-01T00:00:00.000Z" },
      { ...base, id: "second", createdAt: "2026-01-01T00:00:00.000Z" },
    ]))).toEqual(["first", "second"]);
  });
});
