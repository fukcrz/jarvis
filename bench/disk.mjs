import { access, appendFile, constants, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  createBenchmarkEnvironment,
  fixtureReport,
  parseArgs,
  runSamples,
  writeBenchmarkReport,
} from "./lib/harness.mjs";
import { summary } from "./lib/metrics.mjs";
import { PROFILES } from "./lib/fixtures.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distServerPath = join(projectRoot, "dist", "server");
const distAppPath = join(distServerPath, "server", "app.js");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  await requireBuiltServer();
  process.chdir(projectRoot);
  process.env.LOG_LEVEL = "silent";

  const startedAt = new Date().toISOString();
  const environment = await createBenchmarkEnvironment({
    profile: args.profile,
    richContent: true,
  });

  try {
    assertIsolatedEnvironment(environment);
    const baseRoutes = routeSet(environment.fixtures);
    const fileScale = await measureFileScale(environment.fixtures);
    const scenarios = [];

    scenarios.push(await runSamples({
      name: "cold-session-list-rebuild-app",
      description: "Create isolated fixtures, rebuild the app, listen on an ephemeral port, and list sessions.",
      profile: args.profile,
      warmup: args.warmup,
      iterations: args.iterations,
      metadata: {
        lifecycle: "fresh createBenchmarkEnvironment per sample",
        endpoint: "GET /api/workspaces/:workspaceId/sessions",
        profileConfig: PROFILES[args.profile],
      },
      sample: () => measureColdSessionList(args.profile),
    }));

    const warmRoutes = [
      { name: "warm-session-list", path: baseRoutes.sessionList },
      { name: "timeline-40", path: `${baseRoutes.sessionPath}/timeline?limit=40` },
      { name: "timeline-500", path: `${baseRoutes.sessionPath}/timeline?limit=500` },
      { name: "runtime", path: `${baseRoutes.sessionPath}/runtime` },
      { name: "workspace-files-search", path: baseRoutes.workspaceFiles },
    ];

    for (const route of warmRoutes) {
      scenarios.push(await runSamples({
        name: route.name,
        description: `Warm app.inject GET ${route.path}`,
        profile: args.profile,
        warmup: args.warmup,
        iterations: args.iterations,
        metadata: {
          lifecycle: "single app instance with runSamples warmup",
          transport: "app.inject",
          method: "GET",
          path: route.path,
          expectedStatus: 200,
        },
        sample: () => measureAppInject(environment, route.path),
      }));
    }

    for (const scenario of scenarios) decorateDiskScenario(scenario);

    const report = await writeBenchmarkReport({
      kind: "disk",
      profile: args.profile,
      out: args.out,
      startedAt,
      fixture: {
        ...fixtureReport(environment.fixtures),
        fileScale,
      },
      scenarios,
      notes: [
        "Cold session-list samples rebuild an isolated benchmark environment for every sample, including fixture creation, app construction, and listen on 127.0.0.1:0.",
        "Warm samples reuse one app and one isolated temporary fixture environment after runSamples warmup.",
        "The benchmark requires dist/server and never uses port 9528.",
      ],
    });
    await appendDiskTable(report.reportFile, scenarios, fileScale);

    console.log(`Disk benchmark complete: ${report.outputDir}`);
    console.log(`JSON: ${report.summaryFile}`);
    console.log(`Markdown: ${report.reportFile}`);
  } finally {
    await environment.close();
  }
}

function printUsage() {
  console.log("Usage: node bench/disk.mjs [options]");
  console.log("Options:");
  console.log("  --profile quick|standard|stress");
  console.log("  --out <directory>");
  console.log("  --iterations <count>");
  console.log("  --warmup <count>");
}

async function requireBuiltServer() {
  await access(distServerPath, constants.F_OK).catch(() => {
    throw new Error(`Missing ${distServerPath}; build the server before running benchmarks.`);
  });
  await access(distAppPath, constants.F_OK).catch(() => {
    throw new Error(`Missing ${distAppPath}; build the server before running benchmarks.`);
  });
}

