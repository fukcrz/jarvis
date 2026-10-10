import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

// Run the built app with isolated Pi/Jarvis data and an ephemeral port.
// Feed structured Pi events through the real server handler, then persist the
// same authoritative messages so refresh and reconnect use real API snapshots.
const shotDir = process.env["JARVIS_SMOKE_SHOTS"] ?? join(tmpdir(), "jarvis-fold-smoke");
const focusedFoldCases = process.env["JARVIS_FOLD_SMOKE_FOCUSED"] === "1";
await mkdir(shotDir, { recursive: true });
const envKeys = ["JARVIS_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "JARVIS_DESKTOP"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "jarvis-fold-home-"));
const workspacePath = await mkdtemp(join(tmpdir(), "jarvis-fold-ws-"));
const failures = [];
const reports = [];
let app;
let browser;

function restoreEnv() {
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
}

async function api(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${path}: ${String(response.status)}`);
  return response.json();
}

async function waitForSessionListed(baseUrl, workspaceId, sessionId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { sessions } = await api(baseUrl, `/api/workspaces/${workspaceId}/sessions`);
    if (sessions.some((session) => session.id === sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Session ${sessionId} was not listed in workspace ${workspaceId}`);
}

async function inspectLayout(page) {
  return page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    rows: [...document.querySelectorAll(".thinking-summary, .process-commentary-preview, .activity-group-label")].map((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return { text: node.textContent, left: box.left, right: box.right, height: box.height, display: style.display, whiteSpace: style.whiteSpace, overflow: style.overflow, textAlign: style.textAlign };
    }),
  }));
}

async function snapshot(page, name) {
  await page.locator(".timeline-shell").ariaSnapshot().then((text) => writeFile(join(shotDir, `${name}.md`), text));
}

async function waitForTimeline(page, label) {
  try {
    await page.locator(".timeline-shell").waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      href: location.href,
      root: document.getElementById("root")?.textContent?.slice(0, 300),
      title: document.title,
    })).catch(() => undefined);
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}; page state: ${JSON.stringify(state)}`);
  }
}

async function openChat(page, baseUrl, workspaceId, sessionId, label) {
  const url = `${baseUrl}/#/chat/${workspaceId}/${sessionId}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.locator(".timeline-shell").waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForTimeline(page, label);
  }
  await waitForSocket(page, sessionId);
}

