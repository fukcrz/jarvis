import { describe, expect, it } from "vitest";
import { formatRunElapsed, getRunFeedback } from "./run-feedback";

const running = {
  sessionId: "session",
  runState: "running" as const,
  activeRun: { id: "run", startedAt: "2026-08-09T00:00:00.000Z" },
};

describe("run feedback", () => {
  it("shows Pi-style working feedback before the first assistant delta", () => {
    expect(getRunFeedback(running, [])).toEqual({ label: "Working...", tone: "working", startedAt: running.activeRun.startedAt });
    expect(getRunFeedback(running, [], "assistant-message")).toBeUndefined();
  });

  it("describes pending tools and stopping runs", () => {
    expect(getRunFeedback(running, [{ kind: "tool", id: "tool", createdAt: "2026-08-09T00:00:01.000Z", name: "read", title: "Read file", state: "running" }])).toMatchObject({ label: "Running Read file", tone: "working" });
    expect(getRunFeedback({ ...running, runState: "stopping" }, [])).toMatchObject({ label: "Stopping...", tone: "stopping" });
  });

  it("formats an elapsed run duration", () => {
    expect(formatRunElapsed(running.activeRun.startedAt, Date.parse("2026-08-09T00:01:04.000Z"))).toBe("1:04");
    expect(formatRunElapsed(undefined)).toBeUndefined();
  });
});
