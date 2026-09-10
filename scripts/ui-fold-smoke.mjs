import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

// 回合过程折叠冒烟：运行中展开 → 回合结束自动收起 → 手动展开不被覆盖；
// 失败回合与等待响应的扩展交互、用户 !cmd 所在的回合保持展开。
const baseUrl = (process.env["JARVIS_URL"] ?? "http://127.0.0.1:28471").replace(/\/$/, "");
const screenshotDir = process.env["JARVIS_SMOKE_SHOTS"] ?? tmpdir();
const failures = [];
const browser = await chromium.launch({ headless: true });

async function api(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${path} failed with ${String(response.status)}`);
  return response.json();
}

function emitter(page, sessionId) {
  let sequence = 950_000_000;
  return async (type, payload) => {
    sequence += 1;
    await page.evaluate(({ id, event }) => {
      const socket = window.__jarvisSockets?.find((candidate) => candidate.url.includes(`/sessions/${id}/events`) && candidate.readyState === 1);
      if (socket === undefined) throw new Error("Session event socket is not open");
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }, { id: sessionId, event: { version: 1, sessionId, seq: sequence, emittedAt: new Date().toISOString(), type, payload } });
  };
}

function status(sessionId, runState, extra = {}) {
  return { status: { sessionId, runState, ...extra } };
}

async function foldState(page, index) {
  const fold = page.locator(".turn-process").nth(index);
  return {
    count: await page.locator(".turn-process").count(),
    expanded: await fold.locator(".turn-process-summary").getAttribute("aria-expanded"),
    header: (await fold.locator(".turn-process-summary").textContent()) ?? "",
    failures: await fold.locator(".turn-process-failure").count(),
  };
}

const temporaryPath = await mkdtemp(join(tmpdir(), "jarvis-fold-smoke-"));
let ownedWorkspaceId;
try {
  const { workspace } = await api("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: temporaryPath, label: "Fold Smoke" }),
  });
  ownedWorkspaceId = workspace.id;
  const { session } = await api(`/api/workspaces/${workspace.id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const sessionId = session.id;

  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__jarvisSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); window.__jarvisSockets.push(this); }
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  await page.goto(`${baseUrl}/#/chat/${workspace.id}/${sessionId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".timeline-shell").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => window.__jarvisSockets?.some((socket) => socket.readyState === 1), undefined, { timeout: 15_000 });

  const emit = emitter(page, sessionId);
  // 时间戳都落在过去，否则运行中的计时器会因为 startedAt > now 而不显示。
  const at = (offsetSeconds) => new Date(Date.now() + (offsetSeconds - 60) * 1_000).toISOString();

  await emit("message.created", { message: { kind: "message", id: "u1", role: "user", createdAt: at(0), text: "帮我看看时间线的渲染顺序。" } });
  await emit("run.started", status(sessionId, "running", { activeRun: { id: "run-1", startedAt: at(0) } }));
  await emit("thinking.delta", { thinkingId: "t1", delta: "先看渲染函数。", createdAt: at(1) });
  await emit("thinking.completed", { thinkingId: "t1", text: "先看渲染函数。", createdAt: at(1) });
  await emit("assistant.delta", { messageId: "m1", delta: "先看 timeline.tsx 的渲染逻辑。" });
  await emit("assistant.completed", { message: { kind: "message", id: "m1", role: "assistant", createdAt: at(2), text: "先看 timeline.tsx 的渲染逻辑。" } });
  await emit("tool.upsert", { tool: { kind: "tool", id: "call_1", createdAt: at(3), name: "read", title: "Read file", state: "completed", target: "timeline.tsx" } });
  await emit("tool.upsert", { tool: { kind: "tool", id: "call_2", createdAt: at(4), name: "bash", title: "Run command", state: "completed", target: "npm test", inputPreview: "npm test", exitCode: 0 } });
  await emit("assistant.delta", { messageId: "m2", delta: "问题在分组函数，已修复。" });
  await emit("assistant.completed", { message: { kind: "message", id: "m2", role: "assistant", createdAt: at(6), text: "问题在分组函数，已修复。" } });
  await page.waitForTimeout(400);

  const running = await foldState(page, 0);
  if (running.count !== 1) failures.push(`running: expected 1 folded turn, got ${String(running.count)}`);
  if (running.expanded !== "true") failures.push("running: the active turn is not expanded");
  if (!/^过程2 项操作\d+:\d\d$/.test(running.header)) failures.push(`running: unexpected fold header "${running.header}"`);
  await page.screenshot({ path: join(screenshotDir, "jarvis-fold-running.png") });

  await emit("run.settled", status(sessionId, "idle"));
  await page.waitForTimeout(400);
  const settled = await foldState(page, 0);
  if (settled.expanded !== "false") failures.push("settled: the finished turn did not collapse");
  if (!/^过程2 项操作\d+:\d\d$/.test(settled.header)) failures.push(`settled: unexpected fold header "${settled.header}"`);
  if (await page.locator(".message-row.assistant").last().textContent() !== "问题在分组函数，已修复。") failures.push("settled: the final answer is not visible outside the fold");
  if (await page.locator(".activity-group").count() !== 0) failures.push("settled: the collapsed fold still rendered its process entries");
  await page.screenshot({ path: join(screenshotDir, "jarvis-fold-settled.png") });

  await page.locator(".turn-process-summary").first().click();
  await page.waitForFunction(() => document.querySelector(".turn-process-summary")?.getAttribute("aria-expanded") === "true", undefined, { timeout: 5_000 }).catch(() => failures.push("manual: clicking the fold row did not expand it"));
  if (await page.locator(".activity-group").count() === 0) failures.push("manual: the expanded fold did not render its process entries");
  await emit("session.updated", status(sessionId, "idle"));
  await page.waitForTimeout(300);
  if ((await foldState(page, 0)).expanded !== "true") failures.push("manual: a manually expanded turn was collapsed again");
  await page.screenshot({ path: join(screenshotDir, "jarvis-fold-expanded.png") });

  // 没有最终汇报、且以失败收尾的回合保持展开。
  await emit("message.created", { message: { kind: "message", id: "u2", role: "user", createdAt: at(20), text: "再跑一次测试。" } });
  await emit("assistant.delta", { messageId: "m3", delta: "正在运行测试。" });
  await emit("tool.upsert", { tool: { kind: "tool", id: "call_3", createdAt: at(21), name: "bash", title: "Run command", state: "failed", inputPreview: "npm test", error: "1 failed" } });
  await emit("timeline.upsert", { item: { kind: "error", id: "e1", createdAt: at(22), code: "PI_RUNTIME_ERROR", message: "HTTP 503", state: "failed" } });
  await page.waitForTimeout(400);
  const failed = await foldState(page, 1);
  if (failed.expanded !== "true") failures.push("failed: a failing turn collapsed");
  if (failed.failures !== 1) failures.push("failed: the failure marker is missing");

  // 等待响应的扩展交互不能被关进折叠里。
  await emit("message.created", { message: { kind: "message", id: "u3", role: "user", createdAt: at(30), text: "删除这个文件。" } });
  await emit("assistant.delta", { messageId: "m4", delta: "需要你确认。" });
  await emit("extension.uiRequest", { request: { id: "c0ffee00-0000-4000-8000-00000000000f", method: "confirm", title: "允许删除文件", message: "将删除构建缓存。" } });
  await page.waitForTimeout(400);
  const pending = await foldState(page, 2);
  if (pending.expanded !== "true") failures.push("pending: a turn waiting for user input collapsed");
  if (await page.locator(".extension-operation.pending").count() !== 1) failures.push("pending: the pending interaction is not rendered");

  // 用户 !cmd（`bash:` 前缀）所在回合默认展开，命令输出不被关进折叠里。
  await emit("message.created", { message: { kind: "message", id: "u4", role: "user", createdAt: at(40), text: "查看状态。" } });
  await emit("thinking.delta", { thinkingId: "t3", delta: "先看看仓库状态。", createdAt: at(41) });
  await emit("thinking.completed", { thinkingId: "t3", text: "先看看仓库状态。", createdAt: at(41) });
  await emit("tool.upsert", { tool: { kind: "tool", id: "bash:run-9", createdAt: at(42), name: "bash", title: "Run command", state: "completed", inputPreview: "git status", output: "clean" } });
  await page.waitForTimeout(400);
  const command = await foldState(page, 3);
  if (command.expanded !== "true") failures.push("command: a turn containing a user !cmd collapsed");
  if (await page.locator(".command-summary").filter({ hasText: "git status" }).isVisible() !== true) failures.push("command: the user !cmd output is not visible");
  await page.screenshot({ path: join(screenshotDir, "jarvis-fold-pinned.png") });

  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) failures.push("desktop: unexpected horizontal overflow");
  await context.close();
} finally {
  await browser.close();
  if (ownedWorkspaceId !== undefined) await api(`/api/workspaces/${ownedWorkspaceId}`, { method: "DELETE" }).catch(() => {});
  await rm(temporaryPath, { recursive: true, force: true });
}

if (failures.length > 0) throw new Error(failures.join("\n"));
console.log("OK: timeline fold smoke passed");
