import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

// Run deliberately after npm run build:
//   node scripts/ui-local-image-cache-smoke.mjs
// Uses the real built Fastify app, SessionService/Pi event handler, JSONL history,
// WebSockets and browser cache. No request interception, model calls or live data.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envKeys = ["JARVIS_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "JARVIS_DESKTOP"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const previousCwd = process.cwd();
const artifacts = await mkdtemp(join(tmpdir(), "jarvis-local-image-cache-artifacts-"));
const report = {
  startedAt: new Date().toISOString(),
  artifacts,
  cases: [],
  responses: [],
  pageErrors: [],
  failures: [],
  cleanupErrors: [],
  limits: [
    "Synthetic Pi messages use the real SessionService handler and persist only isolated JSONL; no LLM or tool process is invoked.",
    "Foreground refresh dispatches visibilitychange while visible; it does not suspend Chromium or an operating-system tab.",
    "The HTTP image control uses a fully qualified URL on the isolated app; external networks are not exercised.",
    "Chromium desktop/mobile viewports; no native WebView, Safari or Firefox coverage.",
  ],
};
const caseNames = ["saved-images", "initial-404", "stream-deltas", "run-settled-open-preview", "run-failed", "page-refresh", "foreground-refresh", "404-recovery", "navigate-and-reopen", "file-reselect", "file-close-and-reopen", "file-markdown-reopen", "snapshot-controls"];
const shapes = {
  initial: { width: 80, height: 48, rgba: [220, 32, 48, 255] },
  settled: { width: 96, height: 60, rgba: [24, 160, 64, 255] },
  failed: { width: 112, height: 72, rgba: [32, 72, 224, 255] },
  reloaded: { width: 128, height: 84, rgba: [224, 128, 24, 255] },
  foreground: { width: 144, height: 96, rgba: [128, 48, 208, 255] },
  navigated: { width: 160, height: 108, rgba: [24, 176, 176, 255] },
  reselected: { width: 176, height: 120, rgba: [192, 168, 32, 255] },
  reopened: { width: 192, height: 132, rgba: [208, 64, 144, 255] },
  markdown: { width: 208, height: 144, rgba: [48, 112, 160, 255] },
  recovered: { width: 91, height: 53, rgba: [160, 96, 48, 255] },
};
let dataRoot;
let app;
let browser;
let interrupted;

