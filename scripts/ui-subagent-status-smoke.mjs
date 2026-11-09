import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

// 子代理状态行与侧栏状态点的视觉验收：注入会话摘要里的 subagentThreads，
// 断言工具栏一行文案、侧栏状态点的颜色，以及点开后的线程列表。

const shotDir = process.env.JARVIS_SMOKE_SHOTS ?? join(tmpdir(), "jarvis-subagent-status-smoke");
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
  { path: "/root/researcher", type: "researcher", state: "running", line: "先看现有原型截图，再核对接线", startedAt: new Date(Date.now() - 252_000).toISOString() },
  { path: "/root/architect", type: "architect", state: "running", line: "产出分类树字段与后端结构", startedAt: new Date(Date.now() - 96_000).toISOString() },
  { path: "/root/reviewer", type: "reviewer", state: "paused", line: "等确认后继续", startedAt: new Date(Date.now() - 41_000).toISOString(), elapsedMs: 41_000 },
];

function withThreads(summary, next) {
  const copy = { ...summary };
  if (next === undefined) delete copy.subagentThreads;
  else copy.subagentThreads = next;
  return copy;
}

async function emitSummary(page, { workspaceId, sessionId, summary }) {
  const base = { version: 1, sessionId, runId: "smoke-run", emittedAt: new Date().toISOString(), payload: { status: { sessionId, runState: "idle" }, session: summary } };
  await page.evaluate(({ workspaceId, sessionId, event, workspaceEvent }) => {
    const sockets = window.__jarvisSockets ?? [];
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.url.includes(`/sessions/${sessionId}/events`)) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...event, seq: (window.__smokeSeq = (window.__smokeSeq ?? 700_000_000) + 1) }) }));
      if (socket.url.includes(`/workspaces/${workspaceId}/events`)) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(workspaceEvent) }));
    }
  }, {
    workspaceId,
    sessionId,
    event: base,
    workspaceEvent: { version: 1, type: "session.updated", workspaceId, session: summary },
  });
  await paint(page);
}

