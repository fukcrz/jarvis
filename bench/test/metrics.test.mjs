import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { createEventLoopDelayMonitor, environmentMetadata, measure, measureAsync, percentile, percentiles, processMetadata, startTimer, summary } from "../lib/metrics.mjs";

describe("metrics", () => {
  it("measures synchronous and asynchronous callbacks in milliseconds", async () => {
    const timer = startTimer();
    await delay(1);
    assert.ok(timer() >= 0);
    assert.ok(timer.stop() >= timer());

    const sync = measure(() => 42);
    assert.equal(sync.result, 42);
    assert.ok(Number.isFinite(sync.durationMs));
    assert.ok(sync.durationMs >= 0);

    const asyncResult = await measureAsync(async () => {
      await delay(1);
      return "done";
    });
    assert.equal(asyncResult.result, "done");
    assert.ok(asyncResult.durationMs >= 0);
  });

  it("calculates interpolated percentiles without mutating samples", () => {
    const samples = [4, 1, 3, 2, Number.NaN, Number.POSITIVE_INFINITY];
    assert.equal(percentile(samples, 0), 1);
    assert.equal(percentile(samples, 50), 2.5);
    assert.equal(percentile(samples, 100), 4);
    const distribution = percentiles(samples);
    assert.equal(distribution.p50, 2.5);
    assert.ok(Math.abs(distribution.p95 - 3.85) < 1e-12);
    assert.ok(Math.abs(distribution.p99 - 3.97) < 1e-12);
    assert.deepEqual(samples, [4, 1, 3, 2, Number.NaN, Number.POSITIVE_INFINITY]);
    assert.equal(percentile([], 50), undefined);
    assert.equal(percentile([Number.NaN], 50), undefined);
    assert.throws(() => percentile([1], -1), RangeError);
  });

  it("summarizes finite samples", () => {
    assert.deepEqual(summary([1, 2, Number.NaN, Number.NEGATIVE_INFINITY, 3]), {
      count: 3,
      min: 1,
      max: 3,
      mean: 2,
      p50: 2,
      p95: 2.9,
      p99: 2.98,
      total: 6,
    });

    const empty = summary([]);
    assert.equal(empty.count, 0);
    assert.equal(empty.total, 0);
    assert.equal(empty.mean, undefined);
    assert.equal(empty.p99, undefined);
  });

  it("samples event loop delay and can reset the histogram", async () => {
    const monitor = createEventLoopDelayMonitor({ resolution: 1 });
    assert.equal(monitor.running, false);
    monitor.start();
    assert.equal(monitor.running, true);
    await delay(10);
    const stopped = monitor.stop();
    assert.equal(monitor.running, false);
    assert.ok(Number.isInteger(stopped.count));
    for (const key of ["min", "max", "mean", "p50", "p95", "p99"]) {
      if (stopped[key] !== undefined) assert.ok(Number.isFinite(stopped[key]));
    }
    monitor.reset();
    assert.equal(monitor.snapshot().count, 0);
  });

  it("exposes process and environment metadata without environment values", () => {
    const processInfo = processMetadata();
    assert.equal(processInfo.pid, process.pid);
    assert.equal(processInfo.execPath, process.execPath);
    assert.equal(processInfo.cwd, process.cwd());
    assert.equal(processInfo.nodeVersion, process.version);
    assert.equal(processInfo.platform, process.platform);
    assert.equal(processInfo.arch, process.arch);
    assert.ok(Number.isInteger(processInfo.cpu.count));
    assert.ok(Number.isFinite(processInfo.memory.process.rss));

    const environment = environmentMetadata();
    assert.ok(Array.isArray(environment.envKeys));
    assert.equal(environment.envCount, environment.envKeys.length);
    assert.equal(Object.hasOwn(environment, "env"), false);
    assert.equal(Object.hasOwn(environment, "NODE_ENV"), false);
    assert.equal(typeof environment.hasCi, "boolean");
  });
});
