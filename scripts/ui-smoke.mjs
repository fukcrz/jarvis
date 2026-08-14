import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env["JARVIS_URL"] ?? "http://127.0.0.1:28471").replace(/\/$/, "");
const isolatedSessionId = process.env["JARVIS_SESSION"];
const browser = await chromium.launch({ headless: true });
const failures = [];
let temporaryWorkspacePath;
let ownedWorkspaceId;

function apiPath(path) {
  return `${baseUrl}${path}`;
}

async function api(path, options) {
  const response = await fetch(apiPath(path), options);
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${path} failed with ${String(response.status)}`);
  return response.json();
}

async function setupSmokeSession() {
  if (isolatedSessionId !== undefined) {
    const { workspaces } = await api("/api/workspaces");
    for (const workspace of workspaces) {
      const { sessions } = await api(`/api/workspaces/${workspace.id}/sessions`);
      if (sessions.some((session) => session.id === isolatedSessionId)) return { workspaceId: workspace.id, sessionId: isolatedSessionId, label: workspace.label };
    }
    throw new Error(`JARVIS_SESSION ${isolatedSessionId} was not found`);
  }

  temporaryWorkspacePath = await mkdtemp(join(tmpdir(), "jarvis-ui-smoke-"));
  const { workspace } = await api("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: temporaryWorkspacePath, label: "Jarvis UI Smoke" }),
  });
  ownedWorkspaceId = workspace.id;
  const { session } = await api(`/api/workspaces/${workspace.id}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { workspaceId: workspace.id, sessionId: session.id, label: workspace.label };
}

