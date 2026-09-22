import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const shotDir = process.env["JARVIS_SMOKE_SHOTS"] ?? join(tmpdir(), "jarvis-attention-smoke");
mkdirSync(shotDir, { recursive: true });

const envKeys = ["JARVIS_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NODE_ENV", "PORT", "HOST"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function api(baseUrl, path, options) {
  return fetch(`${baseUrl}${path}`, options).then(async (response) => {
    if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${path} failed with ${String(response.status)}`);
    return response.json();
  });
}

async function emitOnSocket(page, urlPart, event) {
  return page.evaluate(({ part, payload }) => {
    const socket = window.__jarvisSockets?.find((candidate) => candidate.url.includes(part) && candidate.readyState === 1);
    if (socket === undefined) throw new Error(`socket not open: ${part}`);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }, { part: urlPart, payload: event });
}

async function socketOpen(page, urlPart) {
  return page.evaluate((part) => window.__jarvisSockets?.some((candidate) => candidate.url.includes(part) && candidate.readyState === 1) === true, urlPart);
}

const home = await mkdtemp(join(tmpdir(), "jarvis-attention-home-"));
const workspacePath = await mkdtemp(join(tmpdir(), "jarvis-attention-ws-"));
let app;
let browser;
const failures = [];

try {
  process.env.JARVIS_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, "sessions");
  process.env.NODE_ENV = "production";
  process.env.HOST = "127.0.0.1";
  delete process.env.PORT;

  const appModule = await import(pathToFileURL(resolve("dist/server/server/app.js")).href);
  app = await appModule.buildApp({ serveStatic: true, staticRoot: resolve("dist/client") });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = new URL(address).origin;
  if (baseUrl.includes(":9528")) throw new Error("refusing to bind production port 9528");

  const { workspace } = await api(baseUrl, "/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: workspacePath, label: "Attention Smoke" }),
  });
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__jarvisSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__jarvisSockets.push(this);
      }
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));

  let leftChat = false;
  let viewedAfterBack = 0;
  await page.route("**/viewed", async (route) => {
    if (leftChat) viewedAfterBack += 1;
    await route.continue();
  });

  await page.goto(`${baseUrl}/#/chat/${workspace.id}/${session.id}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mobile-chat-header").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction((id) => window.__jarvisSockets?.some((socket) => socket.url.includes(`/sessions/${id}/events`) && socket.readyState === 1), session.id, { timeout: 15_000 });
  await page.waitForFunction((id) => window.__jarvisSockets?.some((socket) => socket.url.includes(`/workspaces/${id}/events`) && socket.readyState === 1), workspace.id, { timeout: 15_000 });

  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const now = new Date().toISOString();
  const runningSummary = {
    ...session,
    preview: "请继续",
    updatedAt: now,
    runState: "running",
    attentionState: "running",
    attentionAt: now,
  };

  await emitOnSocket(page, `/sessions/${session.id}/events`, {
    version: 1,
    sessionId: session.id,
    seq: 900_000_001,
    emittedAt: now,
    type: "run.started",
    payload: { status: { sessionId: session.id, runState: "running", activeRun: { id: "run-attention", startedAt } } },
  });
  await emitOnSocket(page, `/workspaces/${workspace.id}/events`, {
    version: 1,
    type: "session.updated",
    workspaceId: workspace.id,
    session: runningSummary,
  });

  await page.getByRole("button", { name: "返回会话列表" }).click();
  await page.locator(".mobile-all-sessions-page").waitFor({ state: "visible", timeout: 8_000 });
  leftChat = true;

  const sessionSocketAfterBack = await socketOpen(page, `/sessions/${session.id}/events`);
  await page.screenshot({ path: join(shotDir, "01-back-running.png"), fullPage: true });

  const runningVisible = await page.getByRole("status", { name: /执行中/ }).count()
    + await page.getByRole("button", { name: /执行中/ }).count();
  if (runningVisible === 0) failures.push("list did not show running after leaving chat");

  const completedSummary = {
    ...runningSummary,
    runState: "idle",
    attentionState: "completed_unread",
    attentionAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (sessionSocketAfterBack) {
    await emitOnSocket(page, `/sessions/${session.id}/events`, {
      version: 1,
      sessionId: session.id,
      seq: 900_000_002,
      emittedAt: completedSummary.updatedAt,
      type: "run.settled",
      payload: { status: { sessionId: session.id, runState: "idle" } },
    });
    await page.waitForTimeout(200);
  }

  await emitOnSocket(page, `/workspaces/${workspace.id}/events`, {
    version: 1,
    type: "session.updated",
    workspaceId: workspace.id,
    session: completedSummary,
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotDir, "02-after-complete.png"), fullPage: true });

  const completedVisible = await page.getByRole("status", { name: /任务完成未查看/ }).count()
    + await page.getByRole("button", { name: /任务完成未查看/ }).count();
  if (completedVisible === 0) {
    failures.push("completed_unread did not appear after returning to the session list");
  }
  if (viewedAfterBack > 0) {
    failures.push(`POST /viewed ran ${String(viewedAfterBack)} time(s) after leaving chat`);
  }
  if (sessionSocketAfterBack) {
    failures.push("session event socket stayed open on the session list");
  }

  const report = {
    baseUrl,
    sessionSocketAfterBack,
    viewedAfterBack,
    completedVisible,
    screenshots: {
      running: join(shotDir, "01-back-running.png"),
      completed: join(shotDir, "02-after-complete.png"),
    },
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log("attention smoke passed");
} finally {
  await browser?.close();
  await app?.close();
  restoreEnv();
  await rm(home, { force: true, recursive: true });
  await rm(workspacePath, { force: true, recursive: true });
}
