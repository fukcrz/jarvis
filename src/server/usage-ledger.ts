import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Workspace } from "../shared/protocol.js";
import { isRecord } from "../shared/protocol.js";
import type { UsageBucket, UsageRange, UsageStats } from "../shared/usage.js";
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
export async function collectUsageStats(workspaces: readonly Workspace[], range: UsageRange, now = Date.now(), home = jarvisHome()): Promise<UsageStats> {
  const since = rangeStart(range, now);
  const labels = new Map(workspaces.map((workspace) => [workspace.id, workspace.label]));
  const samples = (await readLedger(home)).filter((sample) => since === 0 || sample.at >= since);
  return {
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
    byDay: groupBy(samples, (sample) => new Date(sample.at).toISOString().slice(0, 10)).map(([day, bucket]) => ({ day, ...bucket })).sort((a, b) => a.day < b.day ? -1 : 1),
    byWorkspace: groupBy(samples, (sample) => sample.workspaceId).map(([workspaceId, bucket]) => ({ workspaceId, label: labels.get(workspaceId) ?? workspaceId, ...bucket })),
  };
}

export function parseUsageRange(value: unknown): UsageRange {
  return value === "7d" || value === "30d" || value === "90d" || value === "all" ? value : "30d";
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

function rangeStart(range: UsageRange, now: number): number {
  if (range === "all") return 0;
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return now - days * 24 * 60 * 60 * 1000;
}

function groupBy(samples: readonly UsageSample[], keyOf: (sample: UsageSample) => string): [string, UsageBucket][] {
  const groups = new Map<string, UsageBucket>();
  for (const sample of samples) {
    const key = keyOf(sample);
    const bucket = groups.get(key) ?? EMPTY_BUCKET();
    addBucket(bucket, sample.bucket);
    groups.set(key, bucket);
  }
  return [...groups.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1));
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

function sumBuckets(buckets: readonly UsageBucket[]): UsageBucket {
  const total = EMPTY_BUCKET();
  for (const bucket of buckets) addBucket(total, bucket);
  return total;
}