async function exercise(baseUrl, workspace, label, viewport) {
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, {});
  const deadline = Date.now() + 10_000;
  while (true) {
    const { sessions } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`);
    const listed = sessions.find((entry) => entry.id === session.id);
    if (listed !== undefined) break;
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
    const runtimeLoaded = page.waitForResponse((response) => response.url().endsWith(`/sessions/${session.id}/runtime`) && response.ok());
    await page.goto(`${baseUrl}/#/chat/${workspace.id}/${session.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(({ id, workspaceId }) => (window.__jarvisSockets ?? []).some((socket) => (socket.url.includes(`/sessions/${id}/events`) || socket.url.includes(`/workspaces/${workspaceId}/events`)) && socket.readyState === 1), { id: session.id, workspaceId: workspace.id });
    await runtimeLoaded;
    await page.locator(".composer-editor .cm-content").waitFor();
    await paint(page);

    const base = { ...listed };
    delete base.subagentThreads;
    assert.equal(await page.locator(".subagent-status").count(), 0, `${label}: status line must stay hidden without threads`);

    await emitSummary(page, { workspaceId: workspace.id, sessionId: session.id, summary: withThreads(base, threads) });
    await page.locator(".subagent-status").waitFor({ state: "visible" });
    assert.equal(await page.locator(".sidebar-activity.subagents").count(), 1, `${label}: sidebar must mark subagent activity`);

    const layout = await page.evaluate(() => {
      const chip = document.querySelector(".subagent-status");
      const footer = document.querySelector(".composer-footer");
      const editor = document.querySelector(".composer-editor");
      const dot = document.querySelector(".sidebar-activity.subagents");
      const box = chip.getBoundingClientRect();
      const editorBox = editor.getBoundingClientRect();
      const text = [...chip.querySelectorAll("span")].filter((node) => getComputedStyle(node).display !== "none").map((node) => node.textContent?.trim()).filter(Boolean);
      return {
        text,
        label: chip.textContent?.trim(),
        inFooter: footer?.contains(chip) === true,
        aboveEditor: box.bottom <= editor.getBoundingClientRect().top,
        leftGap: Math.abs(box.left - editorBox.left),
        height: box.height,
        width: box.width,
        dotColor: dot === null ? undefined : getComputedStyle(dot).borderTopColor,
        dotAnimation: dot === null ? undefined : getComputedStyle(dot).animationDuration,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      };
    });
    assert.ok(layout.height > 0 && layout.width > 0, `${label}: status line must be visible`, layout);
    assert.equal(layout.inFooter, false, `${label}: status line must not sit inside the composer toolbar`);
    assert.ok(layout.aboveEditor, `${label}: status line must sit above the input box`, layout);
    assert.ok(layout.leftGap <= 8, `${label}: status line must line up with the input box, gap ${layout.leftGap}px`, layout);
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${label}: status line must not overflow: ${layout.documentWidth} > ${layout.viewportWidth}`);
    assert.equal(layout.dotColor, "rgb(127, 210, 200)", `${label}: sidebar must use the subagent colour`);
    assert.deepEqual(layout.text, ["2 个子代理执行中 · 1 已暂停"], `${label}: label`);
    await page.screenshot({ path: join(shotDir, `${label}-status-line.png`) });

    await page.locator(".subagent-status").click();
    const sheet = page.locator(".subagent-status-sheet");
    await sheet.waitFor({ state: "visible" });
    const rows = await page.locator(".subagent-status-row").evaluateAll((nodes) => nodes.map((node) => ({
      type: node.querySelector(".subagent-status-type")?.textContent?.trim(),
      line: node.querySelector(".subagent-status-line")?.textContent?.trim(),
      paused: node.querySelector(".subagent-status-state")?.textContent?.trim(),
      elapsed: node.querySelector(".subagent-status-elapsed")?.textContent?.trim() ?? "",
    })));
    assert.equal(rows.length, 3, `${label}: every unfinished thread needs a row`);
    assert.deepEqual(rows.map((row) => row.type), ["researcher", "architect", "reviewer"]);
    assert.deepEqual(rows.map((row) => row.paused), [undefined, undefined, "已暂停"]);
    assert.ok(rows[0].elapsed.match(/^\d+:\d{2}$/), `${label}: elapsed must be m:ss, got ${rows[0].elapsed}`);
    assert.equal(rows[2].elapsed, "0:41", `${label}: paused thread keeps its frozen elapsed time`);
    await page.screenshot({ path: join(shotDir, `${label}-status-sheet.png`) });
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });

    await emitSummary(page, { workspaceId: workspace.id, sessionId: session.id, summary: withThreads(base, [threads[2]]) });
    await paint(page);
    assert.equal(await page.locator(".subagent-status").count(), 0, `${label}: paused-only threads must not keep the status line`);

    await emitSummary(page, { workspaceId: workspace.id, sessionId: session.id, summary: withThreads(base, []) });
    await page.locator(".subagent-status").waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelectorAll(".sidebar-activity.subagents").length === 0);
  } finally {
    await context.close();
  }
}

try {
  await mkdir(shotDir, { recursive: true });
  temporaryRoot = await mkdtemp(join(tmpdir(), "jarvis-subagent-status-home-"));
  const workspacePath = join(temporaryRoot, "workspace");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, "fixture.ts"), "export const status = 'ready';\n");
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
  const { workspace } = await api(baseUrl, "/api/workspaces", { cwd: workspacePath, label: "Subagent status smoke" });
  browser = await chromium.launch({ headless: true });
  for (const [label, viewport] of [["desktop", { width: 1440, height: 960 }], ["mobile", { width: 390, height: 844 }]]) {
    await exercise(baseUrl, workspace, label, viewport);
  }
  assert.deepEqual(failures, []);
  console.log(`OK: subagent status smoke passed on desktop and mobile; artifacts: ${shotDir}`);
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
