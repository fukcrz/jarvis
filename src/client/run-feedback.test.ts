import { describe, expect, it } from "vitest";
import type { SessionStatus, TimelineItem } from "../shared/protocol";
import { formatRunElapsed, getRunStatusActivity } from "./run-feedback";

const running = {
  sessionId: "session",
  runState: "running" as const,
  activeRun: { id: "run", startedAt: "2026-08-09T00:00:00.000Z" },
};

describe("run status", () => {
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
  it("reports every active phase and no status after the run is idle", () => {
    const retrying = { attempt: 1, maxAttempts: 3, delayMs: 1_000, retryAt: "2026-01-01T00:00:01.000Z", errorMessage: "temporary" };
    const hiddenQuestion = { kind: "tool", id: "question", createdAt: "", name: "ask_user_question", title: "Ask user", state: "running" } as const;
    expect(getRunStatusActivity(runningStatus, [{ kind: "thinking", id: "k", createdAt: "", state: "running", text: "" }] as unknown as TimelineItem[])?.label).toBe("思考中");
    expect(getRunStatusActivity(runningStatus, [], "m")?.label).toBe("正在回复");
    expect(getRunStatusActivity(runningStatus, [hiddenQuestion])).toEqual({ label: "执行中", target: "bottom" });
    expect(getRunStatusActivity(runningStatus, [])).toEqual({ label: "执行中", target: "bottom" });
    expect(getRunStatusActivity({ ...runningStatus, compacting: { reason: "manual", startedAt: "2026-01-01T00:00:00.000Z" } } as SessionStatus, [])?.label).toBe("正在压缩上下文");
    expect(getRunStatusActivity({ ...runningStatus, retrying } as SessionStatus, [])?.label).toBe("等待重试");
    expect(getRunStatusActivity({ ...runningStatus, runState: "stopping" } as SessionStatus, [])?.label).toBe("正在停止");
    expect(getRunStatusActivity({ ...runningStatus, runState: "idle" } as SessionStatus, [])).toBeUndefined();
  });
});
