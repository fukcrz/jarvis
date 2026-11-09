import { describe, expect, it } from "vitest";
import type { SubagentThreadRow } from "../../shared/protocol";
import { subagentElapsed, subagentStatusLabel, subagentStatusLabelCompact, subagentThreadCounts } from "./subagents";

function row(path: string, state: SubagentThreadRow["state"]): SubagentThreadRow {
  return { path, type: "scout", state, line: "Reading" };
}

describe("subagent status line", () => {
  it("counts running and paused separately", () => {
    const threads = [row("/root/a", "running"), row("/root/b", "running"), row("/root/c", "paused")];
    expect(subagentThreadCounts(threads)).toEqual({ running: 2, paused: 1 });
    expect(subagentThreadCounts(undefined)).toEqual({ running: 0, paused: 0 });
  });

  it("reports only unfinished threads, never history", () => {
    expect(subagentStatusLabel(undefined)).toBeUndefined();
    expect(subagentStatusLabel([])).toBeUndefined();
    expect(subagentStatusLabel([row("/root/a", "running"), row("/root/b", "running")])).toBe("2 个子代理执行中");
    expect(subagentStatusLabel([row("/root/a", "running"), row("/root/c", "paused")])).toBe("1 个子代理执行中 · 1 已暂停");
    expect(subagentStatusLabel([row("/root/c", "paused")])).toBe("1 个子代理已暂停");
  });

  it("drops the noun on narrow screens", () => {
    expect(subagentStatusLabelCompact([row("/root/a", "running"), row("/root/c", "paused")])).toBe("2 执行中");
    expect(subagentStatusLabelCompact([row("/root/c", "paused")])).toBe("1 已暂停");
    expect(subagentStatusLabelCompact([])).toBeUndefined();
  });

  it("formats elapsed time from the run start", () => {
    expect(subagentElapsed({}, 0)).toBeUndefined();
    expect(subagentElapsed({ startedAt: "not-a-date" }, 0)).toBeUndefined();
    expect(subagentElapsed({ startedAt: "2026-01-01T00:00:00.000Z" }, Date.parse("2026-01-01T00:04:12.000Z"))).toBe("4:12");
    // paused 线程的时长已冻结，不跟着当前时间涨。
    expect(subagentElapsed({ elapsedMs: 41_000 }, Date.parse("2026-01-01T09:00:00.000Z"))).toBe("0:41");
  });
});
