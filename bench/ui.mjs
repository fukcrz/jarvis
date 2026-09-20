import { access, appendFile, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import {
  createBenchmarkEnvironment,
  fixtureReport,
  parseArgs,
  runSamples,
  writeBenchmarkReport,
} from "./lib/harness.mjs";
import { PROFILES } from "./lib/fixtures.mjs";
import { summary } from "./lib/metrics.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distServerPath = join(projectRoot, "dist", "server");
const distClientPath = join(projectRoot, "dist", "client", "index.html");
const DESKTOP = { name: "desktop", width: 1440, height: 960, isMobile: false };
const MOBILE = { name: "mobile", width: 390, height: 844, isMobile: true };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  await requireBuiltApplication();
  process.chdir(projectRoot);
  process.env.LOG_LEVEL = "silent";

  const profile = PROFILES[args.profile];
  const iterations = args.iterations ?? uiIterations(args.profile);
  const warmup = args.warmup ?? uiWarmup(args.profile);
  const browser = await chromium.launch({ headless: !args.headful });
  const environment = await createBenchmarkEnvironment({
    profile: args.profile,
    richContent: true,
    turnsPerSession: Math.max(profile.turnsPerSession, 16),
    serveStatic: true,
  });
  const startedAt = new Date().toISOString();
  try {
    assertIsolatedEnvironment(environment);
    const ref = selectedRef(environment.fixtures);
    const scenarios = [];

    for (const viewport of [DESKTOP, MOBILE]) {
      const scenario = await runSamples({
        name: `navigation-${viewport.name}`,
        description: `Cold production navigation through AuthGate, workspace/session hydration, and two WebSocket subscriptions at ${viewport.width}x${viewport.height}.`,
        profile: args.profile,
        warmup,
        iterations,
        metadata: { viewport, mode: "production-build", cpuThrottle: args.cpuThrottle },
        sample: () => withPage(browser, environment, ref, viewport, args.cpuThrottle, async ({ page, capture }) => {
          const started = process.hrtime.bigint();
          await openChat(page, environment, ref);
          const navigationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
          return { navigationMs, ...(await capture()) };
        }),
      });
      decorateFrontendScenario(scenario);
      scenarios.push(scenario);
    }

    for (const viewport of [DESKTOP, MOBILE]) {
      const target = alternateRef(environment.fixtures, ref);
      const targetLabel = fixtureSessionLabel(environment.fixtures, target);
      const scenario = await runSamples({
        name: `session-switch-${viewport.name}`,
        description: "Select a different persisted session and wait for its timeline/runtime hydration and session socket.",
        profile: args.profile,
        warmup,
        iterations,
        metadata: { viewport, mode: "production-build", target: "session-switch", targetLabel },
        sample: () => withPage(browser, environment, ref, viewport, args.cpuThrottle, async ({ page, capture }) => {
          await openChat(page, environment, ref);
          const started = await page.evaluate(() => performance.now());
          if (viewport.isMobile) {
            await page.goto(`${environment.baseUrl}/#/projects`, { waitUntil: "domcontentloaded" });
            const row = page.locator(`.mobile-session-row[data-session-id="${target.sessionId}"]`).locator(".mobile-session-select");
            await expandMobileSessionWindow(page, targetLabel, row);
            await row.waitFor({ state: "visible", timeout: 15_000 });
            await row.click();
          } else {
            const row = page.locator(`.session-row[data-session-id="${target.sessionId}"]`);
            await expandDesktopSessionWindow(page, ref.workspaceId, row);
            await row.waitFor({ state: "visible", timeout: 15_000 });
            await row.click();
          }
          await page.waitForFunction((sessionId) => window.location.hash.includes(sessionId), target.sessionId);
          await page.locator(".composer-editor .cm-content").waitFor({ state: "visible", timeout: 15_000 });
          await page.locator(".timeline").waitFor({ state: "visible", timeout: 15_000 });
          await waitForSocket(page, eventPath(target));
          const finished = await page.evaluate(() => performance.now());
          return { switchMs: finished - started, ...(await capture()) };
        }),
      });
      decorateFrontendScenario(scenario);
      scenarios.push(scenario);
    }

    for (const viewport of [DESKTOP, MOBILE]) {
      const target = alternateRef(environment.fixtures, ref);
      const targetMarker = fixtureTurnMarker(environment.fixtures, target, Math.max(profile.turnsPerSession, 16));
      const sourceMarker = fixtureTurnMarker(environment.fixtures, ref, Math.max(profile.turnsPerSession, 16));
      const scenario = await runSamples({
        name: `session-roundtrip-${viewport.name}`,
        description: "Switch A→B→A in one browser page and verify the previously visited transcript is restored without stale-session errors.",
        profile: args.profile,
        warmup,
        iterations,
        metadata: { viewport, mode: "production-build", target: "session-roundtrip", cacheLimit: 8 },
        sample: () => withPage(browser, environment, ref, viewport, args.cpuThrottle, async ({ page, capture }) => {
          await openChat(page, environment, ref);
          await selectSession(page, environment, target, viewport, fixtureSessionLabel(environment.fixtures, target));
          await waitForMarker(page, targetMarker, "target timeline marker");

          let releaseSourceTimeline;
          let sourceTimelineBlocked = false;
          const sourceTimelineGate = new Promise((resolve) => { releaseSourceTimeline = resolve; });
          await page.route("**/timeline*", async (route) => {
            const url = route.request().url();
            if (url.includes(`/sessions/${ref.sessionId}/timeline`) && !sourceTimelineBlocked) {
              sourceTimelineBlocked = true;
              await sourceTimelineGate;
            }
            await route.continue();
          });
          const sourceOpenCount = await socketOpenCount(page, eventPath(ref));
          const started = await page.evaluate(() => performance.now());
          await selectSession(page, environment, ref, viewport, fixtureSessionLabel(environment.fixtures, ref));
          await waitForMarker(page, sourceMarker, "source cached timeline marker", targetMarker);
          if (!sourceTimelineBlocked) throw new Error("Roundtrip did not issue a source timeline request");
          releaseSourceTimeline();
          await waitForSocketCount(page, eventPath(ref), sourceOpenCount + 1);
          await waitForFrames(page, 2);
          const finished = await page.evaluate(() => performance.now());
          return { switchBackMs: finished - started, cacheRestored: true, ...(await capture()) };
        }),
      });
      decorateFrontendScenario(scenario);
      scenarios.push(scenario);
    }

    const historyScenario = await runSamples({
      name: "history-prepend-desktop",
      description: "Scroll to the oldest visible timeline item and measure one real earlier-history HTTP page plus React prepend/layout stabilization.",
      profile: args.profile,
      warmup,
      iterations,
      metadata: { viewport: DESKTOP, mode: "production-build", initialTimelineLimit: 40 },
      sample: () => withPage(browser, environment, ref, DESKTOP, args.cpuThrottle, async ({ page, capture }) => {
        await openChat(page, environment, ref);
        const before = await page.locator(".message-row").count();
        const request = page.waitForResponse((response) => response.url().includes("/timeline?before=") && response.status() === 200, { timeout: 5_000 });
        const started = process.hrtime.bigint();
        await page.locator(".timeline").evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
        await request;
        await page.waitForFunction((previousCount) => document.querySelectorAll(".message-row").length > previousCount, before, { timeout: 5_000 });
        await waitForFrames(page, 2);
        const historyPrependMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const after = await page.locator(".message-row").count();
        if (after <= before) throw new Error(`History prepend did not increase timeline rows: ${String(before)} -> ${String(after)}`);
        return { historyPrependMs, timelineRowsBefore: before, timelineRowsAfter: after, pageLoaded: true, ...(await capture()) };
      }),
    });
    decorateFrontendScenario(historyScenario);
    scenarios.push(historyScenario);

    const singleDeltaScenario = await runSamples({
      name: "stream-single-delta",
      description: "Publish a real EventHub assistant.delta and measure WebSocket receipt to committed DOM text.",
      profile: args.profile,
      warmup,
      iterations,
      metadata: { viewport: DESKTOP, mode: "production-build", eventType: "assistant.delta" },
      sample: () => withPage(browser, environment, ref, DESKTOP, args.cpuThrottle, async ({ page, capture }) => {
        await openChat(page, environment, ref);
        const probeId = uniqueId("single");
        await armProbe(page, probeId);
        environment.app.jarvis.events.publishSession(ref, {
          type: "assistant.delta",
          payload: { benchmarkId: probeId, messageId: `message:${probeId}`, delta: ` ${probeId}` },
        });
        const probe = await waitForProbe(page, probeId);
        return { socketToDomMs: probe.domAt - probe.receivedAt, clientToDomMs: probe.domAt - probe.armedAt, ...(await capture()) };
      }),
    });
    decorateFrontendScenario(singleDeltaScenario);
    scenarios.push(singleDeltaScenario);

    const burstEvents = profile.wsEvents;
    const burstScenario = await runSamples({
      name: "stream-burst",
      description: `Publish ${String(burstEvents)} assistant deltas as fast as EventHub can broadcast; measure the final frame to DOM after client rAF coalescing.`,
      profile: args.profile,
      warmup: Math.min(1, warmup),
      iterations: Math.max(1, Math.min(iterations, 5)),
      metadata: { viewport: DESKTOP, mode: "production-build", eventType: "assistant.delta", eventCount: burstEvents },
      sample: () => withPage(browser, environment, ref, DESKTOP, args.cpuThrottle, async ({ page, capture }) => {
        await openChat(page, environment, ref);
        const probeId = uniqueId("burst");
        const messageId = `message:${probeId}`;
        await armProbe(page, probeId);
        const started = process.hrtime.bigint();
        for (let index = 0; index < burstEvents; index += 1) {
          environment.app.jarvis.events.publishSession(ref, {
            type: "assistant.delta",
            payload: {
              ...(index === burstEvents - 1 ? { benchmarkId: probeId } : {}),
              messageId,
              delta: index === burstEvents - 1 ? ` ${probeId}` : "x",
            },
          });
        }
        const serverPublishMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const probe = await waitForProbe(page, probeId, 15_000);
        return { burstEvents, serverPublishMs, socketToDomMs: probe.domAt - probe.receivedAt, clientToDomMs: probe.domAt - probe.armedAt, ...(await capture()) };
      }),
    });
    decorateFrontendScenario(burstScenario);
    scenarios.push(burstScenario);

    const markdownScenario = await runSamples({
      name: "markdown-heavy-upsert",
      description: "Insert a large markdown assistant item through the real session event stream and measure network receipt to ReactMarkdown DOM completion.",
      profile: args.profile,
      warmup,
      iterations: Math.max(1, Math.min(iterations, 8)),
      metadata: { viewport: DESKTOP, mode: "production-build", eventType: "timeline.upsert", markdownBytes: Buffer.byteLength(largeMarkdown("sample")) },
      sample: () => withPage(browser, environment, ref, DESKTOP, args.cpuThrottle, async ({ page, capture }) => {
        await openChat(page, environment, ref);
        const probeId = uniqueId("markdown");
        await armProbe(page, probeId);
        environment.app.jarvis.events.publishSession(ref, {
          type: "timeline.upsert",
          payload: {
            item: {
              kind: "message",
              id: `message:${probeId}`,
              role: "assistant",
              createdAt: new Date().toISOString(),
              text: largeMarkdown(probeId),
            },
            benchmarkId: probeId,
          },
        });
        const probe = await waitForProbe(page, probeId, 15_000);
        return { socketToDomMs: probe.domAt - probe.receivedAt, clientToDomMs: probe.domAt - probe.armedAt, ...(await capture()) };
      }),
    });
    decorateFrontendScenario(markdownScenario);
    scenarios.push(markdownScenario);

    const composerScenario = await runSamples({
      name: "composer-input-desktop",
      description: "Insert a 2 KB draft into CodeMirror and wait for two animation frames, covering controlled draft persistence and layout stabilization.",
      profile: args.profile,
      warmup,
      iterations,
      metadata: { viewport: DESKTOP, mode: "production-build", draftBytes: 2_048 },
      sample: () => withPage(browser, environment, ref, DESKTOP, args.cpuThrottle, async ({ page, capture }) => {
        await openChat(page, environment, ref);
        const editor = page.locator(".composer-editor .cm-content");
        await editor.click();
        const started = await page.evaluate(() => performance.now());
        await page.keyboard.insertText("x".repeat(2_048));
        await waitForFrames(page, 2);
        const finished = await page.evaluate(() => performance.now());
        return { inputToStableMs: finished - started, editorCharacters: await editor.textContent().then((value) => value?.length ?? 0), ...(await capture()) };
      }),
    });
    decorateFrontendScenario(composerScenario);
    scenarios.push(composerScenario);

    const report = await writeBenchmarkReport({
      kind: "ui",
      profile: args.profile,
      out: args.out,
      startedAt,
      fixture: fixtureReport(environment.fixtures),
      scenarios,
      notes: [
        "UI scenarios serve dist/client from an isolated Fastify instance on 127.0.0.1 with an ephemeral port.",
        "Each sample uses a new browser context so browser storage, cache, WebSocket state, and heap do not leak across samples.",
        "CDP metrics are Chromium-relative indicators; compare baselines only on the same browser version and host class.",
        "WebSocket-to-DOM timing starts when the page wrapper observes the matching session frame and ends when MutationObserver sees the marker in rendered text.",
        "Port 9528 is never used.",
      ],
    });
    await appendFrontendTable(report.reportFile, scenarios);
    console.log(`UI benchmark complete: ${report.outputDir}`);
    console.log(`JSON: ${report.summaryFile}`);
    console.log(`Markdown: ${report.reportFile}`);
  } finally {
    await environment.close();
    await browser.close();
  }
}

