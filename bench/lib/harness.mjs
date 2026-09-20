import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { basename, join, resolve } from "node:path";
import { createFixtures, PROFILES } from "./fixtures.mjs";
import {
  createEventLoopDelayMonitor,
  environmentMetadata,
  processMetadata,
  summary,
} from "./metrics.mjs";

const ENVIRONMENT_KEYS = [
  "JARVIS_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "NODE_ENV",
  "PORT",
  "HOST",
];

export function parseArgs(argv = process.argv.slice(2)) {
  const values = { profile: "quick", out: undefined, iterations: undefined, warmup: undefined, headful: false, cpuThrottle: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { ...values, help: true };
    if (argument === "--headful") {
      values.headful = true;
      continue;
    }
    const [key, inlineValue] = argument.split("=", 2);
    const next = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && next !== undefined && !next.startsWith("-")) index += 1;
    if (key === "--profile") values.profile = next ?? values.profile;
    else if (key === "--out") values.out = next;
    else if (key === "--iterations") values.iterations = positiveInteger(next, "iterations");
    else if (key === "--warmup") values.warmup = nonNegativeInteger(next, "warmup");
    else if (key === "--cpu-throttle") values.cpuThrottle = positiveNumber(next, "cpu-throttle");
    else if (key.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Object.hasOwn(PROFILES, values.profile)) throw new Error(`Unknown profile: ${values.profile}`);
  return values;
}

export function printHelp(command, description, lines = []) {
  console.log(`Usage: npm run ${command} -- [options]`);
  console.log(description);
  console.log("");
  console.log("Options:");
  console.log("  --profile quick|standard|stress");
  console.log("  --out <directory>     output directory");
  console.log("  --iterations <count>  measured samples");
  console.log("  --warmup <count>      ignored warmup samples");
  for (const line of lines) console.log(`  ${line}`);
}

