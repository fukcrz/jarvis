import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

// 子代理详情（右侧栏 / 移动端对话框同一个组件）的运行时验收：
// 注入线程表与实时输出，断言列表、概览、输出页三处内容，并截图。

const shotDir = process.env.JARVIS_SMOKE_SHOTS ?? join(tmpdir(), "jarvis-subagent-detail-smoke");
const envKeys = ["JARVIS_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "JARVIS_DESKTOP"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const failures = [];

let temporaryRoot;
let app;
let browser;

async function api(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}

async function paint(page) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

const threads = [
  { path: "/root/researcher", type: "researcher", state: "running", line: "核对右侧栏详情的实时输出接线", startedAt: new Date(Date.now() - 96_000).toISOString() },
  { path: "/root/researcher/scout", type: "scout", state: "running", parent: "/root/researcher", line: "读 src/client/components/subagent-detail.tsx", startedAt: new Date(Date.now() - 42_000).toISOString() },
  { path: "/root/reviewer", type: "reviewer", state: "paused", line: "等确认后继续", startedAt: new Date(Date.now() - 41_000).toISOString(), elapsedMs: 41_000 },
];

const streamItems = [
  { id: "s1", kind: "text", text: "先确认面板是否收到实时增量。", at: new Date().toISOString() },
  { id: "t1", kind: "tool", name: "read", text: "subagent-detail.tsx", state: "completed", at: new Date().toISOString() },
  { id: "s2", kind: "text", text: "现在跑类型检查，随后截图核对。", at: new Date().toISOString(), streaming: true },
];

function withThreads(summary, next) {
  const copy = { ...summary };
  copy.subagentThreads = next;
  return copy;
}

async function emit(page, { workspaceId, sessionId, summary, stream }) {
  const base = { version: 1, sessionId, runId: "smoke-run", emittedAt: new Date().toISOString(), payload: { status: { sessionId, runState: "running" }, session: summary } };
  await page.evaluate(({ workspaceId, sessionId, event, streamEvent, workspaceEvent }) => {
    const next = () => (window.__smokeSeq = (window.__smokeSeq ?? 700_000_000) + 1);
    for (const socket of window.__jarvisSockets ?? []) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.url.includes(`/sessions/${sessionId}/events`)) {
        if (streamEvent !== null) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...streamEvent, seq: next() }) }));
        socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...event, seq: next() }) }));
      }
      if (socket.url.includes(`/workspaces/${workspaceId}/events`)) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(workspaceEvent) }));
    }
  }, {
    workspaceId,
    sessionId,
    event: base,
    streamEvent: stream === undefined ? null : { version: 1, sessionId, seq: 0, emittedAt: new Date().toISOString(), type: "subagent.stream", payload: stream },
    workspaceEvent: { version: 1, type: "session.updated", workspaceId, session: summary },
  });
  await paint(page);
}