async function withPage(browser, environment, ref, viewport, cpuThrottle, operation) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.isMobile });
  await context.addInitScript({ content: BROWSER_PROBE_SCRIPT });
  await context.addInitScript((workspaceId) => {
    localStorage.setItem("jarvis.projects.expanded", JSON.stringify({ [workspaceId]: true }));
    localStorage.setItem("jarvis.mobile.projects.expanded", JSON.stringify({ [workspaceId]: true }));
  }, ref.workspaceId);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  if (cpuThrottle !== 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
  const before = await cdpMetrics(cdp);
  try {
    const result = await operation({ page, cdp, capture: async () => ({ browser: await browserSnapshot(page, cdp, before, errors) }) });
    return result;
  } finally {
    await context.close();
  }
}

async function openChat(page, environment, ref) {
  await page.goto(`${environment.baseUrl}/#/chat/${ref.workspaceId}/${ref.sessionId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".composer-editor .cm-content").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".timeline").waitFor({ state: "visible", timeout: 15_000 });
  await waitForSocket(page, eventPath(ref));
  await page.waitForFunction(() => document.querySelectorAll(".message-row").length > 0, undefined, { timeout: 15_000 });
}

async function expandDesktopSessionWindow(page, workspaceId, target) {
  for (let attempt = 0; attempt < 20 && !(await target.isVisible().catch(() => false)); attempt += 1) {
    const expand = page.locator(`.project-node[data-workspace-id="${workspaceId}"] .session-expand-more`);
    await expand.waitFor({ state: "visible", timeout: 15_000 });
    await expand.click();
  }
}

async function selectSession(page, environment, ref, viewport, label) {
  if (viewport.isMobile) {
    const backToSessions = page.locator('.mobile-chat-header button[aria-label="返回会话列表"]');
    if (await backToSessions.isVisible().catch(() => false)) {
      await backToSessions.click();
    } else if (!page.url().includes("#/projects")) {
      await page.goto(`${environment.baseUrl}/#/projects`, { waitUntil: "domcontentloaded" });
    }
    const row = page.locator(`.mobile-session-row[data-session-id="${ref.sessionId}"]`).locator(".mobile-session-select");
    await expandMobileSessionWindow(page, label, row);
    await row.waitFor({ state: "visible", timeout: 15_000 });
    await row.click();
  } else {
    const row = page.locator(`.session-row[data-session-id="${ref.sessionId}"]`);
    await expandDesktopSessionWindow(page, ref.workspaceId, row);
    await row.waitFor({ state: "visible", timeout: 15_000 });
    await row.click();
  }
  await waitForSessionRoute(page, ref.sessionId);
  await page.locator(".composer-editor .cm-content").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".timeline").waitFor({ state: "visible", timeout: 15_000 });
}

