import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_PRIMARY_METRICS = ["navigationMs", "switchMs", "switchBackMs", "historyPrependMs", "socketToDomMs", "inputToStableMs"];

export async function compareReports(beforePath, afterPath) {
  const [before, after] = await Promise.all([readJson(beforePath), readJson(afterPath)]);
  if (before.kind !== after.kind) throw new RangeError(`Cannot compare different benchmark kinds: ${String(before.kind)} and ${String(after.kind)}`);
  if (before.profile !== after.profile) throw new RangeError(`Cannot compare different benchmark profiles: ${String(before.profile)} and ${String(after.profile)}`);
  const beforeScenarios = new Map((before.scenarios ?? []).map((scenario) => [scenario.name, scenario]));
  const afterScenarios = new Map((after.scenarios ?? []).map((scenario) => [scenario.name, scenario]));
  const names = [...new Set([...beforeScenarios.keys(), ...afterScenarios.keys()])].sort();
  const scenarios = names.map((name) => compareScenario(name, beforeScenarios.get(name), afterScenarios.get(name)));
  return {
    schemaVersion: 1,
    kind: "benchmark-comparison",
    before: { path: resolve(beforePath), runId: before.runId, kind: before.kind, profile: before.profile },
    after: { path: resolve(afterPath), runId: after.runId, kind: after.kind, profile: after.profile },
    scenarios,
    summary: {
      added: scenarios.filter((scenario) => scenario.status === "added").length,
      removed: scenarios.filter((scenario) => scenario.status === "removed").length,
      compared: scenarios.filter((scenario) => scenario.status === "compared").length,
      regressionsP95: scenarios.filter((scenario) => (scenario.primary?.values?.p95?.delta ?? scenario.metrics?.p95?.delta) > 0).length,
      errorDelta: scenarios.reduce((total, scenario) => total + scenarioErrorDelta(scenario), 0),
    },
  };
}

function compareScenario(name, before, after) {
  if (before === undefined) return { name, status: "added", after: compactScenario(after) };
  if (after === undefined) return { name, status: "removed", before: compactScenario(before) };
  const beforePrimary = primaryMetric(before);
  const afterPrimary = primaryMetric(after);
  const comparablePrimary = beforePrimary.name === afterPrimary.name ? beforePrimary : { name: "durationMs", values: before.metrics ?? {} };
  const afterComparable = beforePrimary.name === afterPrimary.name ? afterPrimary : { name: "durationMs", values: after.metrics ?? {} };
  return {
    name,
    status: "compared",
    metrics: compareMetricGroup(before.metrics, after.metrics),
    primary: {
      before: comparablePrimary.name,
      after: afterComparable.name,
      values: compareMetricGroup(comparablePrimary.values, afterComparable.values),
    },
    errors: compareNumber(errorCount(before), errorCount(after)),
    browserErrors: compareNumber(before.frontend?.browserErrors?.length ?? 0, after.frontend?.browserErrors?.length ?? 0),
    rssDelta: compareNumber(before.memory?.delta?.rss, after.memory?.delta?.rss),
    eventLoopP95: compareNumber(before.eventLoopDelay?.p95, after.eventLoopDelay?.p95),
    metadata: { before: before.metadata ?? {}, after: after.metadata ?? {} },
  };
}

function primaryMetric(scenario) {
  const frontend = scenario.frontend ?? {};
  for (const name of FRONTEND_PRIMARY_METRICS) {
    if (Number.isFinite(frontend[name]?.p50)) return { name, values: frontend[name] };
  }
  return { name: "durationMs", values: scenario.metrics ?? {} };
}

function errorCount(scenario) {
  return (scenario.errors?.length ?? 0) + (scenario.frontend?.browserErrors?.length ?? 0);
}

function scenarioErrorDelta(scenario) {
  if (Number.isFinite(scenario.errors?.delta)) return scenario.errors.delta;
  if (scenario.status === "added") return scenario.after?.errors ?? 0;
  if (scenario.status === "removed") return -(scenario.before?.errors ?? 0);
  return 0;
}