async function waitForSocket(page, sessionId, count = 1) {
  try {
    await page.waitForFunction(({ id, minimum }) => {
      const sockets = window.__jarvisSockets?.filter((socket) => socket.url.includes(`/sessions/${id}/events`)) ?? [];
      return sockets.length >= minimum && sockets.at(-1)?.readyState === 1;
    }, { id: sessionId, minimum: count }, { timeout: 15_000 });
  } catch (error) {
    const state = await page.evaluate((id) => ({
      href: location.href,
      root: document.getElementById("root")?.textContent?.slice(0, 300),
      sockets: (window.__jarvisSockets ?? []).map((socket) => ({ url: socket.url, readyState: socket.readyState, session: socket.url.includes(`/sessions/${id}/events`) })),
    }), sessionId).catch(() => undefined);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; socket state: ${JSON.stringify(state)}`);
  }
}

function createFixture(services, ref) {
  const active = services.sessions.active.get(`${ref.workspaceId}:${ref.sessionId}`);
  assert.ok(active, "isolated session was not opened");
  const handler = services.sessions.piEvents;
  const manager = active.session.sessionManager;
  const startedAt = Date.now() - 60_000;
  const at = (seconds) => startedAt + seconds * 1_000;
  const signature = (phase) => JSON.stringify({ v: 1, id: phase, phase });
  const text = (value, phase) => ({ type: "text", text: value, ...(phase === undefined ? {} : { textSignature: signature(phase) }) });
  let lastAssistantTimestamp = startedAt;
  const assistant = (timestamp, content, extra = {}) => {
    // Synthetic responses can end in the same millisecond; Pi starts each
    // real response separately. Give this fixture distinct response identities.
    lastAssistantTimestamp = Math.max(timestamp, lastAssistantTimestamp + 1);
    return {
      role: "assistant", timestamp: lastAssistantTimestamp, content, stopReason: "stop", api: "openai-responses", provider: "fixture", model: "fixture",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra,
    };
  };
  const update = (partial, event) => handler.handle(active, { type: "message_update", message: partial, assistantMessageEvent: { ...event, partial } });
  const end = (message) => {
    handler.handle(active, { type: "message_end", message });
    // Pi persists immediately after delivering message_end to subscribers.
    manager.appendMessage(message);
  };
  const user = (value, timestamp = Date.now()) => end({ role: "user", timestamp, content: [{ type: "text", text: value }] });
  const start = () => handler.handle(active, { type: "agent_start" });
  const settle = () => services.sessions.settleRun(active, active.state.activeRun?.id);
  const toolStart = (call) => handler.handle(active, { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
  const toolUpdate = (call, value) => handler.handle(active, { type: "tool_execution_update", toolCallId: call.id, toolName: call.name, args: call.arguments, partialResult: { content: [{ type: "text", text: value }] } });
  const toolEnd = (call, value, isError = false) => {
    const result = { content: [{ type: "text", text: value }], ...(call.name === "bash" ? { details: { exitCode: isError ? 1 : 0 } } : {}) };
    handler.handle(active, { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
    manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: Date.now(), content: result.content, details: result.details, isError });
  };
  const callEnd = (partial, contentIndex) => update(partial, { type: "toolcall_end", contentIndex, toolCall: partial.content[contentIndex] });
  return { active, handler, manager, at, text, assistant, update, end, user, start, settle, toolStart, toolUpdate, toolEnd, callEnd };
}

async function waitForFoldEvent(page, type, match) {
  await page.waitForFunction(({ type, match }) => window.__foldEvents?.some((event) => {
    if (event.type !== type) return false;
    if (type === "run.settled") return event.runId === match.runId;
    const tool = event.payload?.tool;
    return tool?.id === match.id && tool.state === match.state && (match.output === undefined || tool.output === match.output);
  }), { type, match }, { timeout: 10_000 });
  // The stream hook batches events in rAF. Cross the flush and following paint
  // before checking rows whose updates are deliberately hidden by folding.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function waitForToolEvent(page, call, state, output) {
  await waitForFoldEvent(page, "tool.upsert", { id: call.id, state, output });
}

async function exercise(baseUrl, workspace, viewport, label) {
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await waitForSessionListed(baseUrl, workspace.id, session.id);
  const fixture = createFixture(app.jarvis, { workspaceId: workspace.id, sessionId: session.id });
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
    let runtimeRequests = 0;
    page.on("pageerror", (error) => {
      failures.push(`${label}: ${error.message}`);
      console.error(`${label}: page error: ${error.message}`);
    });
    page.on("request", (request) => { if (request.url().endsWith(`/sessions/${session.id}/runtime`)) runtimeRequests += 1; });
    await openChat(page, baseUrl, workspace.id, session.id, label);

    fixture.start();
    fixture.user("检查内容归类与过程展示。", fixture.at(0));
    const commentary = "Preparing\n先检查事件顺序、内容块身份和实时快照。\n正在核对投影与渲染逻辑。";
    const initialThought = "先核对 Pi 的结构化内容块。\nReasoning stays separate from commentary and final replies.";
    const calls = [
      { type: "toolCall", id: `${label}-read-1`, name: "read", arguments: { path: "src/server/projection.ts" } },
      { type: "toolCall", id: `${label}-read-2`, name: "read", arguments: { path: "src/client/transcript.ts" } },
      { type: "toolCall", id: `${label}-bash`, name: "bash", arguments: { command: "npm test" } },
    ];
    const first = fixture.assistant(fixture.at(1), [{ type: "thinking", thinking: initialThought }, fixture.text(commentary, "commentary"), ...calls], { stopReason: "toolUse" });
    fixture.update(first, { type: "thinking_start", contentIndex: 0 });
    fixture.update(first, { type: "thinking_delta", contentIndex: 0, delta: initialThought });
    await page.locator(".thinking-item.running").waitFor();
    assert.equal(await page.locator(".thinking-details").count(), 0, `${label}: thinking should start with a preview`);
    await snapshot(page, `${label}-thinking-start`);
    await page.locator(".thinking-summary").click();
    await page.locator(".thinking-details").waitFor();
    fixture.update(first, { type: "text_start", contentIndex: 1 });
    fixture.update(first, { type: "text_delta", contentIndex: 1, delta: commentary });
    await page.waitForFunction(() => document.querySelector(".turn-process-summary")?.getAttribute("aria-expanded") === "true");
    assert.equal(await page.locator(".thinking-details").count(), 1, `${label}: adding commentary remounted the expanded thought`);
    fixture.update(first, { type: "thinking_end", contentIndex: 0, content: initialThought });
    fixture.update(first, { type: "text_end", contentIndex: 1, content: commentary });
    for (const index of [2, 3, 4]) fixture.callEnd(first, index);
    fixture.end(first);
    await page.locator(".turn-process-summary").first().click();
    fixture.toolStart(calls[0]);
    fixture.toolEnd(calls[0], "projection source retained");
    fixture.toolStart(calls[1]);
    fixture.toolEnd(calls[1], "transcript source retained");
    fixture.toolStart(calls[2]);
    await page.waitForFunction(() => document.querySelector(".turn-process-summary")?.getAttribute("aria-expanded") === "false" && [...document.querySelectorAll(".activity-group .tool-item")].every((node) => node.getClientRects().length === 0));
    assert.equal(await page.locator(".turn-process-summary").first().getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".activity-group-label-text").textContent(), "读取 2 · 命令 1");
    assert.equal(await page.locator(".tool-item.completed:visible").count(), 0, `${label}: completed operations should be in the summary`);
    assert.equal(await page.locator(".message-row.assistant:visible").count(), 0, `${label}: explicit commentary escaped the process`);
    await snapshot(page, `${label}-running`);
    await page.screenshot({ path: join(shotDir, `${label}-running.png`) });
    const runningLayout = await inspectLayout(page);
    assert.ok(runningLayout.documentWidth <= viewport.width + 1, `${label}: running layout overflows`);

    // Expand the process before opening a running row hidden by the default fold.
    await page.locator(".turn-process-summary").first().click();
    await page.locator(".command-item.running .command-summary").waitFor();
    await page.locator(".command-item.running .command-summary").click();
    await page.waitForFunction(() => document.querySelector(".turn-process-summary")?.getAttribute("aria-expanded") === "true" && document.querySelector(".command-summary")?.getAttribute("aria-expanded") === "true");
    assert.equal(await page.locator(".tool-item.completed:visible").count(), 2, `${label}: opening the process should reveal completed siblings`);

    // Collapsing hides details but reopening restores each manually opened row.
    await page.locator(".turn-process-summary").first().click();
    await page.waitForFunction(() => document.querySelector(".turn-process-summary")?.getAttribute("aria-expanded") === "false" && [...document.querySelectorAll(".turn-process .tool-item")].every((node) => node.getClientRects().length === 0));
    assert.equal(await page.locator(".tool-item.completed:visible").count(), 0, `${label}: collapsing the process should hide completed siblings`);
    assert.equal(await page.locator(".tool-details:visible").count(), 0, `${label}: collapsing the process should hide row details`);

    await page.locator(".turn-process-summary").first().click();
    await page.getByText("$ npm test", { exact: true }).waitFor();
    assert.equal(await page.locator(".command-item.running .command-summary").getAttribute("aria-expanded"), "true", `${label}: reopening lost the open command`);
    assert.equal(await page.locator(".tool-item.completed:visible").count(), 2, `${label}: reopening the process should reveal completed siblings`);

    // Manual expansion of a row survives updates.
    await page.locator(".tool-summary").filter({ hasText: "projection.ts" }).click();
    await page.getByText("projection source retained", { exact: true }).waitFor();
    fixture.toolEnd(calls[2], "612 passed");
    assert.equal(await page.locator(".turn-process-summary").first().getAttribute("aria-expanded"), "true");
    await page.locator(".turn-process-summary").first().click();

    const laterThought = "继续核对刷新与重连。\n中英文内容都按 phase 归类，逐行内容保留在原始块中。";
    const second = fixture.assistant(fixture.at(20), [{ type: "thinking", thinking: laterThought }, fixture.text("Reviewing\n正在验证刷新与重连。", "commentary")]);
    fixture.update(second, { type: "thinking_start", contentIndex: 0 });
    fixture.update(second, { type: "thinking_delta", contentIndex: 0, delta: laterThought });
    await page.locator(".thinking-item.running:visible").last().waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSocket(page, session.id);
    await page.locator(".thinking-item.running:visible").last().waitFor();
    assert.equal(await page.locator(".turn-process").count(), 1, `${label}: refreshing duplicated the process`);
    assert.equal(await page.locator(".thinking-item.running:visible .thinking-preview").last().textContent(), laterThought.split("\n").at(-1));
    const refreshLayout = await inspectLayout(page);
    assert.ok(refreshLayout.documentWidth <= viewport.width + 1, `${label}: thought preview overflows`);
    const previewStyle = await page.locator(".thinking-item.running:visible .thinking-preview").last().evaluate((node) => ({ whiteSpace: getComputedStyle(node).whiteSpace, overflow: getComputedStyle(node).overflow }));
    assert.deepEqual(previewStyle, { whiteSpace: "nowrap", overflow: "hidden" });
    await snapshot(page, `${label}-refresh-running`);
    await page.locator(".thinking-item.running:visible .thinking-summary").last().click();
    await page.locator(".thinking-item.running:visible .thinking-details").last().waitFor();

    const requestCount = runtimeRequests;
    await page.evaluate((id) => window.__jarvisSockets.find((socket) => socket.url.includes(`/sessions/${id}/events`) && socket.readyState === 1)?.close(), session.id);
    fixture.update(second, { type: "thinking_delta", contentIndex: 0, delta: "\n离线期间继续思考。" });
    await waitForSocket(page, session.id, 2);
    await page.waitForFunction(() => document.querySelector(".thinking-details")?.textContent?.includes("离线期间继续思考。") === true, undefined, { timeout: 10_000 });
    assert.ok(runtimeRequests > requestCount, `${label}: reconnect did not refresh the runtime`);
    assert.equal(await page.locator(".turn-process-summary").first().getAttribute("aria-expanded"), "true", `${label}: reconnect collapsed manual expansion`);
    fixture.update(second, { type: "thinking_end", contentIndex: 0, content: laterThought });
    fixture.update(second, { type: "text_delta", contentIndex: 1, delta: second.content[1].text });
    fixture.update(second, { type: "text_end", contentIndex: 1, content: second.content[1].text });
    fixture.end(second);
    const finalText = "已完成调整。思考、过程播报与最终回答按结构化信息归类，工具操作保留原顺序。\n\n刷新和重连会恢复当前内容；展开过程可查看完整记录。";
    fixture.end(fixture.assistant(fixture.at(30), [fixture.text(finalText, "final_answer")]));
    fixture.settle();
    await page.waitForFunction(() => document.querySelector(".working-indicator, .thinking-item.running, .tool-item.running") === null);
    assert.equal(await page.locator(".turn-process-summary").first().getAttribute("aria-expanded"), "true", `${label}: completion collapsed manual expansion`);
    assert.equal(await page.locator(".thinking-details").last().count(), 1, `${label}: completed thought lost its manual expansion`);
    assert.deepEqual(await page.locator(".message-row.assistant").last().locator(".message-content p").allTextContents(), finalText.split("\n\n"));
    await page.locator(".turn-process-body .thinking-summary").first().click();
    const expandedOrder = await page.locator(".turn-process-body .thinking-item, .turn-process-body .message-row, .turn-process-body .tool-item").evaluateAll((nodes) => nodes.map((node) => node.className));
    assert.deepEqual(expandedOrder.map((name) => name.includes("thinking-item") ? "thinking" : name.includes("message-row") ? "commentary" : "tool"), ["thinking", "commentary", "tool", "tool", "tool", "thinking", "commentary"]);
    await snapshot(page, `${label}-expanded`);
    await page.screenshot({ path: join(shotDir, `${label}-expanded.png`) });
    await page.locator(".turn-process-summary").first().click();
    assert.equal(await page.locator(".turn-process-current .tool-item:visible").count(), 0);
    await page.screenshot({ path: join(shotDir, `${label}-settled.png`) });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSocket(page, session.id);
    await page.locator(".message-row.assistant").last().waitFor();
    assert.equal(await page.locator(".message-row.assistant:visible").count(), 1, `${label}: history duplicated commentary or final text`);
    await page.locator(".turn-process-summary").first().click();
    const historyOrder = await page.locator(".turn-process-body .thinking-item, .turn-process-body .message-row, .turn-process-body .tool-item").evaluateAll((nodes) => nodes.map((node) => node.className));
    assert.deepEqual(historyOrder, expandedOrder, `${label}: history reordered the source blocks`);
    await page.locator(".turn-process-summary").first().click();

    // Missing or invalid phase stays an ordinary reply; later tools and final blocks keep their order.
    fixture.start();
    fixture.user("再检查没有 phase 的回复和多段最终回答。");
    const between = { type: "toolCall", id: `${label}-between`, name: "read", arguments: { path: "order.ts" } };
    const mixed = fixture.assistant(Date.now(), [
      { type: "text", text: "Preparing\n正在检查代码。", textSignature: "invalid-signature" },
      fixture.text("第一段最终回答。", "final_answer"), between, fixture.text("第二段最终回答。", "final_answer"),
    ], { stopReason: "toolUse" });
    fixture.end(mixed);
    fixture.toolStart(between);
    fixture.toolEnd(between, "ordered result");
    fixture.settle();
    await page.getByText("第二段最终回答。", { exact: true }).waitFor();
    const mixedOrder = await page.locator(".message-row.assistant, .tool-item").evaluateAll((nodes) => nodes.map((node) => node.textContent));
    assert.ok(mixedOrder.findIndex((value) => value.includes("Preparing")) < mixedOrder.findIndex((value) => value.includes("第一段最终回答")));
    assert.ok(mixedOrder.findIndex((value) => value.includes("第一段最终回答")) < mixedOrder.findIndex((value) => value.includes("order.ts")));
    assert.ok(mixedOrder.findIndex((value) => value.includes("order.ts")) < mixedOrder.findIndex((value) => value.includes("第二段最终回答")));
    assert.equal(await page.locator(".turn-process-body .message-row").count(), 0, `${label}: ordinary reply was folded`);

    // Failed tools and full error diagnostics remain reachable without opening old work.
    fixture.start();
    fixture.user("再跑一次失败场景。");
    const failedCall = { type: "toolCall", id: `${label}-failed`, name: "bash", arguments: { command: "npm run failing-check" } };
    fixture.end(fixture.assistant(Date.now(), [fixture.text("正在运行测试。", "commentary"), failedCall], { stopReason: "toolUse" }));
    fixture.toolStart(failedCall);
    fixture.toolEnd(failedCall, "1 failed\n完整工具失败输出。", true);
    fixture.end(fixture.assistant(Date.now(), [], { stopReason: "error", errorMessage: "HTTP 503\n第一次请求的完整错误。" }));
    fixture.end(fixture.assistant(Date.now() + 1, [], { stopReason: "error", errorMessage: "HTTP 403\n第二次请求的完整错误。" }));
    app.jarvis.sessions.failRun(fixture.active, fixture.active.state.activeRun?.id, "PI_RUNTIME_ERROR", "HTTP 403");
    await page.locator(".timeline-error").waitFor();
    assert.equal(await page.locator(".timeline-error").count(), 1, `${label}: adjacent failures were not grouped`);
    await snapshot(page, `${label}-failed`);
    await page.screenshot({ path: join(shotDir, `${label}-failed.png`) });
    await page.locator(".timeline-error-header").click();
    assert.equal(await page.locator(".timeline-error-attempt").count(), 2);
    await page.locator(".command-summary").filter({ hasText: "npm run failing-check" }).click();
    await page.getByText("1 failed\n完整工具失败输出。", { exact: true }).waitFor();

    // A real bridge dialog pins the process and can be cancelled in the browser.
    fixture.start();
    fixture.user("确认删除临时缓存。");
    fixture.end(fixture.assistant(Date.now(), [fixture.text("需要确认。", "commentary")]));
    const confirmation = fixture.active.extensionUi.context.confirm("删除临时缓存", "缓存将被删除，不可恢复。");
    await page.locator(".extension-operation.pending").waitFor();
    assert.equal(await page.locator(".turn-process .extension-operation.pending").count(), 0, `${label}: pending input was folded away`);
    await snapshot(page, `${label}-pending`);
    await page.locator(".extension-operation.pending").getByRole("button", { name: "拒绝", exact: true }).click();
    assert.equal(await confirmation, false);
    fixture.settle();

    // User !cmd output stays directly reachable, without a process fold.
    fixture.start();
    fixture.user("查看仓库状态。");
    const timestamp = Date.now();
    const entryId = fixture.manager.appendMessage({ role: "bashExecution", timestamp, command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false });
    app.jarvis.sessions.publishTool(fixture.active, { kind: "tool", id: `bash:${entryId}`, createdAt: new Date(timestamp).toISOString(), name: "bash", title: "Run command", state: "completed", inputPreview: "git status", output: "clean" });
    fixture.settle();
    const command = page.locator(".command-item").filter({ hasText: "git status" });
    await command.waitFor();
    assert.equal(await page.locator(".turn-process .command-summary").filter({ hasText: "git status" }).count(), 0);
    await snapshot(page, `${label}-command`);
    await command.locator(".command-summary").click();
    await command.getByText("clean", { exact: true }).waitFor();
    const completedLayout = await inspectLayout(page);
    assert.ok(completedLayout.documentWidth <= viewport.width + 1, `${label}: expanded or pinned content overflows`);
    reports.push({ label, viewport, runtimeRequests, runningLayout, refreshLayout, completedLayout });
  } finally {
    await context.close();
  }
}

async function exerciseCommandFolds(baseUrl, workspace, viewport, label, shell) {
  const scenario = `${label}-${shell}`;
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await waitForSessionListed(baseUrl, workspace.id, session.id);
  const fixture = createFixture(app.jarvis, { workspaceId: workspace.id, sessionId: session.id });
  const context = await browser.newContext({ viewport, ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  try {
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__jarvisSockets = [];
      window.__foldEvents = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__jarvisSockets.push(this);
          this.addEventListener("message", ({ data }) => {
            try {
              const event = JSON.parse(data);
              if (event.type === "tool.upsert" || event.type === "run.settled") window.__foldEvents.push(event);
            } catch { /* Heartbeats are not session events. */ }
          });
        }
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      failures.push(`${scenario}: ${error.message}`);
      console.error(`${scenario}: page error: ${error.message}`);
    });
    await openChat(page, baseUrl, workspace.id, session.id, scenario);

    fixture.start();
    fixture.user(`检查 ${shell} 命令折叠。`, fixture.at(0));
    fixture.end(fixture.assistant(fixture.at(1), [fixture.text("准备执行命令。\n当前进度。", "commentary")]));
    await page.locator(".process-commentary-preview").waitFor();
    const commands = [1, 2, 3].map((number) => ({
      type: "toolCall", id: `${scenario}-command-${number}`, name: shell, arguments: { command: `fold-${shell}-${number}` },
    }));
    fixture.end(fixture.assistant(fixture.at(2), commands, { stopReason: "toolUse" }));
    await waitForToolEvent(page, commands[2], "queued");

    const process = page.locator(".turn-process").first();
    const group = process.locator(".activity-group");
    await group.locator(".activity-group-label").waitFor();
    assert.equal(await process.locator(".turn-process-summary").getAttribute("aria-expanded"), "false", `${scenario}: queued tools opened process`);
    assert.equal(await group.locator(".activity-group-label").getAttribute("aria-expanded"), null, `${scenario}: tool group remained interactive`);
    assert.equal(await group.locator(".activity-group-label-text").textContent(), "命令 3");
    assert.equal(await group.locator(".tool-item.queued:visible").count(), 3, `${scenario}: default preview hid queued tools`);
    await snapshot(page, `${scenario}-default-preview`);
    await page.screenshot({ path: join(shotDir, `${scenario}-default-preview.png`) });

    fixture.toolStart(commands[0]);
    fixture.toolUpdate(commands[0], "first partial");
    await waitForToolEvent(page, commands[0], "running", "first partial");
    assert.equal(await group.locator(".tool-item.running:visible").count(), 1, `${scenario}: default preview hid current work`);
    fixture.toolEnd(commands[0], "first complete");
    await waitForToolEvent(page, commands[0], "completed", "first complete");
    assert.equal(await group.locator(".tool-item.completed:visible").count(), 0, `${scenario}: default preview retained completed work`);
    assert.equal(await group.locator(".tool-item.queued:visible").count(), 2, `${scenario}: default preview lost queued work`);

    // A row opens the only parent fold and its own detail in one action.
    await group.locator(".tool-item.queued:visible").first().locator(".tool-summary").click();
    await process.locator(".turn-process-summary").waitFor();
    assert.equal(await process.locator(".turn-process-summary").getAttribute("aria-expanded"), "true", `${scenario}: tool row did not open process`);
    assert.equal(await group.locator(".tool-item:visible").count(), 3, `${scenario}: process expansion omitted tools`);
    assert.equal(await group.locator(".tool-summary[aria-expanded=\"true\"]").count(), 1, `${scenario}: clicked tool detail did not open`);

    // Manual parent folding hides normal work and its detail without resetting it.
    await process.locator(".turn-process-summary").click();
    await page.waitForFunction(() => document.querySelector(".turn-process")?.querySelector(".turn-process-summary")?.getAttribute("aria-expanded") === "false" && [...document.querySelectorAll(".turn-process .tool-item")].every((node) => node.getClientRects().length === 0));
    assert.equal(await group.locator(".tool-details:visible").count(), 0, `${scenario}: parent fold left a detail visible`);

    fixture.toolStart(commands[1]);
    fixture.toolUpdate(commands[1], "second partial");
    await waitForToolEvent(page, commands[1], "running", "second partial");
    assert.equal(await group.locator(".tool-item.running:visible").count(), 0, `${scenario}: update reopened a manually closed process`);
    fixture.toolEnd(commands[1], "second failed", true);
    await waitForToolEvent(page, commands[1], "failed");
    await group.locator(".tool-item.failed:visible").waitFor();
    assert.equal(await group.locator(".tool-item:visible").count(), 1, `${scenario}: closed process showed normal rows with the failure`);

    await group.locator(".tool-item.failed:visible .tool-summary").click();
    await process.locator(".turn-process-summary").waitFor();
    assert.equal(await process.locator(".turn-process-summary").getAttribute("aria-expanded"), "true", `${scenario}: failed row did not open process`);
    await group.getByText("second failed", { exact: true }).waitFor();
    await process.locator(".turn-process-summary").click();
    assert.equal(await group.locator(".tool-details:visible").count(), 0, `${scenario}: parent fold retained failure details`);
    await process.locator(".turn-process-summary").click();
    assert.equal(await group.locator(".tool-item.failed .tool-summary").getAttribute("aria-expanded"), "true", `${scenario}: parent fold reset failure detail`);

    fixture.toolStart(commands[2]);
    fixture.toolUpdate(commands[2], "third partial");
    await waitForToolEvent(page, commands[2], "running", "third partial");
    fixture.toolEnd(commands[2], "third complete");
    await waitForToolEvent(page, commands[2], "completed", "third complete");
    const runId = fixture.active.state.activeRun?.id;
    assert.ok(runId, `${scenario}: missing active run before settlement`);
    fixture.settle();
    await waitForFoldEvent(page, "run.settled", { runId });
    assert.equal(await process.locator(".turn-process-summary").getAttribute("aria-expanded"), "true", `${scenario}: settlement collapsed a manual expansion`);
    await process.locator(".turn-process-summary").click();
    assert.equal(await group.locator(".tool-item.failed:visible").count(), 1, `${scenario}: parent fold hid failure`);
    assert.equal(await group.locator(".tool-item.completed:visible").count(), 0, `${scenario}: parent fold exposed completed work`);
    await snapshot(page, `${scenario}-process-collapsed`);
    await page.screenshot({ path: join(shotDir, `${scenario}-process-collapsed.png`) });

    fixture.start();
    fixture.user(`检查单条 ${shell} 命令。`);
    const single = { type: "toolCall", id: `${scenario}-single`, name: shell, arguments: { command: `single-${shell}` } };
    fixture.end(fixture.assistant(Date.now(), [fixture.text("检查单条命令。", "commentary"), single], { stopReason: "toolUse" }));
    await waitForToolEvent(page, single, "queued");
    const singleProcess = page.locator(".turn-process").last();
    assert.equal(await singleProcess.locator(".turn-process-summary").getAttribute("aria-expanded"), "false");
    assert.equal(await singleProcess.locator(".tool-item.queued:visible").count(), 1, `${scenario}: untouched parent hid queued single command`);
    await singleProcess.locator(".tool-summary").click();
    assert.equal(await singleProcess.locator(".turn-process-summary").getAttribute("aria-expanded"), "true", `${scenario}: single row did not open process`);
    assert.equal(await singleProcess.locator(".tool-summary").getAttribute("aria-expanded"), "true", `${scenario}: single row detail did not open`);
    await singleProcess.locator(".turn-process-summary").click();
    fixture.toolStart(single);
    fixture.toolUpdate(single, "single partial");
    await waitForToolEvent(page, single, "running", "single partial");
    assert.equal(await singleProcess.locator(".tool-item:visible").count(), 0, `${scenario}: manually closed single process exposed work`);
    fixture.toolEnd(single, "single complete");
    await waitForToolEvent(page, single, "completed", "single complete");
    const singleRunId = fixture.active.state.activeRun?.id;
    assert.ok(singleRunId, `${scenario}: missing single-command run before settlement`);
    fixture.settle();
    await waitForFoldEvent(page, "run.settled", { runId: singleRunId });
    await singleProcess.locator(".turn-process-summary").click();
    await singleProcess.locator(".tool-item.completed:visible").waitFor();
    assert.equal(await singleProcess.locator(".tool-summary").getAttribute("aria-expanded"), "true", `${scenario}: reopening reset single detail`);
    reports.push({ scenario, viewport, commandFolds: true });
  } finally {
    await context.close();
  }
}

try {
  process.env.JARVIS_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, "sessions");
  process.env.NODE_ENV = "production";
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.PORT;
  delete process.env.JARVIS_DESKTOP;
  const { buildApp } = await import(pathToFileURL(resolve("dist/server/server/app.js")).href);
  app = await buildApp({ serveStatic: true, staticRoot: resolve("dist/client") });
  const baseUrl = new URL(await app.listen({ host: "127.0.0.1", port: 0 })).origin;
  assert.notEqual(new URL(baseUrl).port, "9528");
  const { workspace } = await api(baseUrl, "/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: workspacePath, label: "过程展示检查" }) });
  browser = await chromium.launch({ headless: true });
  for (const [label, viewport] of [["desktop", { width: 1440, height: 960 }], ["mobile", { width: 390, height: 844 }]]) {
    if (!focusedFoldCases) await exercise(baseUrl, workspace, viewport, label);
    for (const shell of ["bash", "powershell"]) await exerciseCommandFolds(baseUrl, workspace, viewport, label, shell);
  }
  assert.deepEqual(failures, []);
  await writeFile(join(shotDir, "report.json"), JSON.stringify({ baseUrl, reports, failures }, null, 2));
  console.log(`OK: structured process smoke passed on desktop and mobile; artifacts: ${shotDir}`);
} finally {
  await browser?.close();
  app?.jarvis.events.terminateAll();
  await app?.close();
  restoreEnv();
  await rm(home, { recursive: true, force: true });
  await rm(workspacePath, { recursive: true, force: true });
}