async function bounded(promise, label, timeout = 15_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out`)), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

console.log(`Local image cache smoke artifacts: ${artifacts}`);

function interrupt(signal) {
  interrupted ??= new Error(`Interrupted by ${signal}`);
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  // Closing only our browser interrupts bounded Playwright waits. The finally
  // block closes our app and removes its profile, even when a case was aborted.
  void browser?.close().catch((error) => report.cleanupErrors.push(`interrupt browser: ${error.message}`));
  app?.jarvis.events.terminateAll();
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

function checkInterrupted() {
  if (interrupted !== undefined) throw interrupted;
}

function assertInside(parent, path, label) {
  const child = relative(parent, resolve(path));
  assert.ok(child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child), `${label} must be inside isolated data`);
}

function assertOrigin(baseUrl) {
  const url = new URL(baseUrl);
  assert.equal(url.hostname, "127.0.0.1", "only an isolated loopback app is allowed");
  assert.ok(url.port !== "" && url.port !== "9528", "production port 9528 is forbidden");
}

async function api(baseUrl, path, body, method = "POST") {
  checkInterrupted();
  assertOrigin(baseUrl);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

async function makePngs() {
  const page = await browser.newPage();
  try {
    const encoded = await page.evaluate((fixtures) => Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => {
      const canvas = document.createElement("canvas");
      canvas.width = fixture.width;
      canvas.height = fixture.height;
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Canvas fixture encoder unavailable");
      context.fillStyle = `rgb(${fixture.rgba.slice(0, 3).join(",")})`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return [name, canvas.toDataURL("image/png")];
    })), shapes);
    return Object.fromEntries(Object.entries(encoded).map(([name, dataUrl]) => [name, { ...shapes[name], dataUrl, bytes: Buffer.from(dataUrl.split(",")[1], "base64") }]));
  } finally {
    await page.close();
  }
}

function createFixture(ref, workspacePath) {
  const services = app.jarvis;
  const active = services.sessions.active.get(`${ref.workspaceId}:${ref.sessionId}`);
  assert.ok(active, "isolated session was not opened");
  const manager = active.session.sessionManager;
  assertInside(dataRoot, manager.getSessionFile(), "session JSONL");
  assert.equal(resolve(active.cwd), resolve(workspacePath));
  const handler = services.sessions.piEvents;
  let timestamp = Date.now();
  const nextTimestamp = () => timestamp = Math.max(Date.now(), timestamp + 1);
  const assistant = (content, extra = {}) => ({
    role: "assistant", timestamp: nextTimestamp(), content, stopReason: "stop", api: "openai-completions", provider: "local-image-smoke", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...extra,
  });
  const end = (message) => {
    handler.handle(active, { type: "message_end", message });
    // Match Pi's event-before-persistence ordering, as ui-fold-smoke does.
    manager.appendMessage(message);
  };
  const start = () => {
    handler.handle(active, { type: "agent_start" });
    assert.ok(active.state.activeRun?.id, "missing run.started identity");
    return active.state.activeRun.id;
  };
  const settle = () => handler.handle(active, { type: "agent_settled" });
  const update = (message, event) => handler.handle(active, { type: "message_update", message, assistantMessageEvent: { ...event, partial: message } });
  const user = (text, image) => end({ role: "user", timestamp: nextTimestamp(), content: [{ type: "text", text }, ...(image === undefined ? [] : [{ type: "image", mimeType: "image/png", data: image.bytes.toString("base64") }])] });
  const tool = (id, image) => {
    const call = { type: "toolCall", id, name: "read", arguments: { path: "cache.png" } };
    end(assistant([call], { stopReason: "toolUse" }));
    handler.handle(active, { type: "tool_execution_start", toolCallId: id, toolName: "read", args: call.arguments });
    const content = [{ type: "text", text: "Saved fixture image snapshot" }, { type: "image", mimeType: "image/png", data: image.bytes.toString("base64") }];
    handler.handle(active, { type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content }, isError: false });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", timestamp: nextTimestamp(), content, isError: false });
  };
  return { active, assistant, end, start, settle, update, user, tool };
}

async function waitForIdle(fixture) {
  const deadline = Date.now() + 10_000;
  while (fixture.active.state.runState !== "idle") {
    checkInterrupted();
    assert.ok(Date.now() < deadline, "SessionService did not settle the fixture run");
    await new Promise((done) => setTimeout(done, 50));
  }
}

async function paint(page) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function waitForSocket(page, sessionId) {
  await page.waitForFunction((id) => (window.__imageCacheSockets ?? []).some((socket) => socket.url.includes(`/sessions/${id}/events`) && socket.readyState === WebSocket.OPEN), sessionId);
}

async function waitForEvent(page, sessionId, type, runId) {
  await page.waitForFunction((expected) => (window.__imageCacheEvents ?? []).some((event) => event.sessionId === expected.sessionId && event.type === expected.type && event.runId === expected.runId), { sessionId, type, runId });
  await paint(page);
}

const messageImage = (alt) => `.timeline-shell img.message-image[alt="${alt}"]`;

async function imageState(page, selector, expected, { previous, scroll = true } = {}) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "attached" });
  if (scroll) await locator.scrollIntoViewIfNeeded();
  await page.waitForFunction(({ selector, width, height, previous }) => {
    const image = document.querySelector(selector);
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth === width && image.naturalHeight === height && (previous === undefined || image.getAttribute("src") !== previous);
  }, { selector, width: expected.width, height: expected.height, previous });
  const state = await locator.evaluate((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas pixel inspection unavailable");
    context.drawImage(image, 0, 0);
    const points = [[0, 0], [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)], [canvas.width - 1, canvas.height - 1]];
    return { src: image.getAttribute("src"), currentSrc: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight, pixels: points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]) };
  });
  assert.deepEqual(state.pixels, [expected.rgba, expected.rgba, expected.rgba], `${selector}: decoded pixels do not match the current fixture`);
  return state;
}

function localVersion(state, baseUrl) {
  const url = new URL(state.src, baseUrl);
  assert.equal(url.origin, baseUrl);
  assert.equal(url.pathname, "/api/files");
  const version = url.searchParams.get("v");
  assert.ok(version !== null && version !== "", `${url.pathname}: expected a nonempty v`);
  url.searchParams.delete("v");
  return { version, fileUrl: url.href };
}

function assertNewVersion(previous, current, baseUrl) {
  const before = localVersion(previous, baseUrl);
  const after = localVersion(current, baseUrl);
  assert.equal(after.fileUrl, before.fileUrl, "refresh must keep the same local file reference");
  assert.notEqual(after.version, before.version, "refresh must change v even when the file path stays the same");
}

function evidence(state) {
  return { ...state, src: state.src.startsWith("data:") ? "data:image/png;base64,[fixture]" : state.src, currentSrc: state.currentSrc.startsWith("data:") ? "data:image/png;base64,[fixture]" : state.currentSrc, sourceHash: createHash("sha256").update(state.src).digest("hex") };
}

async function runCase(page, label, name, action) {
  checkInterrupted();
  const entry = report.cases.find((item) => item.label === label && item.name === name);
  entry.status = "running";
  const started = Date.now();
  try {
    const details = await action();
    const screenshot = join(artifacts, `${label}-${name}.png`);
    await page.screenshot({ path: screenshot });
    Object.assign(entry, { status: "passed", details, screenshot });
  } catch (error) {
    Object.assign(entry, { status: "failed", error: error.stack ?? String(error) });
    const screenshot = join(artifacts, `${label}-${name}-failed.png`);
    await page.screenshot({ path: screenshot, timeout: 5_000 }).then(() => { entry.screenshot = screenshot; }).catch(() => undefined);
    await page.locator("body").ariaSnapshot({ timeout: 5_000 }).then((snapshot) => writeFile(join(artifacts, `${label}-${name}-failed.md`), snapshot)).catch(() => undefined);
    throw error;
  } finally {
    entry.durationMs = Date.now() - started;
  }
}

async function openChat(page, baseUrl, ref, label) {
  const navigate = () => page.goto(`${baseUrl}/#/chat/${ref.workspaceId}/${ref.sessionId}`, { waitUntil: "domcontentloaded" });
  try {
    await navigate();
    await page.locator(".timeline-shell").waitFor();
    await waitForSocket(page, ref.sessionId);
  } catch (error) {
    if (label === "mobile") {
      await page.screenshot({ path: join(artifacts, "mobile-startup-failed.png"), timeout: 5_000 }).catch(() => undefined);
      await page.locator("body").ariaSnapshot({ timeout: 5_000 }).then((snapshot) => writeFile(join(artifacts, "mobile-startup-failed.md"), snapshot)).catch(() => undefined);
    }
    const state = label === "mobile" ? await bounded(mobileReloadState(page, ref), "startup state").catch(() => "unavailable") : { hash: await page.evaluate(() => location.hash) };
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: 5_000 }).catch(() => "unavailable");
    throw new Error(`${error.message}; startup state: ${JSON.stringify(state)}; body: ${snapshot}`, { cause: error });
  }
}

