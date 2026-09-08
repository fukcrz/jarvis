import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/protocol";
import { isSessionInFocusWindow, matchesSessionQuery, normalizeSessionSearch, parseBashCommand, sessionLabel, sessionListWindow, SESSION_FOCUS_WINDOW_MS, SESSIONS_COLLAPSED_LIMIT, SESSIONS_PAGE_SIZE } from "./utils";

const session: SessionSummary = {
  id: "session-1",
  workspaceId: "workspace-1",
  name: "Refactor Mobile Navigation",
  preview: "A preview",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  runState: "idle",
};

function idle(id: string): SessionSummary {
  return { ...session, id, name: id, updatedAt: `2026-01-0${String(Number(id.slice(-1)) + 1).padStart(2, "0")}T00:00:00.000Z` };
}

function running(id: string): SessionSummary {
  return { ...session, id, name: id, runState: "running" };
}

function stopping(id: string): SessionSummary {
  return { ...session, id, name: id, runState: "stopping" };
}

function ids(items: { id: string }[]): string[] {
  return items.map((item) => item.id);
}

describe("session search", () => {
  it("matches session titles case-insensitively and by substring", () => {
    expect(matchesSessionQuery(session, "mobile nav")).toBe(true);
    expect(matchesSessionQuery(session, "REFactor")).toBe(true);
    expect(matchesSessionQuery(session, "backend")).toBe(false);
  });

  it("normalizes unicode variants and whitespace", () => {
    expect(normalizeSessionSearch("  ＭＯＢＩＬＥ  ")).toBe("mobile");
    expect(matchesSessionQuery({ ...session, name: null, preview: "Fix   Mobile   UI" }, "mobile ui")).toBe(true);
  });

  it("uses the displayed fallback title when a session is unnamed", () => {
    expect(sessionLabel(null, "  First user message  ")).toBe("First user message");
    expect(matchesSessionQuery({ ...session, name: null, preview: "First user message" }, "FIRST")).toBe(true);
  });
});

describe("session list window", () => {
  it("shows at most the collapsed limit by default", () => {
    const items = Array.from({ length: 12 }, (_, index) => idle(`s-${index}`));
    const window = sessionListWindow(items, 0);
    expect(window.sessions).toHaveLength(SESSIONS_COLLAPSED_LIMIT);
    expect(ids(window.sessions)).toEqual(items.slice(0, SESSIONS_COLLAPSED_LIMIT).map((s) => s.id));
    expect(window.hasMore).toBe(true);
    expect(window.expanded).toBe(false);
  });

  it("keeps running sessions visible when they exceed the collapsed limit", () => {
    const runningItems = Array.from({ length: 7 }, (_, index) => running(`r-${index}`));
    const items = [...runningItems, ...Array.from({ length: 5 }, (_, index) => idle(`s-${index}`))];
    const window = sessionListWindow(items, 0);
    expect(window.sessions).toHaveLength(7);
    expect(ids(window.sessions)).toEqual(runningItems.map((s) => s.id));
    expect(window.hasMore).toBe(true);
  });

  it("pins running sessions to the front so they are always shown", () => {
    const items = [...Array.from({ length: 6 }, (_, index) => idle(`s-${index}`)), running("late-running")];
    const window = sessionListWindow(items, 0);
    expect(ids(window.sessions)).toEqual(["late-running", ...items.slice(0, 4).map((s) => s.id)]);
  });

  it("reveals one page per expand step until everything is shown", () => {
    const items = Array.from({ length: 14 }, (_, index) => idle(`s-${index}`));
    const first = sessionListWindow(items, 1);
    expect(first.sessions).toHaveLength(SESSIONS_COLLAPSED_LIMIT + SESSIONS_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(first.expanded).toBe(true);
    const second = sessionListWindow(items, 2);
    expect(second.sessions).toHaveLength(14);
    expect(second.hasMore).toBe(false);
  });

  it("collapsing returns to the default window", () => {
    const items = Array.from({ length: 9 }, (_, index) => idle(`s-${index}`));
    expect(sessionListWindow(items, 3).sessions).toHaveLength(9);
    const collapsed = sessionListWindow(items, 0);
    expect(collapsed.sessions).toHaveLength(SESSIONS_COLLAPSED_LIMIT);
    expect(collapsed.hasMore).toBe(true);
    expect(collapsed.expanded).toBe(false);
  });

  it("treats stopping sessions as running", () => {
    const items = [...Array.from({ length: 6 }, (_, index) => idle(`s-${index}`)), stopping("stopping-1")];
    const window = sessionListWindow(items, 0);
    expect(ids(window.sessions)).toEqual(["stopping-1", ...items.slice(0, 4).map((s) => s.id)]);
  });

  it("handles empty and small lists without extra buttons", () => {
    const empty = sessionListWindow([], 0);
    expect(empty.sessions).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.expanded).toBe(false);
    const small = sessionListWindow([idle("s-0")], 0);
    expect(small.sessions).toHaveLength(1);
    expect(small.hasMore).toBe(false);
  });
});

describe("session focus window", () => {
  const now = Date.parse("2026-02-03T12:00:00.000Z");

  it("keeps every attention state visible regardless of age", () => {
    const old = "2020-01-01T00:00:00.000Z";
    expect(isSessionInFocusWindow({ ...session, runState: "running", updatedAt: old }, now)).toBe(true);
    expect(isSessionInFocusWindow({ ...session, attentionState: "completed_unread", updatedAt: old }, now)).toBe(true);
    expect(isSessionInFocusWindow({ ...session, attentionState: "failed", updatedAt: old }, now)).toBe(true);
    expect(isSessionInFocusWindow({ ...session, attentionState: "waiting_interaction", updatedAt: old }, now)).toBe(true);
  });

  it("keeps ordinary sessions updated within the ten-minute boundary", () => {
    expect(isSessionInFocusWindow({ ...session, updatedAt: new Date(now - SESSION_FOCUS_WINDOW_MS).toISOString() }, now)).toBe(true);
    expect(isSessionInFocusWindow({ ...session, updatedAt: new Date(now - SESSION_FOCUS_WINDOW_MS - 1).toISOString() }, now)).toBe(false);
  });

  it("filters ordinary sessions with invalid, stale, or future activity times", () => {
    expect(isSessionInFocusWindow({ ...session, updatedAt: "not-a-date" }, now)).toBe(false);
    expect(isSessionInFocusWindow({ ...session, updatedAt: "2026-02-03T11:00:00.000Z" }, now)).toBe(false);
    expect(isSessionInFocusWindow({ ...session, updatedAt: "2026-02-03T12:01:00.000Z" }, now)).toBe(false);
  });
});

describe("bang command parsing", () => {
  it("parses !cmd with the output sent to the model", () => {
    expect(parseBashCommand("!npm test")).toEqual({ command: "npm test", excludeFromContext: false });
    expect(parseBashCommand("  !  ls -la")).toEqual({ command: "ls -la", excludeFromContext: false });
    expect(parseBashCommand("!echo multi\nline")).toEqual({ command: "echo multi\nline", excludeFromContext: false });
  });

  it("parses !!cmd as excluded from the model context", () => {
    expect(parseBashCommand("!!git status")).toEqual({ command: "git status", excludeFromContext: true });
    expect(parseBashCommand("!!  pwd")).toEqual({ command: "pwd", excludeFromContext: true });
  });

  it("treats non-bang text and a bare ! as a normal prompt", () => {
    expect(parseBashCommand("normal prompt")).toBeUndefined();
    expect(parseBashCommand("!")).toBeUndefined();
    expect(parseBashCommand("!!")).toBeUndefined();
  });
});
