import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/protocol";
import { projectAttentionSession, readMobileExpandedGroups, saveMobileExpandedGroups, shouldShowMobileSessionGroup } from "./mobile-navigation.js";

const storage = new Map<string, string>();

const session: SessionSummary = {
  id: "session-1",
  workspaceId: "project-1",
  name: "Session",
  preview: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  runState: "idle",
};

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile session group visibility", () => {
  it("keeps empty projects visible in focus mode", () => {
    expect(shouldShowMobileSessionGroup(0, true)).toBe(true);
    expect(shouldShowMobileSessionGroup(0, false)).toBe(false);
    expect(shouldShowMobileSessionGroup(2, false)).toBe(true);
  });
});

describe("mobile project status", () => {
  it("omits the status for projects with only idle sessions", () => {
    expect(projectAttentionSession([session])).toBeUndefined();
  });

  it("selects the highest-priority attention state", () => {
    expect(projectAttentionSession([
      { ...session, id: "failed", attentionState: "failed" },
      { ...session, id: "waiting", attentionState: "waiting_interaction" },
      { ...session, id: "running", runState: "running" },
    ])?.id).toBe("waiting");
  });

  it("uses the most recently updated session when priority is tied", () => {
    expect(projectAttentionSession([
      { ...session, id: "old", attentionState: "failed", updatedAt: "2026-01-01T00:00:00.000Z" },
      { ...session, id: "new", attentionState: "failed", updatedAt: "2026-01-03T00:00:00.000Z" },
    ])?.id).toBe("new");
  });
});

describe("mobile session group expansion", () => {
  it("restores persisted group states", () => {
    saveMobileExpandedGroups({ projectA: true, projectB: false });

    expect(readMobileExpandedGroups()).toEqual({ projectA: true, projectB: false });
  });

  it("ignores malformed or invalid persisted state", () => {
    storage.set("jarvis.mobile.projects.expanded", '{"projectA":true,"projectB":"yes"}');
    expect(readMobileExpandedGroups()).toEqual({ projectA: true });

    storage.set("jarvis.mobile.projects.expanded", "invalid-json");
    expect(readMobileExpandedGroups()).toEqual({});
  });
});