function compareMetricGroup(before, after) {
  return Object.fromEntries(["p50", "p95", "p99", "mean", "min", "max", "total"].map((key) => [key, compareNumber(before?.[key], after?.[key])]));
}

function compareNumber(before, after) {
  const hasBefore = Number.isFinite(before);
  const hasAfter = Number.isFinite(after);
  if (!hasBefore || !hasAfter) return { before, after, delta: hasBefore || hasAfter ? (hasAfter ? after : -before) : undefined, percent: undefined };
  const delta = after - before;
  return { before, after, delta, percent: before === 0 ? undefined : delta / Math.abs(before) * 100 };
}

function compactScenario(scenario) {
  return {
    metrics: scenario.metrics,
    errors: errorCount(scenario),
    browserErrors: scenario.frontend?.browserErrors?.length ?? 0,
    metadata: scenario.metadata ?? {},
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

export function renderComparisonMarkdown(result) {
  const lines = [
    "# Benchmark comparison",
    "",
    `- Before: \`${result.before.kind}/${result.before.profile}\` (${result.before.runId ?? "unknown"})`,
    `- After: \`${result.after.kind}/${result.after.profile}\` (${result.after.runId ?? "unknown"})`,
    "",
    "## Scenarios",
    "",
    "| Scenario | Status | Primary metric | Primary p50 Δ | Primary p95 Δ | Primary p99 Δ | Error Δ | Browser errors Δ | RSS Δ | Event loop p95 Δ |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of result.scenarios) {
    const primary = scenario.primary?.values ?? scenario.metrics ?? {};
    lines.push(`| ${scenario.name} | ${scenario.status} | ${formatPrimaryMetric(scenario.primary)} | ${formatDelta(primary.p50)} | ${formatDelta(primary.p95)} | ${formatDelta(primary.p99)} | ${formatDelta(scenario.errors)} | ${formatDelta(scenario.browserErrors)} | ${formatDelta(scenario.rssDelta)} | ${formatDelta(scenario.eventLoopP95)} |`);
  }
  lines.push("", "## Summary", "", "```json", JSON.stringify(result.summary, null, 2), "```", "");
  return `${lines.join("\n")}\n`;
}

function formatPrimaryMetric(primary) {
  if (primary === undefined) return "-";
  return primary.before === primary.after ? primary.before : `${primary.before} -> ${primary.after}`;
}

function formatDelta(value) {
  if (value === undefined || !Number.isFinite(value.delta)) return "-";
  const percent = Number.isFinite(value.percent) ? ` (${value.percent >= 0 ? "+" : ""}${value.percent.toFixed(1)}%)` : "";
  return `${value.delta >= 0 ? "+" : ""}${value.delta.toFixed(3)}${percent}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positionals.length !== 2) {
    printUsage();
    if (!args.help) process.exitCode = 1;
    return;
  }
  const result = await compareReports(args.positionals[0], args.positionals[1]);
  const outputDir = resolve(args.out ?? joinDefaultOutput(args.positionals[1]));
  await mkdir(outputDir, { recursive: true });
  const jsonPath = resolve(outputDir, "comparison.json");
  const markdownPath = resolve(outputDir, "comparison.md");
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderComparisonMarkdown(result), "utf8");
  console.log(`Comparison complete: ${outputDir}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
}

function parseArgs(argv) {
  const positionals = [];
  let out;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--out") {
      out = argv[++index];
      continue;
    }
    if (argument.startsWith("--out=")) {
      out = argument.slice("--out=".length);
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    positionals.push(argument);
  }
  return { positionals, out, help };
}

function joinDefaultOutput(afterPath) {
  return resolve(projectRoot, ".tmp", "benchmarks", `compare-${basename(afterPath, ".json")}`);
}

function printUsage() {
  console.log("Usage: node bench/compare.mjs <before-summary.json> <after-summary.json> [options]");
  console.log("Options:");
  console.log("  --out <directory>  output directory");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
