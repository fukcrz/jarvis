import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Workspace } from "../shared/protocol.js";
import { isRecord } from "../shared/protocol.js";
import type { UsageBucket, UsageDayRow, UsageRange, UsageStats } from "../shared/usage.js";
import { isMissingFile } from "./fs.js";
import { jarvisHome } from "./jarvis-home.js";

/**
 * One provider-reported model call, recorded outside the session file so it
 * survives session cleanup. `reasoning` is already included in `output`.
 */
export interface UsageRecord {
  at: string;
  workspaceId: string;
  sessionId: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

const FILE_NAME = "usage.jsonl";
/** Roll the file once it passes this size. Reads still cover every part. */
const ROLL_BYTES = 32 * 1024 * 1024;

export function usageLedgerPath(home = jarvisHome()): string {
  return join(home, FILE_NAME);
}

export class UsageLedger {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path = usageLedgerPath()) {}

  /** Append one call. Failures are reported by the returned promise; never throws synchronously. */
  record(entry: UsageRecord): Promise<void> {
    const run = this.chain.then(() => this.append(entry));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async append(entry: UsageRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const size = await stat(this.path).then((info) => info.size, (error: unknown) => isMissingFile(error) ? 0 : Promise.reject(error));
    if (size > ROLL_BYTES) await rename(this.path, `${this.path}.${String(Date.now())}`);
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

interface UsageSample {
  at: number;
  workspaceId: string;
  sessionId: string;
  provider: string;
  model: string;
  bucket: UsageBucket;
}

const EMPTY_BUCKET = (): UsageBucket => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0, pricedCalls: 0 });

/** Sum the ledger. Session files are not read; deleted sessions stay in the totals. */
export async function collectUsageStats(workspaces: readonly Workspace[], range: UsageRange, now = Date.now(), home = jarvisHome(), workspaceId?: string): Promise<UsageStats> {
  const { since, until } = rangeBounds(range, now);
  const labels = new Map(workspaces.map((workspace) => [workspace.id, workspace.label]));
  const all = (await readLedger(home)).filter((sample) => (since === 0 || sample.at >= since) && (until === undefined || sample.at < until));
  const knownWorkspaces = groupBy(all, (sample) => sample.workspaceId).map(([id, bucket]) => ({ workspaceId: id, label: labels.get(id) ?? id, ...bucket }));
  const selected = workspaceId === undefined || workspaceId === "" ? undefined : workspaceId;
  const samples = selected === undefined ? all : all.filter((sample) => sample.workspaceId === selected);
  return {
    ...(selected === undefined ? {} : { workspaceId: selected }),
    generatedAt: new Date(now).toISOString(),
    range,
    sessions: new Set(samples.map((sample) => `${sample.workspaceId}/${sample.sessionId}`)).size,
    unreadable: 0,
    totals: sumBuckets(samples.map((sample) => sample.bucket)),
    byProvider: groupBy(samples, (sample) => sample.provider).map(([provider, bucket]) => ({ provider, ...bucket })),
    byModel: groupBy(samples, (sample) => `${sample.provider}\u0000${sample.model}`).map(([key, bucket]) => {
      const split = key.indexOf("\u0000");
      return { provider: key.slice(0, split), model: key.slice(split + 1), ...bucket };
    }),
    byDay: daysOf(samples),
    byWorkspace: knownWorkspaces,
  };
}

export function parseUsageRange(value: unknown): UsageRange {
  return value === "today" || value === "thisWeek" || value === "thisMonth" || value === "lastWeek" || value === "lastMonth" || value === "thisYear" || value === "all" ? value : "thisMonth";
}

/** A call worth keeping. Empty usage is dropped. */
export function usageRecordFrom(source: { at: string; workspaceId: string; sessionId: string; provider: string; model: string; usage: unknown }): UsageRecord | undefined {
  const bucket = bucketFromUsage(source.usage);
  if (bucket === undefined) return undefined;
  return {
    at: source.at,
    workspaceId: source.workspaceId,
    sessionId: source.sessionId,
    provider: source.provider.trim() === "" ? "unknown" : source.provider,
    model: source.model.trim() === "" ? "unknown" : source.model,
    input: bucket.input,
    output: bucket.output,
    cacheRead: bucket.cacheRead,
    cacheWrite: bucket.cacheWrite,
    reasoning: bucket.reasoning,
    cost: bucket.cost,
  };
}

function bucketFromUsage(value: unknown): UsageBucket | undefined {
  if (!isRecord(value)) return undefined;
  const input = finite(value["input"]);
  const output = finite(value["output"]);
  const cacheRead = finite(value["cacheRead"]);
  const cacheWrite = finite(value["cacheWrite"]);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const cost = costOf(value["cost"]);
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0 && cost === 0) return undefined;
  const reasoning = finite(value["reasoning"]) ?? 0;
  return { calls: 1, input, output, cacheRead, cacheWrite, reasoning, total, cost, pricedCalls: cost > 0 ? 1 : 0 };
}

function costOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (!isRecord(value)) return 0;
  const total = value["total"];
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function readLedger(home: string): Promise<UsageSample[]> {
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(home).catch(() => [] as string[])).filter((name) => name === FILE_NAME || name.startsWith(`${FILE_NAME}.`)).sort();
  const samples: UsageSample[] = [];
  for (const name of names) {
    const stream = createReadStream(join(home, name), { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const sample = sampleFrom(parsed);
        if (sample !== undefined) samples.push(sample);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return samples;
}

function sampleFrom(value: unknown): UsageSample | undefined {
  if (!isRecord(value)) return undefined;
  const at = typeof value["at"] === "string" ? Date.parse(value["at"]) : Number.NaN;
  const workspaceId = typeof value["workspaceId"] === "string" ? value["workspaceId"] : "";
  const provider = typeof value["provider"] === "string" ? value["provider"] : "";
  const model = typeof value["model"] === "string" ? value["model"] : "";
  const bucket = bucketFromUsage(value);
  const sessionId = typeof value["sessionId"] === "string" ? value["sessionId"] : "";
  if (!Number.isFinite(at) || workspaceId === "" || bucket === undefined) return undefined;
  return { at, workspaceId, sessionId, provider, model, bucket };
}

function rangeBounds(range: UsageRange, now: number): { since: number; until?: number } {
  if (range === "all") return { since: 0 };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "today") return { since: start.getTime(), until: addDays(start, 1).getTime() };
  if (range === "thisWeek" || range === "lastWeek") {
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset + (range === "lastWeek" ? -7 : 0));
    return { since: start.getTime(), until: addDays(start, 7).getTime() };
  }
  if (range === "thisMonth" || range === "lastMonth") {
    start.setDate(1);
    start.setMonth(start.getMonth() + (range === "lastMonth" ? -1 : 0));
    return { since: start.getTime(), until: addMonths(start, 1).getTime() };
  }
  start.setMonth(0, 1);
  return { since: start.getTime(), until: addYears(start, 1).getTime() };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

function groupBy(samples: readonly UsageSample[], keyOf: (sample: UsageSample) => string): [string, UsageBucket][] {
  const groups = new Map<string, UsageBucket>();
  for (const sample of samples) {
    const key = keyOf(sample);
    const bucket = groups.get(key) ?? EMPTY_BUCKET();
    addBucket(bucket, sample.bucket);
    groups.set(key, bucket);
  }
  return [...groups.entries()].sort((a, b) => b[1].total - a[1].total || b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : 1));
}

function addBucket(target: UsageBucket, source: UsageBucket): void {
  target.calls += source.calls;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
  target.total += source.total;
  target.cost += source.cost;
  target.pricedCalls += source.pricedCalls;
}

/** One row per day, newest first. The named source is whoever used the most tokens. */
function daysOf(samples: readonly UsageSample[]): UsageDayRow[] {
  const days = new Map<string, { bucket: UsageBucket; providers: Map<string, UsageBucket> }>();
  for (const sample of samples) {
    const day = new Date(sample.at).toISOString().slice(0, 10);
    const entry = days.get(day) ?? { bucket: EMPTY_BUCKET(), providers: new Map<string, UsageBucket>() };
    addBucket(entry.bucket, sample.bucket);
    const provider = entry.providers.get(sample.provider) ?? EMPTY_BUCKET();
    addBucket(provider, sample.bucket);
    entry.providers.set(sample.provider, provider);
    days.set(day, entry);
  }
  return [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, entry]) => {
    const ranked = [...entry.providers.entries()].sort((a, b) => b[1].total - a[1].total || b[1].calls - a[1].calls);
    const top = ranked.find(([provider]) => provider !== "unknown" && provider !== "") ?? ranked[0];
    return { day, ...entry.bucket, ...(top === undefined ? {} : { topProvider: top[0] }), models: entry.providers.size };
  });
}

function sumBuckets(buckets: readonly UsageBucket[]): UsageBucket {
  const total = EMPTY_BUCKET();
  for (const bucket of buckets) addBucket(total, bucket);
  return total;
}
