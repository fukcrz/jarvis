import { appendFile, access } from "node:fs/promises";
import { constants } from "node:fs";
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
    const routes = routeSet(environment.fixtures);
    await preflight(environment, routes);

    const scenarios = [];
    for (const transport of ["app.inject", "fetch"]) {
      for (const route of routes.scenarios) {
        const scenario = await runSamples({
          name: `${transport}-${route.name}`,
          description: `${transport} GET ${route.path}`,
          profile: args.profile,
          warmup: args.warmup,
          iterations: args.iterations,
          metadata: {
            transport,
            method: "GET",
            path: route.path,
            expectedStatus: 200,
            fixtureProfile: args.profile,
            profileConfig: PROFILES[args.profile],
          },
          sample: () => measureGet(environment, transport, route.path),
        });
        decorateHttpScenario(scenario, route.path, transport);
        scenarios.push(scenario);
      }
    }

    const report = await writeBenchmarkReport({
      kind: "http",
      profile: args.profile,
      out: args.out,
      startedAt,
      fixture: fixtureReport(environment.fixtures),
      scenarios,
      notes: [
        "HTTP scenarios compare Fastify app.inject with a real fetch over 127.0.0.1.",
        "Each sample records the HTTP status code and response body bytes.",
        "The server is created by createBenchmarkEnvironment with port 0; port 9528 is not used.",
      ],
    });
    await appendPayloadTable(report.reportFile, scenarios, "HTTP Status and Bytes");

    console.log(`HTTP benchmark complete: ${report.outputDir}`);
    console.log(`JSON: ${report.summaryFile}`);
    console.log(`Markdown: ${report.reportFile}`);
  } finally {
    await environment.close();
  }
}

function printUsage() {
  console.log("Usage: node bench/http.mjs [options]");
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

  const sessionRoot = `/api/workspaces/${workspaceId}/sessions`;
  const sessionPath = `${sessionRoot}/${sessionId}`;
  return {
    health: "/api/health",
    workspaceList: "/api/workspaces",
    scenarios: [
      { name: "health", path: "/api/health" },
      { name: "workspaces", path: "/api/workspaces" },
      { name: "session-list-warm", path: sessionRoot },
      { name: "session-list-search", path: `${sessionRoot}?query=Benchmark%20session%201` },
      { name: "timeline-40", path: `${sessionPath}/timeline?limit=40` },
      { name: "timeline-120", path: `${sessionPath}/timeline?limit=120` },
      { name: "timeline-500", path: `${sessionPath}/timeline?limit=500` },
      { name: "runtime", path: `${sessionPath}/runtime` },
      { name: "workspace-files-search", path: `/api/workspaces/${workspaceId}/files?query=benchmark-00001` },
    ],
  };
}

async function preflight(environment, routes) {
  for (const route of routes.scenarios) {
    const result = await measureGet(environment, "app.inject", route.path);
    if (result.status !== 200) throw new Error(`Preflight failed for ${route.path}: HTTP ${result.status}`);
  }
}

async function measureGet(environment, transport, path) {
  if (transport === "app.inject") {
    const response = await environment.app.inject({ method: "GET", url: path });
    return {
      status: response.statusCode,
      bytes: Buffer.byteLength(response.payload),
    };
  }

  const response = await fetch(environment.url(path), {
    headers: { accept: "application/json" },
  });
  const body = await response.arrayBuffer();
  return {
    status: response.status,
    bytes: body.byteLength,
  };
}

function decorateHttpScenario(scenario, path, transport) {
  const statusCounts = {};
  for (const sample of scenario.samples) {
    const key = String(sample.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  scenario.http = {
    transport,
    path,
    statusCounts,
    bytes: summary(scenario.samples.map((sample) => sample.bytes)),
  };
}

async function appendPayloadTable(reportFile, scenarios, title) {
  const lines = [
    "",
    `## ${title}`,
    "",
    "| Scenario | Transport | Statuses | Bytes p50 | Bytes p95 | Bytes p99 | Bytes total |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of scenarios) {
    const bytes = scenario.http?.bytes ?? {};
    const statuses = Object.entries(scenario.http?.statusCounts ?? {})
      .map(([status, count]) => `${status}×${count}`)
      .join(", ");
    lines.push(`| ${scenario.name} | ${scenario.http?.transport ?? "-"} | ${statuses || "-"} | ${formatNumber(bytes.p50)} | ${formatNumber(bytes.p95)} | ${formatNumber(bytes.p99)} | ${formatNumber(bytes.total)} |`);
  }
  await appendFile(reportFile, `${lines.join("\n")}\n`, "utf8");
}

function formatNumber(value) {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(3);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