async function showToolSnapshot(page) {
  const summary = page.locator(".tool-summary").filter({ hasText: "cache.png" });
  if (await summary.count() === 0) {
    const process = page.locator(".turn-process-summary").first();
    await process.waitFor();
    if (await process.getAttribute("aria-expanded") !== "true") await process.click();
  }
  await summary.waitFor();
  if (await summary.getAttribute("aria-expanded") !== "true") await summary.click();
}

async function foregroundRefresh(page, ref) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/runtime` && response.ok());
  await page.evaluate(() => {
    if (document.visibilityState !== "visible") throw new Error("foreground refresh requires a visible document");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await (await response).finished();
  await paint(page);
}

async function closeLightbox(page) {
  await page.locator('.image-lightbox button[aria-label="关闭图片预览"]').click();
  await page.locator(".image-lightbox").waitFor({ state: "detached" });
  await paint(page);
}

async function mobileReloadState(page, ref) {
  return page.evaluate(async ({ workspaceId, sessionId }) => {
    const response = await fetch(`/api/workspaces/${workspaceId}/sessions`);
    const payload = response.ok ? await response.json() : undefined;
    const sessions = payload !== null && typeof payload === "object" && Array.isArray(payload?.sessions) ? payload.sessions : undefined;
    return {
      hash: location.hash,
      storedWorkspace: localStorage.getItem("jarvis.workspace"),
      storedSession: localStorage.getItem("jarvis.session"),
      sessionsStatus: response.status,
      listedSessionIds: sessions?.map((session) => session.id) ?? [],
      targetSessionListed: sessions?.some((session) => session.id === sessionId) ?? false,
    };
  }, ref);
}

async function openFileBrowser(page, label) {
  if (label === "mobile") {
    await page.getByRole("button", { name: "当前会话操作", exact: true }).click();
    await page.locator(".action-sheet").getByRole("button", { name: "文件", exact: true }).click();
  } else {
    await page.locator(".chat-header").getByRole("button", { name: "文件", exact: true }).click();
  }
  await page.locator(".file-browser-dialog").waitFor();
}

async function selectFile(page, label, name) {
  const dialog = page.locator(".file-browser-dialog");
  if (label === "mobile" && await dialog.getByRole("button", { name: "返回目录", exact: true }).count() > 0) {
    await dialog.getByRole("button", { name: "返回目录", exact: true }).click();
  }
  await dialog.locator(".file-browser-sidebar").getByRole("button", { name, exact: true }).click();
}

async function closeFileBrowser(page) {
  await page.locator('.file-browser-dialog button[aria-label="关闭"]').click();
  await page.locator(".file-browser-dialog").waitFor({ state: "detached" });
  await paint(page);
}

async function exercise(baseUrl, pngs, label, viewport) {
  for (const name of caseNames) report.cases.push({ label, name, status: "pending" });
  const workspacePath = join(dataRoot, `workspace-${label}`);
  await mkdir(workspacePath);
  const imagePath = join(workspacePath, "cache.png");
  const overwrite = (name) => writeFile(imagePath, pngs[name].bytes);
  await overwrite("initial");
  await writeFile(join(workspacePath, "preview.md"), "![cache-file-markdown](cache.png)\n");
  const { workspace } = await api(baseUrl, "/api/workspaces", { cwd: workspacePath, label: `Image cache ${label}` });
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, {});
  const ref = { workspaceId: workspace.id, sessionId: session.id };
  const fixture = createFixture(ref, workspacePath);
  const remoteUrl = `${baseUrl}/__local-image-smoke__/remote.png?keep=fixture`;
  const explicitApi = `/api/files?path=cache.png&cwd=${encodeURIComponent(workspacePath)}`;
  fixture.start();
  fixture.user(`Image cache fixture ${label}`, pngs.initial);
  fixture.tool(`cache-read-${label}`, pngs.initial);
  fixture.end(fixture.assistant([{ type: "text", text: [
    "![cache-local](cache.png)",
    `![cache-absolute](${encodeURI(imagePath.replaceAll("\\", "/"))})`,
    `![cache-api](${explicitApi})`,
    `![cache-http](${remoteUrl})`,
    `![cache-data](${pngs.initial.dataUrl})`,
    "![cache-missing](later.png)",
  ].join("\n\n") }]));
  fixture.settle();
  await waitForIdle(fixture);
  const { session: sibling } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, {});
  const siblingFixture = createFixture({ workspaceId: workspace.id, sessionId: sibling.id }, workspacePath);
  siblingFixture.start();
  siblingFixture.user(`Image cache navigation ${label}`);
  siblingFixture.end(siblingFixture.assistant([{ type: "text", text: `Navigation fixture ${label}` }]));
  siblingFixture.settle();
  await waitForIdle(siblingFixture);

  const context = await browser.newContext({ viewport, ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  try {
    await context.addInitScript(() => {
      window.localStorage.setItem("jarvis.sessions.focus", "false");
      window.__imageCacheSockets = [];
      window.__imageCacheEvents = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__imageCacheSockets.push(this);
          this.addEventListener("message", ({ data }) => {
            try {
              const event = JSON.parse(data);
              if (typeof event.seq === "number") window.__imageCacheEvents.push(event);
            } catch { /* Heartbeats are not session events. */ }
          });
        }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on("pageerror", (error) => report.pageErrors.push({ label, message: error.message }));
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== "/api/files") return;
      report.responses.push({ label, url: response.url(), status: response.status(), cacheControl: response.headers()["cache-control"] ?? null });
    });
    await openChat(page, baseUrl, ref, label);
    const localAlts = ["cache-local", "cache-absolute", "cache-api"];
    let locals;
    let controls;
    let missingSource;
    const controlSelectors = { http: messageImage("cache-http"), data: messageImage("cache-data"), userAttachment: ".message-row.user .message-images img", toolSnapshot: ".tool-images img" };
    const readLocals = async (shape, previous, scroll = true) => {
      const result = {};
      for (const alt of localAlts) {
        const state = await imageState(page, messageImage(alt), pngs[shape], { previous: previous?.[alt]?.src, scroll });
        localVersion(state, baseUrl);
        if (previous !== undefined) assertNewVersion(previous[alt], state, baseUrl);
        result[alt] = state;
      }
      return result;
    };
    const readControls = async () => {
      await showToolSnapshot(page);
      const result = {};
      for (const [name, selector] of Object.entries(controlSelectors)) result[name] = await imageState(page, selector, pngs.initial);
      return result;
    };
    const unchangedControls = async () => {
      const current = await readControls();
      for (const name of Object.keys(controls)) assert.deepEqual(current[name], controls[name], `${name}: refresh changed an immutable image URL/content`);
      return Object.fromEntries(Object.entries(current).map(([name, state]) => [name, evidence(state)]));
    };
    const localEvidence = () => Object.fromEntries(Object.entries(locals).map(([alt, state]) => [alt, evidence(state)]));

    await runCase(page, label, "saved-images", async () => {
      locals = await readLocals("initial");
      controls = await readControls();
      assert.equal(controls.http.src, remoteUrl, "fully qualified HTTP image must keep its URL");
      assert.equal(controls.data.src, pngs.initial.dataUrl);
      assert.equal(controls.userAttachment.src, pngs.initial.dataUrl);
      const toolUrl = new URL(controls.toolSnapshot.src, baseUrl);
      assert.ok(toolUrl.pathname.startsWith(`/api/workspaces/${workspace.id}/sessions/${session.id}/media/`));
      assert.equal(toolUrl.searchParams.has("v"), false, "tool snapshot must not receive a local file version");
      return { localImages: localEvidence(), controls: await unchangedControls() };
    });

    await runCase(page, label, "initial-404", async () => {
      const fallback = page.locator('.message-image-fallback[aria-label="cache-missing"]');
      await fallback.waitFor();
      await fallback.scrollIntoViewIfNeeded();
      missingSource = await fallback.locator("a").getAttribute("href");
      localVersion({ src: missingSource }, baseUrl);
      assert.ok(report.responses.some((response) => response.label === label && response.status === 404 && new URL(response.url).searchParams.get("path") === "later.png"), "initial missing image did not produce a real HTTP 404");
      return { fallbackUrl: missingSource };
    });

    let streaming;
    let runId;
    await runCase(page, label, "stream-deltas", async () => {
      runId = fixture.start();
      streaming = fixture.assistant([{ type: "text", text: "![cache-stream](cache.png)\n\ncache-stream-0" }]);
      fixture.update(streaming, { type: "text_start", contentIndex: 0 });
      fixture.update(streaming, { type: "text_delta", contentIndex: 0, delta: streaming.content[0].text });
      const streamImage = await imageState(page, messageImage("cache-stream"), pngs.initial);
      localVersion(streamImage, baseUrl);
      localAlts.push("cache-stream");
      locals["cache-stream"] = streamImage;
      const versions = {};
      for (let index = 1; index <= 3; index += 1) {
        const delta = `\n\ncache-stream-${index}`;
        streaming.content[0].text += delta;
        fixture.update(streaming, { type: "text_delta", contentIndex: 0, delta });
        await page.getByText(`cache-stream-${index}`, { exact: true }).waitFor();
        await paint(page);
        for (const alt of localAlts) {
          const current = await imageState(page, messageImage(alt), pngs.initial);
          assert.deepEqual(current, locals[alt], `${alt}: text delta changed the loaded local image`);
          (versions[alt] ??= []).push(localVersion(current, baseUrl).version);
        }
      }
      return { runId, versions, diskFixture: "settled", displayedFixture: "initial" };
    });

    await runCase(page, label, "run-settled-open-preview", async () => {
      await page.locator(messageImage("cache-local")).click();
      const previewBefore = await imageState(page, ".image-lightbox img", pngs.initial);
      assert.equal(previewBefore.src, locals["cache-local"].src, "preview and thumbnail must share exactly the same URL");
      await overwrite("settled");
      fixture.end(streaming);
      fixture.settle();
      await waitForEvent(page, session.id, "run.settled", runId);
      locals = await readLocals("settled", locals, false);
      const previewAfter = await imageState(page, ".image-lightbox img", pngs.settled, { previous: previewBefore.src });
      assert.equal(previewAfter.src, locals["cache-local"].src, "an already open preview must update with its thumbnail");
      const details = { runId, localImages: localEvidence(), preview: evidence(previewAfter) };
      await page.screenshot({ path: join(artifacts, `${label}-settled-preview-open.png`) });
      await closeLightbox(page);
      await unchangedControls();
      return details;
    });

    await runCase(page, label, "run-failed", async () => {
      const failedRunId = fixture.start();
      await overwrite("failed");
      fixture.end(fixture.assistant([], { stopReason: "error", errorMessage: "Fixture failure after image overwrite" }));
      fixture.settle();
      await waitForEvent(page, session.id, "run.failed", failedRunId);
      locals = await readLocals("failed", locals);
      await unchangedControls();
      return { runId: failedRunId, localImages: localEvidence() };
    });

    await runCase(page, label, "page-refresh", async () => {
      await overwrite("reloaded");
      const beforeReload = label === "mobile" ? await mobileReloadState(page, ref) : { hash: await page.evaluate(() => location.hash) };
      await page.reload({ waitUntil: "domcontentloaded" });
      try {
        await page.locator(".timeline-shell").waitFor();
      } catch (error) {
        const afterReload = label === "mobile" ? await mobileReloadState(page, ref) : { hash: await page.evaluate(() => location.hash) };
        throw new Error(`${error.message}; before reload: ${JSON.stringify(beforeReload)}; after reload: ${JSON.stringify(afterReload)}`, { cause: error });
      }
      await waitForSocket(page, session.id);
      locals = await readLocals("reloaded", locals);
      await unchangedControls();
      return { localImages: localEvidence() };
    });

    await runCase(page, label, "foreground-refresh", async () => {
      await overwrite("foreground");
      await foregroundRefresh(page, ref);
      locals = await readLocals("foreground", locals);
      await unchangedControls();
      return { localImages: localEvidence() };
    });

    await runCase(page, label, "404-recovery", async () => {
      const fallback = page.locator('.message-image-fallback[aria-label="cache-missing"]');
      await fallback.waitFor();
      const previous = { src: await fallback.locator("a").getAttribute("href") };
      await writeFile(join(workspacePath, "later.png"), pngs.recovered.bytes);
      await foregroundRefresh(page, ref);
      const recovered = await imageState(page, messageImage("cache-missing"), pngs.recovered);
      assertNewVersion(previous, recovered, baseUrl);
      assert.equal(await fallback.count(), 0, "successful reload must remove the 404 fallback");
      locals = await readLocals("foreground", locals);
      await unchangedControls();
      return { initial404Url: missingSource, beforeCreationUrl: previous.src, recovered: evidence(recovered) };
    });

    await runCase(page, label, "navigate-and-reopen", async () => {
      if (label === "mobile") {
        await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
        await page.locator(".mobile-all-sessions-page").waitFor();
      } else {
        await page.locator(`.desktop-sidebar .session-row[data-session-id="${sibling.id}"]`).click();
        await page.getByText(`Navigation fixture ${label}`, { exact: true }).waitFor();
      }
      await overwrite("navigated");
      if (label === "mobile") {
        const sessionRow = page.locator(`.mobile-session-row[data-session-id="${session.id}"]`);
        if (await sessionRow.count() === 0) {
          await page.getByRole("button", { name: `展开${workspace.label}的会话`, exact: true }).click();
        }
        await sessionRow.waitFor();
        await sessionRow.locator(".mobile-session-select").click();
      } else {
        await page.locator(`.desktop-sidebar .session-row[data-session-id="${session.id}"]`).click();
      }
      await page.locator(".timeline-shell").waitFor();
      await waitForSocket(page, session.id);
      locals = await readLocals("navigated", locals);
      await unchangedControls();
      return { strategy: label === "mobile" ? "back to session list and reopen" : "switch to sibling session and return", localImages: localEvidence() };
    });

    const fileImage = ".file-browser-dialog .file-preview-image img";
    let fileState;
    await runCase(page, label, "file-reselect", async () => {
      await openFileBrowser(page, label);
      await selectFile(page, label, "cache.png");
      const before = await imageState(page, fileImage, pngs.navigated);
      localVersion(before, baseUrl);
      await page.locator(fileImage).click();
      const preview = await imageState(page, ".image-lightbox img", pngs.navigated);
      assert.equal(preview.src, before.src, "file preview and thumbnail URLs differ");
      await closeLightbox(page);
      await overwrite("reselected");
      await selectFile(page, label, "cache.png");
      fileState = await imageState(page, fileImage, pngs.reselected, { previous: before.src });
      assertNewVersion(before, fileState, baseUrl);
      return { before: evidence(before), reselected: evidence(fileState) };
    });

    await runCase(page, label, "file-close-and-reopen", async () => {
      await closeFileBrowser(page);
      await overwrite("reopened");
      await openFileBrowser(page, label);
      await selectFile(page, label, "cache.png");
      const reopened = await imageState(page, fileImage, pngs.reopened, { previous: fileState.src });
      assertNewVersion(fileState, reopened, baseUrl);
      await page.locator(fileImage).click();
      const preview = await imageState(page, ".image-lightbox img", pngs.reopened);
      assert.equal(preview.src, reopened.src);
      await closeLightbox(page);
      return { reopened: evidence(reopened), preview: evidence(preview) };
    });

    await runCase(page, label, "file-markdown-reopen", async () => {
      await selectFile(page, label, "preview.md");
      const selector = '.file-browser-dialog img.message-image[alt="cache-file-markdown"]';
      const before = await imageState(page, selector, pngs.reopened);
      localVersion(before, baseUrl);
      await closeFileBrowser(page);
      await overwrite("markdown");
      await openFileBrowser(page, label);
      await selectFile(page, label, "preview.md");
      const reopened = await imageState(page, selector, pngs.markdown, { previous: before.src });
      assertNewVersion(before, reopened, baseUrl);
      return { before: evidence(before), reopened: evidence(reopened) };
    });

    await runCase(page, label, "snapshot-controls", async () => {
      await closeFileBrowser(page);
      await foregroundRefresh(page, ref);
      locals = await readLocals("markdown", locals);
      const immutableImages = await unchangedControls();
      const localResponses = report.responses.filter((response) => response.label === label);
      assert.ok(localResponses.some((response) => response.status === 200));
      assert.ok(localResponses.some((response) => response.status === 404));
      assert.ok(localResponses.every((response) => /(?:^|[,\s])no-store(?:$|[,\s])/i.test(response.cacheControl ?? "")), "local image responses, including 404, must use no-store");
      assert.deepEqual(report.pageErrors.filter((error) => error.label === label), [], "browser runtime errors");
      return { immutableImages, localImages: localEvidence(), noStoreResponses: localResponses.length };
    });
  } finally {
    for (const entry of report.cases.filter((entry) => entry.label === label && entry.status === "pending")) entry.status = "blocked";
    await context.close();
  }
}

try {
  // Check the build without importing server/index.js or starting any service.
  await access(join(repoRoot, "dist/server/server/app.js")).catch(() => { throw new Error("Missing dist/server/server/app.js; build the app before running this script"); });
  await access(join(repoRoot, "dist/client/index.html")).catch(() => { throw new Error("Missing dist/client/index.html; build the app before running this script"); });
  dataRoot = await mkdtemp(join(tmpdir(), "jarvis-local-image-cache-data-"));
  const home = join(dataRoot, "home");
  const agentDir = join(home, "agent");
  const sessionDir = join(home, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  process.env.JARVIS_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  process.env.NODE_ENV = "production";
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.PORT;
  delete process.env.JARVIS_DESKTOP;
  process.chdir(dataRoot);
  await writeFile(join(home, "workspaces.json"), JSON.stringify({ version: 1, workspaces: [] }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local-image-smoke", defaultModel: "fixture", enabledModels: ["local-image-smoke/fixture"], packages: [] }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "local-image-smoke": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture-only", models: [{ id: "fixture", input: ["text", "image"] }] } } }));
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  assert.equal(resolve(getAgentDir()), resolve(agentDir), "Pi profile isolation failed");
  checkInterrupted();
  browser = await chromium.launch({ headless: true });
  checkInterrupted();
  const pngs = await makePngs();
  const { buildApp } = await import(pathToFileURL(join(repoRoot, "dist/server/server/app.js")).href);
  app = await buildApp({ serveStatic: true, staticRoot: join(repoRoot, "dist/client") });
  // A full HTTP URL is a remote-image control to the Markdown renderer; keep
  // its bytes constant without depending on the internet or a second service.
  app.get("/__local-image-smoke__/remote.png", (_request, reply) => reply.type("image/png").header("cache-control", "private, max-age=3600").send(pngs.initial.bytes));
  checkInterrupted();
  const baseUrl = new URL(await app.listen({ host: "127.0.0.1", port: 0 })).origin;
  assertOrigin(baseUrl);
  report.baseUrl = baseUrl;
  for (const [label, viewport] of [["desktop", { width: 1440, height: 960 }], ["mobile", { width: 390, height: 844 }]]) {
    checkInterrupted();
    try {
      await exercise(baseUrl, pngs, label, viewport);
    } catch (error) {
      report.failures.push({ label, error: error.stack ?? String(error) });
      process.exitCode = 1;
      console.error(`${label}: ${error.message ?? String(error)}`);
    }
  }
} catch (error) {
  report.failures.push({ error: error.stack ?? String(error) });
  process.exitCode ||= 1;
  console.error(error.message ?? String(error));
} finally {
  // Each cleanup step is attempted even if an earlier one fails. Only handles
  // created above are closed; artifacts intentionally outlive isolated data.
  for (const [name, cleanup] of [
    ["browser", async () => { await browser?.close(); }],
    ["eventHub", async () => { app?.jarvis.events.terminateAll(); }],
    ["app", async () => { await app?.close(); }],
  ]) {
    try { await cleanup(); } catch (error) { report.cleanupErrors.push(`${name}: ${error.message ?? String(error)}`); }
  }
  process.chdir(previousCwd);
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  if (dataRoot !== undefined) {
    try { await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (error) { report.cleanupErrors.push(`isolated data: ${error.message ?? String(error)}`); }
  }
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  if (report.cleanupErrors.length > 0 || report.pageErrors.length > 0) process.exitCode ||= 1;
  report.finishedAt = new Date().toISOString();
  report.ok = !process.exitCode && report.failures.length === 0 && report.cases.length === caseNames.length * 2 && report.cases.every((entry) => entry.status === "passed");
  if (!report.ok) process.exitCode ||= 1;
  await writeFile(join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.ok ? "OK" : "FAILED"}: ${report.cases.filter((entry) => entry.status === "passed").length}/${caseNames.length * 2} image cache cases; report: ${join(artifacts, "report.json")}`);
}