async function capture(name, viewport, session, screenshotPath, desktop) {
  const context = await browser.newContext({ viewport });
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
  page.on("pageerror", (error) => failures.push(`${name}: page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The first command request deliberately returns 503 to exercise retry.
    if (message.text().includes("503 (Service Unavailable)")) return;
    failures.push(`${name}: console error: ${message.text()}`);
  });

  const commandControl = deferred();
  let commandCalls = 0;
  await page.route("**/api/workspaces/*/sessions/*/commands", async (route) => {
    commandCalls += 1;
    if (commandCalls === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "temporary command failure" } }),
      });
      commandControl.resolveFirst();
      return;
    }
    await commandControl.release;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ commands: [{ name: "retry-command", description: "Delayed command", source: "jarvis" }] }),
    });
  });

  await page.goto(`${baseUrl}/#/chat/${session.workspaceId}/${session.sessionId}`, { waitUntil: "domcontentloaded" });
  const editor = page.locator(".composer-editor .cm-content");
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  await waitForSessionSocket(page, session.sessionId);
  await commandControl.first;
  await verifyDelayedCommand(page, editor, name, commandControl.resolve, () => commandCalls);
  await verifyComposerShortcuts(page, editor, name, session.sessionId, desktop);
  await verifyStreamingMarkdown(page, name, session.sessionId);

  let sequence = 900_000_000;
  const emit = async (type, payload) => {
    sequence += 1;
    await emitSessionEvent(page, session.sessionId, { version: 1, sessionId: session.sessionId, seq: sequence, emittedAt: new Date().toISOString(), type, payload });
  };

  await verifyRunFeedback(page, name, session.sessionId, emit);
  await verifyExtensionUi(page, name, session, emit);
  if (desktop) await verifyDesktopControls(page, name, session);
  else await verifyMobileNavigation(page, name, session);

  await assertNoHorizontalOverflow(page, name);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await emit("run.settled", { status: { sessionId: session.sessionId, runState: "idle" } });
  await context.close();
}

async function verifyDelayedCommand(page, editor, name, releaseCommands, commandCalls) {
  await editor.click();
  await page.keyboard.type("/ret");
  releaseCommands();
  const option = page.getByRole("option", { name: /\/retry-command/ });
  await option.waitFor({ state: "visible", timeout: 5_000 });
  if (commandCalls() < 2) failures.push(`${name}: command endpoint did not retry after failure`);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(50);
  if (await editor.textContent() !== "/retry-command ") failures.push(`${name}: delayed slash command did not replace the full token`);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
}

async function verifyStreamingMarkdown(page, name, sessionId) {
  const emittedAt = new Date().toISOString();
  await emitSessionEvent(page, sessionId, {
    version: 1,
    sessionId,
    runId: "markdown-smoke",
    seq: 850_000_001,
    emittedAt,
    type: "assistant.delta",
    payload: { messageId: "markdown-smoke", delta: "# Streaming heading\n\n**Bold text** with `inline code`.\n\n- First item\n- Second item" },
  });
  const message = page.locator(".message-row.streaming").filter({ hasText: "Streaming heading" });
  await message.getByRole("heading", { name: "Streaming heading", level: 1 }).waitFor({ state: "visible", timeout: 5_000 });
  if (await message.locator("strong").textContent() !== "Bold text") failures.push(`${name}: streaming Markdown did not render bold text`);
  if (await message.locator("code").textContent() !== "inline code") failures.push(`${name}: streaming Markdown did not render inline code`);
  if (JSON.stringify(await message.locator("li").allTextContents()) !== JSON.stringify(["First item", "Second item"])) failures.push(`${name}: streaming Markdown did not render a list`);
  if (await message.locator(".streaming-cursor").count() !== 1) failures.push(`${name}: streaming cursor is missing`);
}

async function verifyComposerShortcuts(page, editor, name, sessionId, desktop) {
  const editorSurface = page.locator(".composer-editor .cm-editor");
  const bounds = await editorSurface.boundingBox();
  // 桌面端 min-height 76px + padding；移动端有意压到 48px + padding（≈63px）。
  // 阈值取 44：低于它说明编辑器塌成单行，多行编辑/点击测试无意义。
  if (bounds === null || bounds.height < 44) {
    failures.push(`${name}: composer input area is not multi-line height`);
  } else {
    await editorSurface.click({ position: { x: 20, y: bounds.height - 8 } });
    await page.keyboard.type("lower-area-focus");
    const focus = await editor.evaluate((element) => ({
      active: document.activeElement === element,
      text: element.textContent,
      contentHeight: element.getBoundingClientRect().height,
    }));
    if (!focus.active || focus.text !== "lower-area-focus" || focus.contentHeight < bounds.height - 1) failures.push(`${name}: clicking the lower input area did not focus the editor`);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  }

  await verifyDraftStability(page, editor, name, sessionId);
  const prompts = [];
  await page.route("**/api/workspaces/*/sessions/*/prompt", async (route) => {
    prompts.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ accepted: true, runId: "8b2a18fb-9b91-4b1d-9c15-d2c6caf8e99e" }) });
  });
  await editor.click();
  await page.keyboard.type("First line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Second line");
  await page.waitForTimeout(260);
  const lines = await page.locator(".composer-editor .cm-line").allTextContents();
  if (JSON.stringify(lines) !== JSON.stringify(["First line", "Second line"])) failures.push(`${name}: Shift+Enter did not add a newline`);
  await page.keyboard.press("Enter");
  if (desktop) {
    await page.waitForFunction(() => document.querySelector(".composer-editor .cm-content")?.textContent === "", undefined, { timeout: 5_000 });
    if (prompts.length !== 1 || prompts[0]?.text !== "First line\nSecond line") failures.push(`${name}: Enter did not send the editor value`);
    return;
  }

  await page.waitForTimeout(100);
  const mobileLines = await page.locator(".composer-editor .cm-line").allTextContents();
  if (prompts.length !== 0 || JSON.stringify(mobileLines) !== JSON.stringify(["First line", "Second line", ""])) failures.push(`${name}: Enter sent instead of adding a newline`);
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.waitForFunction(() => document.querySelector(".composer-editor .cm-content")?.textContent === "", undefined, { timeout: 5_000 });
  if (prompts.length !== 1 || prompts[0]?.text !== "First line\nSecond line\n") failures.push(`${name}: send button did not submit the mobile editor value`);
}

async function verifyDraftStability(page, editor, name, sessionId) {
  const expected = "Draft remains stable while the session updates.";
  await editor.click();
  for (const [index, character] of [...expected].entries()) {
    await page.keyboard.insertText(character);
    await emitSessionEvent(page, sessionId, {
      version: 1,
      sessionId,
      seq: 800_000_000 + index,
      emittedAt: new Date().toISOString(),
      type: "session.updated",
      payload: { status: { sessionId, runState: "idle" } },
    });
  }
  await page.waitForTimeout(260);
  if (await editor.textContent() !== expected) failures.push(`${name}: draft changed after session updates`);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(260);
  if ((await editor.textContent()) !== "") failures.push(`${name}: cleared draft returned after session updates`);
}

