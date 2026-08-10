import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../shared/protocol";
import { matchesSessionQuery, normalizeSessionSearch, sessionLabel } from "./utils";

const session: SessionSummary = {
  id: "session-1",
  workspaceId: "workspace-1",
  name: "Refactor Mobile Navigation",
  preview: "A preview",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  runState: "idle",
};

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