export async function createBenchmarkEnvironment(options = {}) {
  const fixtures = await createFixtures({
    profile: options.profile ?? "quick",
    richContent: options.richContent === true,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.turnsPerSession === undefined ? {} : { turnsPerSession: options.turnsPerSession }),
    ...(options.toolsPerTurn === undefined ? {} : { toolsPerTurn: options.toolsPerTurn }),
    ...(options.workspaceFiles === undefined ? {} : { workspaceFiles: options.workspaceFiles }),
    ...(options.wsEvents === undefined ? {} : { wsEvents: options.wsEvents }),
    ...(options.wsSubscribers === undefined ? {} : { wsSubscribers: options.wsSubscribers }),
  });
  const jarvisHome = join(fixtures.rootPath, "jarvis-home");
  const agentDir = join(fixtures.rootPath, "agent");
  const previous = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  let app;
  let baseUrl;
  try {
    await mkdir(jarvisHome, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeWorkspaceRegistry(jarvisHome, fixtures);
    process.env.JARVIS_HOME = jarvisHome;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = fixtures.sessionDir;
    process.env.NODE_ENV = "production";
    process.env.HOST = "127.0.0.1";
    delete process.env.PORT;

    const appModule = await importAppModule();
    app = await appModule.buildApp({
      serveStatic: options.serveStatic === true,
      staticRoot: resolve(process.cwd(), "dist/client"),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const actual = typeof address === "string" ? new URL(address) : undefined;
    if (actual === undefined) throw new Error("Benchmark server did not return a URL");
    baseUrl = actual.origin;
  } catch (error) {
    await fixtures.cleanup();
    restoreEnvironment(previous);
    throw error;
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await app.close();
    } finally {
      restoreEnvironment(previous);
      await fixtures.cleanup();
    }
  };

  return {
    app,
    baseUrl,
    fixtures,
    jarvisHome,
    agentDir,
    close,
    url(path) {
      return new URL(path, `${baseUrl}/`).toString();
    },
  };
}

export async function runSamples(options) {
  const warmup = options.warmup ?? defaultWarmup(options.profile ?? "quick");
  const iterations = options.iterations ?? defaultIterations(options.profile ?? "quick");
  const warmupErrors = [];
  for (let index = 0; index < warmup; index += 1) {
    try {
      await options.sample(index, true);
    } catch (error) {
      warmupErrors.push(errorMessage(error));
    }
  }

  const monitor = createEventLoopDelayMonitor({ resolution: 10 });
  monitor.reset().start();
  const samples = [];
  const errors = [];
  const before = process.memoryUsage();
  const startedAt = new Date().toISOString();
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    try {
      const value = await options.sample(index, false);
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      samples.push({ durationMs, ...(value === undefined ? {} : value) });
    } catch (error) {
      errors.push({ index, message: errorMessage(error) });
    }
  }
  const eventLoopDelay = monitor.stop();
  const after = process.memoryUsage();
  if (samples.length === 0) {
    const details = errors.slice(0, 3).map((entry) => `[${String(entry.index)}] ${entry.message}`).join("; ");
    throw new Error(`${options.name}: no successful measured samples (${String(errors.length)} errors)${details === "" ? "" : `: ${details}`}`);
  }
  return {
    name: options.name,
    description: options.description,
    iterations,
    warmup,
    warmupErrors,
    samples,
    errors,
    metrics: summary(samples.map((sample) => sample.durationMs)),
    eventLoopDelay,
    memory: memoryDelta(before, after),
    startedAt,
    endedAt: new Date().toISOString(),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

export async function writeBenchmarkReport(input) {
  const runId = input.runId ?? `${input.kind}-${input.profile}-${timestampId()}`;
  const outputDir = resolve(input.out ?? join(process.cwd(), ".tmp", "benchmarks", runId));
  await mkdir(join(outputDir, "raw"), { recursive: true });
  const summaryFile = join(outputDir, "summary.json");
  const reportFile = join(outputDir, "report.md");
  const result = {
    schemaVersion: 1,
    runId,
    kind: input.kind,
    profile: input.profile,
    startedAt: input.startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    environment: {
      process: processMetadata(),
      runtime: environmentMetadata(),
    },
    fixture: input.fixture,
    scenarios: input.scenarios,
    notes: input.notes ?? [],
  };
  await writeFile(summaryFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(reportFile, renderMarkdown(result), "utf8");
  return { ...result, outputDir, summaryFile, reportFile };
}

export function defaultIterations(profile) {
  return profile === "stress" ? 80 : profile === "standard" ? 40 : 15;
}

export function defaultWarmup(profile) {
  return profile === "stress" ? 8 : profile === "standard" ? 5 : 3;
}

export function fixtureReport(fixtures) {
  return {
    profile: fixtures.profile,
    profileConfig: fixtures.profileConfig,
    workspacePath: fixtures.workspacePath,
    sessionDir: fixtures.sessionDir,
    workspaceId: fixtures.workspaceId,
    sessionRefs: fixtures.sessionRefs,
    counts: fixtures.fixtureCounts,
  };
}

function restoreEnvironment(previous) {
  for (const key of ENVIRONMENT_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function writeWorkspaceRegistry(jarvisHome, fixtures) {
  const now = new Date().toISOString();
  const workspace = {
    id: fixtures.workspaceId,
    cwd: fixtures.workspacePath,
    label: "Benchmark workspace",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  await writeFile(join(jarvisHome, "workspaces.json"), `${JSON.stringify({ version: 1, workspaces: [workspace] }, null, 2)}\n`, "utf8");
}

async function importAppModule() {
  const distPath = resolve(process.cwd(), "dist/server/server/app.js");
  const sourcePath = resolve(process.cwd(), "src/server/app.ts");
  const selected = existsSync(distPath) ? distPath : sourcePath;
  try {
    return await import(pathToFileURL(selected).href);
  } catch (error) {
    const hint = existsSync(distPath) ? "The built server module could not be loaded." : "Run npm run build first, or invoke the runner through tsx.";
    throw new Error(`${hint} ${errorMessage(error)}`, { cause: error });
  }
}

function memoryDelta(before, after) {
  return {
    before,
    after,
    delta: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)])),
  };
}

function renderMarkdown(result) {
  const lines = [
    `# ${result.kind} benchmark`,
    "",
    `- Profile: \`${result.profile}\``,
    `- Run: \`${result.runId}\``,
    `- Started: ${result.startedAt}`,
    `- Ended: ${result.endedAt}`,
    "",
    "## Fixture",
    "",
    "```json",
    JSON.stringify(result.fixture?.counts ?? result.fixture ?? {}, null, 2),
    "```",
    "",
    "## Scenarios",
    "",
    "| Scenario | Samples | p50 ms | p95 ms | p99 ms | Errors | RSS delta |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of result.scenarios ?? []) {
    const metrics = scenario.metrics ?? {};
    const rss = scenario.memory?.delta?.rss;
    lines.push(`| ${scenario.name} | ${metrics.count ?? 0} | ${formatNumber(metrics.p50)} | ${formatNumber(metrics.p95)} | ${formatNumber(metrics.p99)} | ${scenario.errors?.length ?? 0} | ${formatNumber(rss)} |`);
  }
  lines.push("", "## Details", "");
  for (const scenario of result.scenarios ?? []) {
    lines.push(`### ${scenario.name}`, "", scenario.description ?? "", "", "```json", JSON.stringify({ metrics: scenario.metrics, eventLoopDelay: scenario.eventLoopDelay, metadata: scenario.metadata, errors: scenario.errors }, null, 2), "```", "");
  }
  if ((result.notes ?? []).length > 0) lines.push("## Notes", "", ...result.notes.map((note) => `- ${note}`), "");
  return `${lines.join("\n")}\n`;
}

function formatNumber(value) {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(3);
}

function timestampId() {
  return new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
}

function positiveInteger(value, name) {
  if (value === undefined || !/^\d+$/.test(String(value)) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value, name) {
  if (value === undefined || !/^\d+$/.test(String(value))) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive`);
  return number;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
