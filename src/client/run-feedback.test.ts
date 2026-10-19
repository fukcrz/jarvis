import { describe, expect, it } from "vitest";
import type { SessionStatus, TimelineItem } from "../shared/protocol";
import { formatRunElapsed, getRunFeedback, getRunStatusActivity } from "./run-feedback";

const running = {
  sessionId: "session",
  runState: "running" as const,
  activeRun: { id: "run", startedAt: "2026-08-09T00:00:00.000Z" },
};

describe("run feedback", () => {
  it("keeps working feedback visible while an intermediate assistant reply streams", () => {
    expect(getRunFeedback(running, [])).toEqual({ label: "执行中…", tone: "working", startedAt: running.activeRun.startedAt });
    expect(getRunFeedback(running, [], "assistant-message")).toEqual({ label: "正在回复…", tone: "working", startedAt: running.activeRun.startedAt });
  });

  it("describes pending tools and stopping runs", () => {
    expect(getRunFeedback(running, [{ kind: "tool", id: "tool", createdAt: "2026-08-09T00:00:01.000Z", name: "read", title: "Read file", state: "running" }])).toMatchObject({ label: "执行中 Read file", tone: "working" });
    expect(getRunFeedback({ ...running, runState: "stopping" }, [])).toMatchObject({ label: "正在停止…", tone: "stopping" });
  });

  it("does not compete with retry or compaction feedback", () => {
    const retrying = { attempt: 1, maxAttempts: 3, delayMs: 1_000, retryAt: "2026-08-09T00:00:01.000Z", errorMessage: "temporary" };
    expect(getRunFeedback({ ...running, retrying }, [])).toBeUndefined();
    expect(getRunFeedback({ ...running, compacting: { reason: "manual", startedAt: running.activeRun.startedAt, retrying } }, [])).toBeUndefined();
  });

  it("formats an elapsed run duration", () => {
    expect(formatRunElapsed(running.activeRun.startedAt, Date.parse("2026-08-09T00:01:04.000Z"))).toBe("1:04");
    expect(formatRunElapsed(undefined)).toBeUndefined();
  });
});

describe("getRunStatusActivity", () => {
  const runningStatus = { runState: "running", activeRun: { startedAt: "2026-01-01T00:00:00.000Z" } } as unknown as SessionStatus;
  it("names the running command", () => {
    const items = [{ kind: "tool", id: "t", createdAt: "", name: "bash", title: "运行命令", state: "running", inputPreview: "npm test\nmore" }] as TimelineItem[];
    expect(getRunStatusActivity(runningStatus, items)).toEqual({ label: "正在执行：npm test", target: "tool" });
  });
  it("reports thinking, replying and idle", () => {
    expect(getRunStatusActivity(runningStatus, [{ kind: "thinking", id: "k", createdAt: "", state: "running", text: "" }] as unknown as TimelineItem[])?.label).toBe("思考中");
    expect(getRunStatusActivity(runningStatus, [], "m")?.label).toBe("正在回复");
    expect(getRunStatusActivity(runningStatus, [])?.label).toBe("处理中");
    expect(getRunStatusActivity({ ...runningStatus, runState: "idle" } as SessionStatus, [])).toBeUndefined();
  });
});