async function verifyRunFeedback(page, name, sessionId, emit) {
  const retryAt = new Date(Date.now() + 20_000).toISOString();
  await emit("run.retrying", {
    status: {
      sessionId,
      runState: "running",
      activeRun: { id: "smoke-run", startedAt: new Date().toISOString() },
      retrying: { attempt: 1, maxAttempts: 3, delayMs: 20_000, retryAt, errorMessage: "Temporary provider failure" },
    },
  });
  await page.getByText(/模型响应失败，正在重试/).waitFor({ state: "visible", timeout: 5_000 });

  await emit("run.compactionRetrying", {
    status: {
      sessionId,
      runState: "running",
      activeRun: { id: "smoke-run", startedAt: new Date().toISOString() },
      compacting: {
        reason: "overflow",
        startedAt: new Date().toISOString(),
        retrying: { attempt: 2, maxAttempts: 3, delayMs: 20_000, retryAt, errorMessage: "Summary request temporarily failed and is retrying." },
      },
    },
  });
  await page.getByText("上下文已满，正在压缩后重试").waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "停止当前执行" }).waitFor({ state: "visible", timeout: 5_000 });

  await emit("timeline.upsert", {
    item: {
      kind: "context-summary",
      id: "context-summary:smoke",
      createdAt: new Date().toISOString(),
      summaryType: "compaction",
      summary: "## Smoke summary\n\n- Context compaction feedback is visible.",
      tokensBefore: 90_000,
    },
  });
  const summary = page.getByRole("button", { name: /上下文已压缩/ });
  await summary.waitFor({ state: "visible", timeout: 5_000 });
  await summary.click();
  await page.getByText("Context compaction feedback is visible.").waitFor({ state: "visible", timeout: 5_000 });

  await emit("run.failed", {
    status: {
      sessionId,
      runState: "idle",
      lastError: {
        code: "PI_COMPACTION_FAILED",
        message: "409 Conflict: summary rejected (request id: smoke-request-409)",
        occurredAt: new Date().toISOString(),
      },
    },
  });
  await page.getByText("上下文压缩未完成").waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "重试压缩" }).waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "查看诊断" }).click();
  await page.getByText("PI_COMPACTION_FAILED").waitFor({ state: "visible", timeout: 5_000 });
  await page.getByText("smoke-request-409", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
  await page.getByText("409 Conflict: summary rejected (request id: smoke-request-409)").waitFor({ state: "visible", timeout: 5_000 });
  await assertNoHorizontalOverflow(page, name);
}

async function verifyExtensionUi(page, name, session, emit) {
  const requestId = "c0ffee00-0000-4000-8000-000000000001";
  let submitted;
  await page.route("**/api/workspaces/*/sessions/*/extension-ui", async (route) => {
    submitted = JSON.parse(route.request().postData() ?? "{}");
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });

  await emit("extension.uiRequest", {
    request: {
      id: requestId,
      method: "confirm",
      title: "允许删除构建缓存",
      message: "将删除临时构建文件。",
      timeout: 20_000,
    },
  });
  const operation = page.locator(".extension-operation.pending", { hasText: "允许删除构建缓存" });
  await operation.waitFor({ state: "visible", timeout: 5_000 });
  if (await page.getByRole("dialog", { name: "允许删除构建缓存" }).count() !== 0) failures.push(`${name}: extension confirmation opened a dialog instead of rendering inline`);
  await operation.getByRole("button", { name: "允许" }).click();
  await page.waitForTimeout(50);
  if (submitted?.id !== requestId || submitted?.confirmed !== true) failures.push(`${name}: extension confirmation did not submit the selected response`);

  await emit("extension.uiSettled", { id: requestId, outcome: "answered", confirmed: true });
  await page.getByText("已允许", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });

  await emit("extension.uiRequest", {
    request: { id: "c0ffee00-0000-4000-8000-000000000002", method: "notify", message: "扩展通知冒烟验证", notifyType: "info" },
  });
  await page.getByLabel("扩展通知").getByText("扩展通知冒烟验证", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
  if (await page.locator(".extension-notification").filter({ hasText: "扩展通知冒烟验证" }).count() !== 1) failures.push(`${name}: extension notify history record is missing`);
}

