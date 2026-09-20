import { access, appendFile, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  createBenchmarkEnvironment,
  fixtureReport,
  parseArgs,
  runSamples,
  writeBenchmarkReport,
} from "./lib/harness.mjs";
import { PROFILES } from "./lib/fixtures.mjs";
import { createEventLoopDelayMonitor, summary } from "./lib/metrics.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distServerPath = join(projectRoot, "dist", "server");
const distAppPath = join(distServerPath, "server", "app.js");
const OPEN = 1;

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
  const environment = await createBenchmarkEnvironment({ profile: args.profile, richContent: true });
  try {
    assertIsolatedEnvironment(environment);
    const sessionId = environment.fixtures.sessionRefs[0]?.sessionId;
    if (sessionId === undefined) throw new Error("Benchmark fixtures did not create a session");
    const ref = { workspaceId: environment.fixtures.workspaceId, sessionId };
    const profile = PROFILES[args.profile];
    const scenarios = [];

    scenarios.push(await runSamples({
      name: "connect-one",
      description: "Open and close one real session-events WebSocket over loopback.",
      profile: args.profile,
      warmup: args.warmup,
      iterations: args.iterations,
      metadata: { transport: "websocket", subscribers: 1, path: eventPath(ref) },
      sample: async () => {
        const started = process.hrtime.bigint();
        const socket = await openSocket(environment.url(eventPath(ref)));
        const connectMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        await closeSocket(socket);
        return { connectMs };
      },
    }));

    const subscriberCounts = [...new Set([1, Math.min(4, profile.wsSubscribers), profile.wsSubscribers])];
    for (const subscribers of subscriberCounts) {
      scenarios.push(await measureNetworkFanout({
        environment,
        ref,
        subscribers,
        eventCount: profile.wsEvents,
      }));
    }
    scenarios.push(await measureDirectFanout({
      args,
      environment,
      ref,
      subscribers: profile.wsSubscribers,
      eventCount: profile.wsEvents,
    }));

    const report = await writeBenchmarkReport({
      kind: "websocket",
      profile: args.profile,
      out: args.out,
      startedAt,
      fixture: fixtureReport(environment.fixtures),
      scenarios,
      notes: [
        "Real socket scenarios use the Fastify websocket route on 127.0.0.1 with an ephemeral port.",
        "Payload sentAtNs uses the same monotonic clock in the benchmark process to measure publish-to-receive latency.",
        "Direct fan-out uses the same isolated EventHub with in-process fake sockets and excludes TCP, websocket framing, and browser costs.",
        "Port 9528 is never used.",
      ],
    });
    await appendWebSocketTable(report.reportFile, scenarios);
    console.log(`WebSocket benchmark complete: ${report.outputDir}`);
    console.log(`JSON: ${report.summaryFile}`);
    console.log(`Markdown: ${report.reportFile}`);
  } finally {
    await environment.close();
  }
}

async function measureNetworkFanout({ environment, ref, subscribers, eventCount }) {
  const pool = await Promise.all(Array.from({ length: subscribers }, () => openSocket(environment.url(eventPath(ref)))));
  const pending = new Map();
  const lastSequence = Array.from({ length: subscribers }, () => 0);
  const receivedBySocket = Array.from({ length: subscribers }, () => 0);
  const latencies = [];
  const outOfOrder = [];
  const duplicates = [];
  const failures = [];
  let received = 0;
  let bytes = 0;

  for (const [socketIndex, socket] of pool.entries()) {
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      bytes += Buffer.byteLength(text);
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      const payload = frame?.payload;
      const benchmarkId = payload?.benchmarkId;
      if (typeof benchmarkId !== "string") return;
      const delivery = pending.get(benchmarkId);
      if (delivery === undefined) return;
      if (delivery.sockets.has(socketIndex)) {
        duplicates.push({ benchmarkId, socketIndex });
        return;
      }
      delivery.sockets.add(socketIndex);
      receivedBySocket[socketIndex] += 1;
      received += 1;
      if (typeof frame.seq === "number" && frame.seq <= (lastSequence[socketIndex] ?? 0)) {
        outOfOrder.push({ benchmarkId, socketIndex, seq: frame.seq, previous: lastSequence[socketIndex] ?? 0 });
      }
      if (typeof frame.seq === "number") lastSequence[socketIndex] = frame.seq;
      if (typeof payload.sentAtNs === "string") {
        latencies.push(Number(process.hrtime.bigint() - BigInt(payload.sentAtNs)) / 1_000_000);
      }
      if (delivery.sockets.size === subscribers) delivery.resolve();
    });
  }

  const monitor = createEventLoopDelayMonitor({ resolution: 10 });
  const memoryBefore = process.memoryUsage();
  monitor.start();
  const started = process.hrtime.bigint();
  try {
    for (let index = 0; index < eventCount; index += 1) {
      const benchmarkId = `network-${subscribers}-${index}-${Math.random().toString(36).slice(2)}`;
      let resolveDelivery;
      const delivered = new Promise((resolve) => { resolveDelivery = resolve; });
      pending.set(benchmarkId, { sockets: new Set(), resolve: resolveDelivery });
      environment.app.jarvis.events.publishSession(ref, {
        type: "context.updated",
        payload: { benchmarkId, sentAtNs: String(process.hrtime.bigint()), index },
      });
      const status = await Promise.race([
        delivered.then(() => "delivered"),
        wait(2_000).then(() => "timeout"),
      ]);
      if (status === "timeout") failures.push({ index, message: "fan-out delivery timeout" });
      pending.delete(benchmarkId);
    }
  } finally {
    await Promise.all(pool.map((socket) => closeSocket(socket)));
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const eventLoopDelay = monitor.stop();
  const memoryAfter = process.memoryUsage();
  const throughput = durationMs === 0 ? undefined : eventCount * subscribers / (durationMs / 1_000);
  return {
    name: `network-fanout-${subscribers}`,
    description: `Publish ${String(eventCount)} events to ${String(subscribers)} real WebSocket subscribers.`,
    iterations: eventCount,
    warmup: 0,
    warmupErrors: [],
    samples: [{ durationMs, subscribers, eventCount, received, bytes }],
    errors: failures,
    metrics: singleSummary(durationMs),
    eventLoopDelay,
    memory: memorySnapshot(memoryBefore, memoryAfter),
    metadata: {
      transport: "websocket",
      subscribers,
      eventCount,
      latency: summary(latencies),
      bytes: summary([bytes]),
      received,
      expected: eventCount * subscribers,
      missing: failures.length,
      outOfOrder,
      duplicates,
      receivedBySocket,
      throughputEventsPerSecond: throughput,
      throughputBytesPerSecond: durationMs === 0 ? undefined : bytes / (durationMs / 1_000),
    },
  };
}