async function exercise(baseUrl, workspace, label, viewport) {
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, {});
  const deadline = Date.now() + 10_000;
  while (true) {
    const { sessions } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`);
    if (sessions.some((entry) => entry.id === session.id)) break;
    assert.ok(Date.now() < deadline, `${label}: new session was not listed`);
    await new Promise((done) => setTimeout(done, 100));
  }
  const listed = (await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`)).sessions.find((entry) => entry.id === session.id);
  const context = await browser.newContext({ viewport, ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  try {
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__jarvisSockets = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) { super(...args); window.__jarvisSockets.push(this); }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => failures.push(`${label}: page error: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") failures.push(`${label}: console error: ${message.text()}`); });
    if (label === "mobile") {
      // 移动端没有右侧栏：详情从时间线的子代理记录打开，记录只能来自历史页。
      await page.route("**/timeline*", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.items.push({
          kind: "subagent-record",
          id: "subagent-record:/root/researcher:dispatched",
          createdAt: new Date().toISOString(),
          path: "/root/researcher",
          agent: "researcher",
          prompt: "核对右侧栏详情的实时输出接线",
          state: "dispatched",
          fullPrompt: "核对右侧栏详情的实时输出接线",
        });
        await route.fulfill({ response, json: body });
      });
    }
    const runtimeLoaded = page.waitForResponse((response) => response.url().endsWith(`/sessions/${session.id}/runtime`) && response.ok());
    await page.goto(`${baseUrl}/#/chat/${workspace.id}/${session.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(({ id, workspaceId }) => (window.__jarvisSockets ?? []).some((socket) => (socket.url.includes(`/sessions/${id}/events`) || socket.url.includes(`/workspaces/${workspaceId}/events`)) && socket.readyState === 1), { id: session.id, workspaceId: workspace.id });
    await runtimeLoaded;
    await page.locator(".composer-editor .cm-content").waitFor();
    await paint(page);

    const base = { ...listed };
    delete base.subagentThreads;
    await emit(page, { workspaceId: workspace.id, sessionId: session.id, summary: withThreads(base, threads), stream: { path: "/root/researcher", items: streamItems } });

    if (label === "mobile") {
      // 记录落在回合的过程段里，默认折叠：先展开再点。
      const collapsers = page.locator(".turn-process.collapsed .turn-process-summary");
      for (let index = 0; index < await collapsers.count(); index += 1) await collapsers.nth(index).click();
      const record = page.locator("[data-subagent-paths~='/root/researcher'] .subagent-record-summary");
      await record.waitFor({ state: "visible" });
      await record.click();
      const dialog = page.locator('[role="dialog"]:has(.subagent-detail)');
      await dialog.waitFor({ state: "visible" });
      const box = await dialog.locator(".subagent-detail").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), viewport: innerWidth };
      });
      assert.ok(box.width > 0 && box.height > 0, `${label}: detail dialog must have size`, box);
      assert.ok(box.width <= box.viewport + 1, `${label}: detail must not overflow: ${box.width} > ${box.viewport}`);
      assert.equal(await dialog.locator(".subagent-detail-block h3").first().textContent(), "当前动作", `${label}: overview blocks`);
      await page.screenshot({ path: join(shotDir, `${label}-record.png`) });
      await dialog.locator('[role="tab"]', { hasText: "输出" }).click();
      await dialog.locator(".subagent-output").waitFor({ state: "visible" });
      assert.equal(await dialog.locator(".subagent-output-text").count(), 2, `${label}: streamed text rows in the dialog`);
      await page.screenshot({ path: join(shotDir, `${label}-output.png`) });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      return;
    }

    await page.locator('[aria-label="子代理"]').first().click();
    await page.locator(".subagent-panel .subagent-row").first().waitFor({ state: "visible" });
    const kinds = await page.locator(".subagent-row-agent").evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
    assert.deepEqual(kinds, ["researcher", "scout", "reviewer"], `${label}: list must show every thread in tree order`);
    await page.screenshot({ path: join(shotDir, `${label}-list.png`) });

    await page.locator(".subagent-row").first().click();
    const detail = page.locator(".subagent-detail");
    await detail.waitFor({ state: "visible" });
    const overview = await detail.evaluate((node) => ({
      title: node.querySelector(".subagent-detail-title")?.textContent?.trim(),
      status: node.querySelector(".subagent-detail-status")?.textContent?.trim(),
      blocks: [...node.querySelectorAll(".subagent-detail-block h3")].map((heading) => heading.textContent?.trim()),
      action: node.querySelector(".subagent-detail-block p")?.textContent?.trim(),
    }));
    assert.equal(overview.title, "/root/researcher", `${label}: detail title`);
    assert.match(overview.status ?? "", /researcher.*运行中/, `${label}: detail status`);
    assert.deepEqual(overview.blocks, ["当前动作", "任务"], `${label}: overview blocks`);
    assert.equal(overview.action, "核对右侧栏详情的实时输出接线", `${label}: current action must be the live line`);
    await page.screenshot({ path: join(shotDir, `${label}-overview.png`) });

    await detail.locator('[role="tab"]', { hasText: "输出" }).click();
    await page.locator(".subagent-output").waitFor({ state: "visible" });
    const output = await page.locator(".subagent-output").evaluate((node) => ({
      texts: [...node.querySelectorAll(".subagent-output-text")].map((item) => item.textContent?.trim()),
      tools: [...node.querySelectorAll(".subagent-output-tool-name")].map((item) => item.textContent?.trim()),
      caret: node.querySelectorAll(".subagent-output-caret").length,
      empty: node.querySelectorAll(".subagent-panel-empty").length,
    }));
    assert.equal(output.tools.length >= 1, true, `${label}: tool rows must render from the live stream`);
    assert.equal(output.texts.length, 2, `${label}: streamed text rows`);
    assert.equal(output.caret, 1, `${label}: streaming row keeps its caret`);
    await page.screenshot({ path: join(shotDir, `${label}-output.png`) });

    await detail.locator('button[aria-label="返回"]').click();
    await page.locator(".subagent-detail").waitFor({ state: "detached" });
    await page.locator(".subagent-row").first().waitFor({ state: "visible" });
  } finally {
    await context.close();
  }
}

try {
  await mkdir(shotDir, { recursive: true });
  temporaryRoot = await mkdtemp(join(tmpdir(), "jarvis-subagent-detail-home-"));
  const workspacePath = join(temporaryRoot, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, "fixture.ts"), "export const detail = 'ready';\n");
  process.env.JARVIS_HOME = join(temporaryRoot, "jarvis");
  process.env.PI_CODING_AGENT_DIR = join(temporaryRoot, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = join(temporaryRoot, "sessions");
  process.env.NODE_ENV = "production";
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.PORT;
  delete process.env.JARVIS_DESKTOP;
  const { buildApp } = await import(pathToFileURL(resolve("dist/server/server/app.js")).href);
  app = await buildApp({ serveStatic: true, staticRoot: resolve("dist/client") });
  const baseUrl = new URL(await app.listen({ host: "127.0.0.1", port: 0 })).origin;
  assert.notEqual(new URL(baseUrl).port, "9528");
  const { workspace } = await api(baseUrl, "/api/workspaces", { cwd: workspacePath, label: "Subagent detail smoke" });
  browser = await chromium.launch({ headless: true });
  for (const [label, viewport] of [["desktop", { width: 1440, height: 960 }], ["mobile", { width: 390, height: 844 }]]) {
    await exercise(baseUrl, workspace, label, viewport);
  }
  assert.deepEqual(failures, []);
  console.log(`OK: subagent detail smoke passed on desktop and mobile; artifacts: ${shotDir}`);
} finally {
  try {
    await writeFile(join(shotDir, "failures.json"), JSON.stringify(failures, null, 2));
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        app?.jarvis.events.terminateAll();
        await app?.close();
      } finally {
        for (const key of envKeys) {
          if (previousEnv[key] === undefined) delete process.env[key];
          else process.env[key] = previousEnv[key];
        }
        if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
}
