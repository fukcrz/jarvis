import { cpus, freemem, loadavg, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const DEFAULT_EVENT_LOOP_RESOLUTION_MS = 10;

export function startTimer() {
  const startedAt = process.hrtime.bigint();
  let stoppedAt;

  const elapsed = () => {
    const end = stoppedAt ?? process.hrtime.bigint();
    return Number(end - startedAt) / NANOSECONDS_PER_MILLISECOND;
  };

  elapsed.stop = () => {
    stoppedAt ??= process.hrtime.bigint();
    return elapsed();
  };
  elapsed.startedAt = startedAt;
  return elapsed;
}

export function measure(callback, ...args) {
  assertCallback(callback);
  const timer = startTimer();
  const result = callback(...args);
  return { result, durationMs: timer() };
}

export async function measureAsync(callback, ...args) {
  assertCallback(callback);
  const timer = startTimer();
  const result = await callback(...args);
  return { result, durationMs: timer() };
}

export function percentile(values, percentileValue) {
  validatePercentile(percentileValue);
  return percentileFromSorted(finiteValues(values).sort((left, right) => left - right), percentileValue);
}

export function percentiles(values) {
  const sorted = finiteValues(values).sort((left, right) => left - right);
  return {
    p50: percentileFromSorted(sorted, 50),
    p95: percentileFromSorted(sorted, 95),
    p99: percentileFromSorted(sorted, 99),
  };
}

export function summary(values) {
  const samples = finiteValues(values);
  const count = samples.length;
  if (count === 0) {
    return {
      count: 0,
      min: undefined,
      max: undefined,
      mean: undefined,
      p50: undefined,
      p95: undefined,
      p99: undefined,
      total: 0,
    };
  }

  const total = samples.reduce((sum, value) => sum + value, 0);
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count,
    min: sorted[0],
    max: sorted.at(-1),
    mean: total / count,
    p50: percentileFromSorted(sorted, 50),
    p95: percentileFromSorted(sorted, 95),
    p99: percentileFromSorted(sorted, 99),
    total,
  };
}

export function createEventLoopDelayMonitor(options = {}) {
  const resolution = options.resolution ?? DEFAULT_EVENT_LOOP_RESOLUTION_MS;
  if (!Number.isInteger(resolution) || resolution < 1) {
    throw new RangeError("Event loop delay resolution must be a positive integer");
  }

  const histogram = monitorEventLoopDelay({ resolution });
  let running = false;

  const monitor = {
    start() {
      if (!running) {
        histogram.enable();
        running = true;
      }
      return monitor;
    },
    stop() {
      if (running) {
        histogram.disable();
        running = false;
      }
      return monitor.snapshot();
    },
    reset() {
      histogram.reset();
      return monitor;
    },
    snapshot() {
      return histogramSnapshot(histogram);
    },
    get running() {
      return running;
    },
  };

  return monitor;
}

export function processMetadata() {
  const cpuInfo = cpus();
  const memoryUsage = process.memoryUsage();
  return {
    nodeVersion: process.version,
    versions: { ...process.versions },
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    cpu: {
      count: cpuInfo.length,
      model: cpuInfo[0]?.model,
      speedMHz: cpuInfo[0]?.speed,
      loadAverage: loadavg(),
    },
    memory: {
      process: memoryUsage,
      system: {
        totalBytes: totalmem(),
        freeBytes: freemem(),
      },
    },
    uptimeSeconds: process.uptime(),
  };
}

export function environmentMetadata() {
  const envKeys = Object.keys(process.env).sort();
  return {
    cwd: process.cwd(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    envKeys,
    envCount: envKeys.length,
    hasCi: envKeys.includes("CI") && Boolean(process.env.CI),
    stdio: {
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      stderrIsTty: process.stderr.isTTY === true,
    },
  };
}

function assertCallback(callback) {
  if (typeof callback !== "function") throw new TypeError("A callback function is required");
}

function validatePercentile(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("Percentile must be between 0 and 100");
  }
}

function finiteValues(values) {
  if (values === undefined || values === null) return [];
  if (typeof values[Symbol.iterator] !== "function") throw new TypeError("Values must be iterable");
  return Array.from(values).filter((value) => Number.isFinite(value));
}

function percentileFromSorted(sorted, percentileValue) {
  if (sorted.length === 0) return undefined;
  const position = (sorted.length - 1) * (percentileValue / 100);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return undefined;
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function histogramSnapshot(histogram) {
  const count = histogram.count;
  if (count === 0) {
    return {
      count: 0,
      min: undefined,
      max: undefined,
      mean: undefined,
      p50: undefined,
      p95: undefined,
      p99: undefined,
    };
  }

  return {
    count,
    min: nanosecondsToMilliseconds(histogram.min),
    max: nanosecondsToMilliseconds(histogram.max),
    mean: nanosecondsToMilliseconds(histogram.mean),
    p50: nanosecondsToMilliseconds(histogram.percentile(50)),
    p95: nanosecondsToMilliseconds(histogram.percentile(95)),
    p99: nanosecondsToMilliseconds(histogram.percentile(99)),
  };
}

function nanosecondsToMilliseconds(value) {
  return Number.isFinite(value) ? value / NANOSECONDS_PER_MILLISECOND : undefined;
}