function assertIsolatedEnvironment(environment) {
  const address = new URL(environment.baseUrl);
  if (address.hostname !== "127.0.0.1") throw new Error(`Benchmark server must bind to 127.0.0.1, got ${address.hostname}`);
  if (address.port === "0" || address.port === "9528") throw new Error(`Benchmark server must use an ephemeral port, got ${address.port}`);
  if (!environment.fixtures.rootPath.includes("jarvis-bench-")) {
    throw new Error(`Benchmark fixtures are not isolated: ${environment.fixtures.rootPath}`);
  }
}

function routeSet(fixtures) {
  const workspaceId = fixtures.workspaceId;
  const sessionId = fixtures.sessionRefs[0]?.sessionId;
  if (sessionId === undefined) throw new Error("Benchmark fixtures did not create a session");
  const sessionList = `/api/workspaces/${workspaceId}/sessions`;
  const sessionPath = `${sessionList}/${sessionId}`;
  return {
    sessionList,
    sessionPath,
    workspaceFiles: `/api/workspaces/${workspaceId}/files?query=benchmark-00001`,
  };
}

async function measureColdSessionList(profile) {
  const environment = await createBenchmarkEnvironment({
    profile,
    richContent: true,
  });
  try {
    assertIsolatedEnvironment(environment);
    const route = routeSet(environment.fixtures);
    return await measureAppInject(environment, route.sessionList);
  } finally {
    await environment.close();
  }
}

async function measureAppInject(environment, path) {
  const response = await environment.app.inject({ method: "GET", url: path });
  return {
    status: response.statusCode,
    bytes: Buffer.byteLength(response.payload),
  };
}

function decorateDiskScenario(scenario) {
  const statusCounts = {};
  for (const sample of scenario.samples) {
    const key = String(sample.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  scenario.disk = {
    statusCounts,
    bytes: summary(scenario.samples.map((sample) => sample.bytes)),
  };
}

async function measureFileScale(fixtures) {
  const [workspace, sessions] = await Promise.all([
    directoryScale(fixtures.workspacePath),
    directoryScale(fixtures.sessionDir),
  ]);
  return {
    workspace,
    sessions,
    total: {
      files: workspace.files + sessions.files,
      bytes: workspace.bytes + sessions.bytes,
    },
  };
}

async function directoryScale(rootPath) {
  let files = 0;
  let bytes = 0;
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await stat(path);
      files += 1;
      bytes += metadata.size;
    }
  };
  await visit(rootPath);
  return { rootPath, files, bytes };
}

async function appendDiskTable(reportFile, scenarios, fileScale) {
  const lines = [
    "",
    "## Disk Status and Bytes",
    "",
    "| Scenario | Statuses | Bytes p50 | Bytes p95 | Bytes p99 | Bytes total |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of scenarios) {
    const bytes = scenario.disk?.bytes ?? {};
    const statuses = Object.entries(scenario.disk?.statusCounts ?? {})
      .map(([status, count]) => `${status}×${count}`)
      .join(", ");
    lines.push(`| ${scenario.name} | ${statuses || "-"} | ${formatNumber(bytes.p50)} | ${formatNumber(bytes.p95)} | ${formatNumber(bytes.p99)} | ${formatNumber(bytes.total)} |`);
  }
  lines.push(
    "",
    "## File Scale",
    "",
    "| Tree | Files | Bytes |",
    "| --- | ---: | ---: |",
    `| Workspace | ${fileScale.workspace.files} | ${fileScale.workspace.bytes} |`,
    `| Sessions | ${fileScale.sessions.files} | ${fileScale.sessions.bytes} |`,
    `| Total | ${fileScale.total.files} | ${fileScale.total.bytes} |`,
    "",
  );
  await appendFile(reportFile, `${lines.join("\n")}\n`, "utf8");
}

function formatNumber(value) {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(3);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