async function verifyDesktopControls(page, name, session) {
  const project = page.locator(".project-node").filter({ hasText: session.label }).first();
  const projectToggle = project.locator(".project-toggle");
  await projectToggle.waitFor({ state: "visible", timeout: 5_000 });
  if (await projectToggle.getAttribute("aria-expanded") !== "true") await projectToggle.click();
  const sessionRow = project.locator(`.session-row[data-session-id="${session.sessionId}"]`);
  await sessionRow.waitFor({ state: "visible", timeout: 5_000 });

  const modelButton = page.getByRole("button", { name: "选择模型" });
  if (await modelButton.count() === 1 && !await modelButton.isDisabled()) {
    await modelButton.click();
    await page.locator(".model-menu").waitFor({ state: "visible", timeout: 5_000 });
    if (await page.locator(".model-menu-item small, .model-capability").count() !== 0) failures.push(`${name}: model menu still shows redundant metadata`);
    await page.keyboard.press("Escape");
  }

  await page.getByRole("button", { name: "添加项目" }).click();
  await page.getByRole("dialog", { name: "选择项目目录" }).waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "关闭对话框" }).click();

  await page.getByRole("button", { name: "重命名会话" }).click();
  await page.getByRole("dialog", { name: "重命名会话" }).waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "关闭对话框" }).click();

  await sessionRow.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "会话操作" });
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  await page.keyboard.press("Escape");
}

async function verifyMobileNavigation(page, name, session) {
  await page.locator(".mobile-chat-header").waitFor({ state: "visible", timeout: 5_000 });
  await page.getByRole("button", { name: "返回会话列表" }).click();
  await page.locator(".mobile-all-sessions-page").waitFor({ state: "visible", timeout: 5_000 });
  const sessionProject = page.getByRole("button", { name: session.label, exact: true });
  await sessionProject.click();
  if (!await sessionProject.evaluate((node) => node.classList.contains("selected"))) failures.push(`${name}: selected mobile project filter was not retained`);
  await page.reload({ waitUntil: "domcontentloaded" });
  const restoredProject = page.getByRole("button", { name: session.label, exact: true });
  if (!await restoredProject.evaluate((node) => node.classList.contains("selected"))) failures.push(`${name}: mobile project filter was not restored`);
  await page.locator(`.mobile-session-row[data-session-id="${session.sessionId}"]`).click();
  await page.locator(".mobile-chat-header").waitFor({ state: "visible", timeout: 5_000 });
  await waitForSessionSocket(page, session.sessionId);
  await assertNoHorizontalOverflow(page, name);
}

async function waitForSessionSocket(page, sessionId) {
  await page.waitForFunction((id) => window.__jarvisSockets?.some((socket) => socket.url.includes(`/sessions/${id}/events`) && socket.readyState === 1), sessionId, { timeout: 15_000 });
}

async function emitSessionEvent(page, sessionId, event) {
  await page.evaluate(({ id, payload }) => {
    const socket = window.__jarvisSockets?.find((candidate) => candidate.url.includes(`/sessions/${id}/events`) && candidate.readyState === 1);
    if (socket === undefined) throw new Error("Session event socket is not open");
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }, { id: sessionId, payload: event });
}

async function assertNoHorizontalOverflow(page, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) failures.push(`${name}: unexpected horizontal viewport overflow`);
}

function deferred() {
  let resolveFirst;
  let release;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  return { first, release: releasePromise, resolveFirst, resolve: release };
}

try {
  const session = await setupSmokeSession();
  await capture("desktop", { width: 1440, height: 960 }, session, "/tmp/jarvis-desktop.png", true);
  await capture("mobile", { width: 390, height: 844 }, session, "/tmp/jarvis-mobile.png", false);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log("UI smoke passed", { desktop: "/tmp/jarvis-desktop.png", mobile: "/tmp/jarvis-mobile.png" });
} finally {
  await browser.close();
  if (ownedWorkspaceId !== undefined) await fetch(apiPath(`/api/workspaces/${ownedWorkspaceId}`), { method: "DELETE" }).catch(() => undefined);
  if (temporaryWorkspacePath !== undefined) await rm(temporaryWorkspacePath, { force: true, recursive: true });
}