async function measureDirectFanout({ args, environment, ref, subscribers, eventCount }) {
  const sockets = Array.from({ length: subscribers }, () => createFakeSocket());
  for (const socket of sockets) environment.app.jarvis.events.addSession(ref, socket);
  try {
    const scenario = await runSamples({
      name: `direct-fanout-${subscribers}`,
      description: `Publish one event repeatedly to ${String(subscribers)} in-process EventHub sockets.`,
      profile: args.profile,
      warmup: args.warmup,
      iterations: eventCount,
      metadata: { transport: "in-process", subscribers, eventCount },
      sample: () => {
        const before = sockets.reduce((total, socket) => total + socket.messages, 0);
        environment.app.jarvis.events.publishSession(ref, {
          type: "context.updated",
          payload: { benchmarkId: "direct", sentAtNs: String(process.hrtime.bigint()) },
        });
        const after = sockets.reduce((total, socket) => total + socket.messages, 0);
        return { delivered: after - before, bytes: sockets[0]?.lastBytes ?? 0 };
      },
    });
    scenario.metadata.bytes = summary(scenario.samples.map((sample) => sample.bytes));
    scenario.metadata.received = scenario.samples.reduce((total, sample) => total + sample.delivered, 0);
    scenario.metadata.expected = eventCount * subscribers;
    scenario.metadata.missing = Math.max(0, scenario.metadata.expected - scenario.metadata.received);
    scenario.metadata.latency = summary([]);
    scenario.metadata.throughputEventsPerSecond = scenario.metrics.p50 === undefined || scenario.metrics.p50 === 0
      ? undefined
      : subscribers * 1_000 / scenario.metrics.p50;
    return scenario;
  } finally {
    for (const socket of sockets) socket.close();
  }
}

function openSocket(url) {
  if (typeof WebSocket !== "function") throw new Error("Node WebSocket is unavailable; Node 24 or newer is required");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error("WebSocket open timeout"));
    }, 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    }, { once: true });
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === 3) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, 1_000);
    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    try { socket.close(); } catch { clearTimeout(timeout); resolve(); }
  });
}

function createFakeSocket() {
  const listeners = new Map();
  const socket = {
    readyState: OPEN,
    messages: 0,
    lastBytes: 0,
    send(payload) {
      socket.messages += 1;
      socket.lastBytes = Buffer.byteLength(payload);
    },
    on(event, listener) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
    close() {
      if (socket.readyState !== OPEN) return;
      socket.readyState = 3;
      for (const listener of listeners.get("close") ?? []) listener();
    },
    terminate() { socket.close(); },
  };
  return socket;
}

function eventPath(ref) {
  return `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/events`;
}

async function requireBuiltServer() {
  for (const path of [distServerPath, distAppPath]) {
    await access(path, constants.F_OK).catch(() => { throw new Error(`Missing ${path}; run npm run build first.`); });
  }
}

function assertIsolatedEnvironment(environment) {
  const address = new URL(environment.baseUrl);
  if (address.hostname !== "127.0.0.1" || address.port === "0" || address.port === "9528") throw new Error(`Invalid benchmark address: ${environment.baseUrl}`);
  if (!environment.fixtures.rootPath.includes("jarvis-bench-")) throw new Error(`Benchmark fixtures are not isolated: ${environment.fixtures.rootPath}`);
}

function singleSummary(durationMs) {
  return { count: 1, min: durationMs, max: durationMs, mean: durationMs, p50: durationMs, p95: durationMs, p99: durationMs, total: durationMs };
}

function memorySnapshot(before, after) {
  return {
    before,
    after,
    delta: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)])),
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function appendWebSocketTable(reportFile, scenarios) {
  const lines = [
    "",
    "## WebSocket Details",
    "",
    "| Scenario | Transport | Subscribers | Events | Latency p50 | Latency p95 | Latency p99 | Received | Missing |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of scenarios) {
    const metadata = scenario.metadata ?? {};
    const latency = metadata.latency ?? {};
    lines.push(`| ${scenario.name} | ${metadata.transport ?? "-"} | ${metadata.subscribers ?? "-"} | ${metadata.eventCount ?? "-"} | ${formatNumber(latency.p50)} | ${formatNumber(latency.p95)} | ${formatNumber(latency.p99)} | ${metadata.received ?? "-"} | ${metadata.missing ?? scenario.errors?.length ?? 0} |`);
  }
  await appendFile(reportFile, `${lines.join("\n")}\n`, "utf8");
}

function formatNumber(value) {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(3);
}

function printUsage() {
  console.log("Usage: node bench/websocket.mjs [options]");
  console.log("Options:");
  console.log("  --profile quick|standard|stress");
  console.log("  --out <directory>");
  console.log("  --iterations <count>");
  console.log("  --warmup <count>");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