async function waitForSessionRoute(page, sessionId) {
  try {
    await page.waitForFunction((expectedSessionId) => window.location.hash.includes(expectedSessionId), sessionId, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`session route not observed: expected ${sessionId}, current ${page.url()}; ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function expandMobileSessionWindow(page, targetLabel, target) {
  const group = page.locator(".mobile-session-group").first();
  await group.waitFor({ state: "visible", timeout: 15_000 });
  const toggle = group.locator(".mobile-session-group-toggle");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  for (let attempt = 0; attempt < 20 && !(await target.isVisible().catch(() => false)); attempt += 1) {
    const expand = group.locator(".mobile-session-window-action").filter({ hasText: "展开更多会话" });
    if (await expand.isVisible().catch(() => false)) {
      await expand.click();
      continue;
    }
    await target.waitFor({ state: "visible", timeout: 15_000 });
  }
  await target.waitFor({ state: "visible", timeout: 15_000 });
  void targetLabel;
}

async function waitForMarker(page, marker, label, absentMarker) {
  try {
    await page.waitForFunction(({ expected, absent }) => {
      const text = document.querySelector(".timeline")?.textContent ?? "";
      return text.includes(expected) && (absent === undefined || !text.includes(absent));
    }, { expected: marker, absent: absentMarker }, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`${label} not observed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function waitForSocket(page, path) {
  await page.waitForFunction((expectedPath) => window.__jarvisBench?.socketOpenPaths?.some((value) => value.includes(expectedPath)) === true, path, { timeout: 15_000 });
}

async function socketOpenCount(page, path) {
  return page.evaluate((expectedPath) => window.__jarvisBench?.socketOpenPaths?.filter((value) => value.includes(expectedPath)).length ?? 0, path);
}

async function waitForSocketCount(page, path, count) {
  try {
    await page.waitForFunction(({ expectedPath, expectedCount }) => (window.__jarvisBench?.socketOpenPaths?.filter((value) => value.includes(expectedPath)).length ?? 0) >= expectedCount, { expectedPath: path, expectedCount: count }, { timeout: 30_000 });
  } catch (error) {
    const actual = await socketOpenCount(page, path).catch(() => -1);
    throw new Error(`socket reopen not observed for ${path}: expected ${String(count)}, actual ${String(actual)}; ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function armProbe(page, probeId) {
  await page.evaluate((id) => {
    const state = window.__jarvisBench;
    state.pending[id] = { armedAt: performance.now() };
  }, probeId);
}

async function waitForProbe(page, probeId, timeout = 5_000) {
  await page.waitForFunction((id) => window.__jarvisBench?.completed?.[id]?.domAt !== undefined, probeId, { timeout });
  return page.evaluate((id) => window.__jarvisBench.completed[id], probeId);
}

async function waitForFrames(page, count) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}

async function browserSnapshot(page, cdp, before, errors) {
  const after = await cdpMetrics(cdp);
  const pageMetrics = await page.evaluate(() => {
    const state = window.__jarvisBench;
    const paints = performance.getEntriesByType("paint").map((entry) => ({ name: entry.name, startTime: entry.startTime }));
    const resources = performance.getEntriesByType("resource");
    return {
      longTasks: state.longTasks,
      cumulativeLayoutShift: state.layoutShifts.reduce((total, item) => total + item, 0),
      paints,
      resources: {
        count: resources.length,
        transferBytes: resources.reduce((total, entry) => total + (entry.transferSize ?? 0), 0),
        encodedBytes: resources.reduce((total, entry) => total + (entry.encodedBodySize ?? 0), 0),
      },
      dom: {
        nodes: document.getElementsByTagName("*").length,
        timelineRows: document.querySelectorAll(".message-row").length,
        toolRows: document.querySelectorAll(".tool-item").length,
        turnBlocks: document.querySelectorAll(".turn-process").length,
      },
    };
  });
  return {
    cdp: metricDelta(before, after),
    page: pageMetrics,
    errors,
  };
}

async function cdpMetrics(cdp) {
  const result = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
}

function decorateFrontendScenario(scenario) {
  const browserSamples = scenario.samples.map((sample) => sample.browser).filter(Boolean);
  scenario.frontend = {
    navigationMs: summary(scenario.samples.map((sample) => sample.navigationMs)),
    switchMs: summary(scenario.samples.map((sample) => sample.switchMs)),
    switchBackMs: summary(scenario.samples.map((sample) => sample.switchBackMs)),
    historyPrependMs: summary(scenario.samples.map((sample) => sample.historyPrependMs)),
    socketToDomMs: summary(scenario.samples.map((sample) => sample.socketToDomMs)),
    clientToDomMs: summary(scenario.samples.map((sample) => sample.clientToDomMs)),
    inputToStableMs: summary(scenario.samples.map((sample) => sample.inputToStableMs)),
    serverPublishMs: summary(scenario.samples.map((sample) => sample.serverPublishMs)),
    cdp: summarizeCdp(browserSamples),
    longTasks: summarizeLongTasks(browserSamples),
    layoutShift: summary(browserSamples.map((sample) => sample.page?.cumulativeLayoutShift)),
    domNodes: summary(browserSamples.map((sample) => sample.page?.dom?.nodes)),
    timelineRows: summary(browserSamples.map((sample) => sample.page?.dom?.timelineRows)),
    browserErrors: browserSamples.flatMap((sample) => sample.errors ?? []),
  };
}

function summarizeCdp(samples) {
  const keys = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize", "Nodes", "JSEventListeners"];
  return Object.fromEntries(keys.map((key) => [key, summary(samples.map((sample) => sample.cdp?.[key]))]));
}

function summarizeLongTasks(samples) {
  const tasks = samples.flatMap((sample) => sample.page?.longTasks ?? []);
  return { count: tasks.length, durationMs: summary(tasks) };
}

function metricDelta(before, after) {
  return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)]));
}

function selectedRef(fixtures) {
  const ref = fixtures.sessionRefs[0];
  if (ref === undefined) throw new Error("Benchmark fixtures did not create a selected session");
  return ref;
}

function alternateRef(fixtures, selected) {
  return fixtures.sessionRefs.find((candidate) => candidate.sessionId !== selected.sessionId) ?? selected;
}

function fixtureSessionLabel(fixtures, ref) {
  const index = fixtures.sessionRefs.findIndex((candidate) => candidate.sessionId === ref.sessionId);
  return `Benchmark session ${String(index < 0 ? 1 : index + 1)}`;
}

function fixtureTurnMarker(fixtures, ref, turnNumber) {
  const index = fixtures.sessionRefs.findIndex((candidate) => candidate.sessionId === ref.sessionId);
  return `Benchmark session ${String(index < 0 ? 1 : index + 1)}, turn ${String(turnNumber)}`;
}

function eventPath(ref) {
  return `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/events`;
}

function uniqueId(prefix) {
  return `bench-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function largeMarkdown(id) {
  return Array.from({ length: 24 }, (_, index) => [
    `## ${id} section ${String(index + 1)}`,
    "",
    "- **state**: completed",
    "- `inline-code`: benchmark value",
    "",
    "| field | value |",
    "| --- | --- |",
    `| index | ${String(index + 1)} |`,
    "| status | rendered |",
    "",
    "```ts",
    `export const section${String(index + 1)} = \"${id}\";`,
    "```",
  ].join("\n")).join("\n\n");
}

async function requireBuiltApplication() {
  for (const path of [distServerPath, distClientPath]) {
    await access(path, constants.F_OK).catch(() => { throw new Error(`Missing ${path}; run npm run build first.`); });
  }
}

function assertIsolatedEnvironment(environment) {
  const address = new URL(environment.baseUrl);
  if (address.hostname !== "127.0.0.1" || address.port === "0" || address.port === "9528") throw new Error(`Invalid benchmark address: ${environment.baseUrl}`);
  if (!environment.fixtures.rootPath.includes("jarvis-bench-")) throw new Error(`Benchmark fixtures are not isolated: ${environment.fixtures.rootPath}`);
}

function uiIterations(profile) {
  return profile === "stress" ? 8 : profile === "standard" ? 5 : 3;
}

function uiWarmup(profile) {
  return profile === "stress" ? 2 : 1;
}

async function appendFrontendTable(reportFile, scenarios) {
  const lines = [
    "",
    "## Frontend Metrics",
    "",
    "| Scenario | Samples | Primary p50 ms | Primary p95 ms | Task p95 ms | Script p95 ms | Layout p95 ms | Heap p95 bytes | Long tasks | Errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scenario of scenarios) {
    const frontend = scenario.frontend ?? {};
    const primary = frontend.navigationMs?.count ? frontend.navigationMs
      : frontend.switchMs?.count ? frontend.switchMs
        : frontend.switchBackMs?.count ? frontend.switchBackMs
          : frontend.historyPrependMs?.count ? frontend.historyPrependMs
          : frontend.socketToDomMs?.count ? frontend.socketToDomMs
            : frontend.inputToStableMs;
    lines.push(`| ${scenario.name} | ${scenario.metrics?.count ?? 0} | ${formatNumber(primary?.p50)} | ${formatNumber(primary?.p95)} | ${formatNumber(frontend.cdp?.TaskDuration?.p95)} | ${formatNumber(frontend.cdp?.ScriptDuration?.p95)} | ${formatNumber(frontend.cdp?.LayoutDuration?.p95)} | ${formatNumber(frontend.cdp?.JSHeapUsedSize?.p95)} | ${frontend.longTasks?.count ?? 0} | ${frontend.browserErrors?.length ?? 0} |`);
  }
  await appendFile(reportFile, `${lines.join("\n")}\n`, "utf8");
}

function formatNumber(value) {
  return value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(3);
}

function printUsage() {
  console.log("Usage: node bench/ui.mjs [options]");
  console.log("Options:");
  console.log("  --profile quick|standard|stress");
  console.log("  --out <directory>");
  console.log("  --iterations <count>");
  console.log("  --warmup <count>");
  console.log("  --cpu-throttle <rate>");
  console.log("  --headful");
}

const BROWSER_PROBE_SCRIPT = `(() => {
  const state = { socketPaths: [], socketOpenPaths: [], pending: {}, completed: {}, longTasks: [], layoutShifts: [] };
  window.__jarvisBench = state;
  const NativeWebSocket = window.WebSocket;
  class BenchmarkWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      state.socketPaths.push(String(args[0] ?? ""));
      this.addEventListener("open", () => state.socketOpenPaths.push(String(args[0] ?? "")), { once: true });
      this.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(String(event.data));
          const id = frame?.payload?.benchmarkId;
          if (typeof id === "string" && state.pending[id] !== undefined) state.pending[id].receivedAt = performance.now();
        } catch {}
      });
    }
  }
  window.WebSocket = BenchmarkWebSocket;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) state.layoutShifts.push(entry.value);
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  const observer = new MutationObserver(() => {
    const text = document.body?.innerText ?? "";
    for (const [id, value] of Object.entries(state.pending)) {
      if (value.receivedAt !== undefined && text.includes(id) && state.completed[id] === undefined) state.completed[id] = { ...value, domAt: performance.now() };
    }
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
})();`;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
