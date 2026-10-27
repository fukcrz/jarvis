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

async function assertProcessBeforeFinalReply(page, label) {
  const placement = await page.evaluate(() => {
    const details = [...document.querySelectorAll(".turn-details")].at(-1);
    const finalReply = [...document.querySelectorAll(".message-row.assistant")].at(-1);
    return details !== undefined && finalReply !== undefined && details.parentElement === finalReply.parentElement
      && !!(details.compareDocumentPosition(finalReply) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.ok(placement, `${label}: process should appear above the final reply in the same turn`);
}

async function assertRunningProcess(page, label) {
  await page.locator("section.turn-process-stack").last().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".working-indicator, .thinking-item.running, .tool-item.running, .tool-item.queued, .message-row.streaming")].some((node) => node.getClientRects().length > 0));
  assert.equal(await page.locator("section.turn-process-stack .turn-process-summary").count(), 0, `${label}: running work exposed a parent fold`);
  assert.equal(await page.locator(".turn-process-current .turn-process-summary").count(), 0, `${label}: running turn exposed a parent fold`);
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
    const heredoc = "python - << 'PY'\nimport json\nprint(json.dumps({'projection': 'ok', 'transcript': 'ok'}))\nPY";
    const initialThought = "先核对 Pi 的结构化内容块。\nReasoning stays separate from commentary and final replies.";
    const calls = [
      { type: "toolCall", id: `${label}-read-1`, name: "read", arguments: { path: "src/server/projection.ts" } },
      { type: "toolCall", id: `${label}-read-2`, name: "read", arguments: { path: "src/client/transcript.ts" } },
      { type: "toolCall", id: `${label}-bash`, name: "bash", arguments: { command: heredoc } },
    ];
    const first = fixture.assistant(fixture.at(1), [{ type: "thinking", thinking: initialThought }, fixture.text(commentary, "commentary"), ...calls], { stopReason: "toolUse" });
    fixture.update(first, { type: "thinking_start", contentIndex: 0 });
    fixture.update(first, { type: "thinking_delta", contentIndex: 0, delta: initialThought });
    await page.locator(".thinking-item.running").waitFor();
    await page.locator(".thinking-preview").getByText("Reasoning stays separate from commentary and final replies.").waitFor();
    assert.equal(await page.locator(".thinking-summary").getAttribute("aria-expanded"), "false", `${label}: active thought should stay a single row`);
    await assertRunningProcess(page, `${label}: thinking`);
    assert.equal(await page.locator(".turn-process-summary").count(), 0, `${label}: running process should stay inline`);
    await snapshot(page, `${label}-thinking-start`);
    fixture.update(first, { type: "text_start", contentIndex: 1 });
    fixture.update(first, { type: "text_delta", contentIndex: 1, delta: commentary });
    await page.getByText("正在核对投影与渲染逻辑。").waitFor();
    await assertRunningProcess(page, `${label}: commentary`);
    assert.equal(await page.locator(".turn-process-summary").count(), 0, `${label}: commentary introduced a parent fold`);
    assert.equal(await page.locator(".thinking-item").count(), 1, `${label}: adding commentary remounted the thought`);
    await page.locator(".thinking-summary").click();
    assert.equal(await page.locator(".thinking-collapse").getAttribute("aria-expanded"), "true", `${label}: manual thought open did not apply`);
    await page.locator(".thinking-collapse").click();
    assert.equal(await page.locator(".thinking-summary").getAttribute("aria-expanded"), "false", `${label}: manual thought close did not apply`);
    fixture.update(first, { type: "thinking_end", contentIndex: 0, content: initialThought });
    await page.locator(".thinking-summary").waitFor({ state: "visible" });
    assert.equal(await page.locator(".thinking-summary").getAttribute("aria-expanded"), "false", `${label}: manual thought close did not survive completion`);
    fixture.update(first, { type: "text_end", contentIndex: 1, content: commentary });
    for (const index of [2, 3, 4]) fixture.callEnd(first, index);
    fixture.end(first);
    fixture.toolStart(calls[0]);
    fixture.toolEnd(calls[0], "projection source retained");
    await page.locator(".tool-summary").filter({ hasText: "projection.ts" }).waitFor();
    assert.equal(await page.locator(".tool-summary").filter({ hasText: "projection.ts" }).getAttribute("aria-expanded"), "false", `${label}: completed tool detail did not auto-collapse`);
    fixture.toolStart(calls[1]);
    fixture.toolEnd(calls[1], "transcript source retained");
    fixture.toolStart(calls[2]);
    await page.locator(".command-item.running").waitFor();
    await assertRunningProcess(page, `${label}: tools`);
    assert.equal(await page.locator(".turn-process-stack .tool-item:visible").count(), 3, `${label}: inline process hid tools`);
    assert.ok(await page.locator(".turn-process-stack .message-row.assistant:visible").count() >= 1, `${label}: running commentary was hidden`);
    // The expanded row keeps its headline compact; the full heredoc stays in details.
    const commandTitle = page.locator(".command-item.running .tool-target");
    assert.equal(await commandTitle.textContent(), "命令", `${label}: expanded command is repeated in its summary`);
    const titleStyle = await commandTitle.evaluate((node) => ({ whiteSpace: getComputedStyle(node).whiteSpace, height: node.getBoundingClientRect().height }));
    assert.equal(titleStyle.whiteSpace, "nowrap", `${label}: command title wraps`);
    assert.ok(titleStyle.height < 24, `${label}: command title is taller than one line (${String(titleStyle.height)}px)`);
    await snapshot(page, `${label}-running`);
    await page.screenshot({ path: join(shotDir, `${label}-running.png`) });
    const runningLayout = await inspectLayout(page);
    assert.ok(runningLayout.documentWidth <= viewport.width + 1, `${label}: running layout overflows`);

    await page.locator(".command-item.running .detail-command-line").getByText("print(json.dumps", { exact: false }).waitFor();
    await page.screenshot({ path: join(shotDir, `${label}-running-command-open.png`) });
    const projectionSummary = page.locator(".tool-summary").filter({ hasText: "projection.ts" });
    await projectionSummary.click();
    await page.getByText("projection source retained", { exact: true }).waitFor();
    fixture.toolEnd(calls[2], "612 passed");
    const completedCommand = page.locator(".command-item.completed .command-summary");
    await completedCommand.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".command-item.completed .command-summary")].some((node) => node.getAttribute("aria-expanded") === "false"));
    await assertRunningProcess(page, `${label}: tool completion`);
    assert.equal(await completedCommand.getAttribute("aria-expanded"), "false", `${label}: completed command details did not auto-collapse`);
    assert.equal(await projectionSummary.getAttribute("aria-expanded"), "true", `${label}: manual tool expansion did not survive other tool completion`);

    const laterThought = "继续核对刷新与重连。\n中英文内容都按 phase 归类，逐行内容保留在原始块中。";
    const second = fixture.assistant(fixture.at(20), [{ type: "thinking", thinking: laterThought }, fixture.text("Reviewing\n正在验证刷新与重连。", "commentary")]);
    fixture.update(second, { type: "thinking_start", contentIndex: 0 });
    fixture.update(second, { type: "thinking_delta", contentIndex: 0, delta: laterThought });
    await page.locator(".thinking-item.running:visible").last().waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSocket(page, session.id);
    await page.locator(".thinking-item.running:visible").last().waitFor();
    await assertRunningProcess(page, `${label}: refresh`);
    assert.equal(await page.locator(".thinking-item.running:visible").count(), 1, `${label}: refresh duplicated the running thought`);
    await page.locator(".thinking-preview").getByText("中英文内容都按 phase 归类，逐行内容保留在原始块中。").waitFor();
    const refreshLayout = await inspectLayout(page);
    assert.ok(refreshLayout.documentWidth <= viewport.width + 1, `${label}: thought text overflows`);
    await snapshot(page, `${label}-refresh-running`);

    const requestCount = runtimeRequests;
    await page.evaluate((id) => window.__jarvisSockets.find((socket) => socket.url.includes(`/sessions/${id}/events`) && socket.readyState === 1)?.close(), session.id);
    fixture.update(second, { type: "thinking_delta", contentIndex: 0, delta: "\n离线期间继续思考。" });
    await waitForSocket(page, session.id, 2);
    await page.waitForFunction(() => [...document.querySelectorAll(".thinking-item.running .thinking-preview")].some((node) => node.textContent?.includes("离线期间继续思考。")), undefined, { timeout: 10_000 });
    assert.ok(runtimeRequests > requestCount, `${label}: reconnect did not refresh the runtime`);
    await assertRunningProcess(page, `${label}: reconnect`);
    fixture.update(second, { type: "thinking_end", contentIndex: 0, content: laterThought });
    fixture.update(second, { type: "text_delta", contentIndex: 1, delta: second.content[1].text });
    fixture.update(second, { type: "text_end", contentIndex: 1, content: second.content[1].text });
    fixture.end(second);
    const finalText = "已完成调整。思考、过程播报与最终回答按结构化信息归类，工具操作保留原顺序。\n\n刷新和重连会恢复当前内容；展开过程可查看完整记录。";
    fixture.end(fixture.assistant(fixture.at(30), [fixture.text(finalText, "final_answer")]));
    await page.getByText(finalText.split("\n\n")[0], { exact: true }).waitFor();
    await assertRunningProcess(page, `${label}: final before idle`);
    assert.equal(await page.locator(".turn-process-summary").count(), 0, `${label}: final text folded work before idle`);
    fixture.settle();
    await page.waitForFunction(() => document.querySelector(".working-indicator, .thinking-item.running, .tool-item.running") === null);
    assert.equal(await page.locator(".turn-process-summary").first().getAttribute("aria-expanded"), "false", `${label}: completion left the process open`);
    assert.equal(await page.locator(".turn-process-body").count(), 0, `${label}: settled process stayed expanded`);
    assert.equal(await page.locator("section.turn-process-stack").count(), 0, `${label}: idle process stayed inline`);
    await assertProcessBeforeFinalReply(page, `${label}: idle process`);
    assert.deepEqual(await page.locator(".message-row.assistant").last().locator(".message-content p").allTextContents(), finalText.split("\n\n"));
    await page.locator(".turn-process-summary").first().click();
    const firstThoughtToggle = page.locator(".turn-process-body .thinking-summary").first();
    assert.equal(await firstThoughtToggle.getAttribute("aria-expanded"), "false", `${label}: completed thought was not collapsed in process`);
    await firstThoughtToggle.click();
    await page.locator(".thinking-body").first().waitFor();
    const expandedOrder = await page.locator(".turn-process-body .thinking-item, .turn-process-body .message-row, .turn-process-body .tool-item").evaluateAll((nodes) => nodes.map((node) => ({ kind: node.classList.contains("thinking-item") ? "thinking" : node.classList.contains("message-row") ? "commentary" : "tool", text: node.textContent?.trim() ?? "" })));
    assert.deepEqual(expandedOrder.map((entry) => entry.kind), ["thinking", "commentary", "tool", "tool", "tool", "thinking", "commentary"]);
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
    const historyOrder = await page.locator(".turn-process-body .thinking-item, .turn-process-body .message-row, .turn-process-body .tool-item").evaluateAll((nodes) => nodes.map((node) => ({ kind: node.classList.contains("thinking-item") ? "thinking" : node.classList.contains("message-row") ? "commentary" : "tool", text: node.textContent?.trim() ?? "" })));
    assert.deepEqual(historyOrder.map((entry) => entry.kind), expandedOrder.map((entry) => entry.kind), `${label}: history reordered the source blocks`);
    await page.locator(".turn-process-summary").first().click();

    // Earlier reply blocks and tools keep their source order inside the settled process.
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
    const mixedProcess = page.locator(".turn-process").last();
    await mixedProcess.locator(".turn-process-summary").click();
    const mixedOrder = await mixedProcess.locator(".message-row.assistant, .tool-item").evaluateAll((nodes) => nodes.map((node) => node.textContent));
    assert.ok(mixedOrder.findIndex((value) => value.includes("Preparing")) < mixedOrder.findIndex((value) => value.includes("第一段最终回答")));
    assert.ok(mixedOrder.findIndex((value) => value.includes("第一段最终回答")) < mixedOrder.findIndex((value) => value.includes("order.ts")));
    assert.equal(await mixedProcess.getByText("第二段最终回答。", { exact: true }).count(), 0, `${label}: last final reply was folded into the process`);
    await assertProcessBeforeFinalReply(page, `${label}: mixed reply`);
    await mixedProcess.locator(".turn-process-summary").click();
    assert.equal(await page.locator(".turn-process-body .message-row").count(), 0, `${label}: collapsed mixed process retained reply rows`);

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
    await page.locator(".turn-process-summary").last().click();
    await page.locator(".command-summary").filter({ hasText: "npm run failing-check" }).click();
    // The merged failure card's raw section also shows the tool error; check the process row itself.
    await page.locator(".turn-process .tool-error-output").getByText("1 failed\n完整工具失败输出。", { exact: true }).waitFor();
    assert.equal(await page.locator(".turn-failure").count(), 1, `${label}: failure card was not merged`);

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
    await page.getByText("当前进度。").waitFor();
    const commands = [1, 2, 3].map((number) => ({
      type: "toolCall", id: `${scenario}-command-${number}`, name: shell, arguments: { command: `fold-${shell}-${number}` },
    }));
    fixture.end(fixture.assistant(fixture.at(2), commands, { stopReason: "toolUse" }));
    await waitForToolEvent(page, commands[2], "queued");

    await assertRunningProcess(page, `${scenario}: queued tools`);
    const inlineProcess = page.locator("section.turn-process-stack").first();
    const group = page.locator(".activity-group").first();
    await group.locator(".activity-group-label").waitFor();
    assert.equal(await group.locator(".activity-group-label").getAttribute("aria-expanded"), "true", `${scenario}: pending tool group should stay open`);
    assert.equal(await group.locator(".activity-group-label-text").textContent(), "命令 3");
    assert.equal(await group.locator(".tool-item.queued:visible").count(), 3, `${scenario}: expanded process hid queued tools`);
    await group.locator(".activity-group-label").click();
    await group.locator('.activity-group-label[aria-expanded="false"]').waitFor();
    await group.locator(".tool-item").first().waitFor({ state: "hidden" });
    assert.equal(await group.locator(".tool-item:visible").count(), 0, `${scenario}: active command group left rows visible`);
    await group.locator(".activity-group-label").click();
    await group.locator('.activity-group-label[aria-expanded="true"]').waitFor();
    await group.locator(".tool-item.queued").first().waitFor();
    assert.equal(await group.locator(".tool-item.queued:visible").count(), 3, `${scenario}: reopened active group hid queued tools`);
    await snapshot(page, `${scenario}-default-preview`);
    await page.screenshot({ path: join(shotDir, `${scenario}-default-preview.png`) });

    fixture.toolStart(commands[0]);
    fixture.toolUpdate(commands[0], "first partial");
    await waitForToolEvent(page, commands[0], "running", "first partial");
    assert.equal(await group.locator(".tool-item.running:visible").count(), 1, `${scenario}: expanded process hid current work`);
    fixture.toolEnd(commands[0], "first complete");
    await waitForToolEvent(page, commands[0], "completed", "first complete");
    assert.equal(await group.locator(".command-summary").first().getAttribute("aria-expanded"), "false", `${scenario}: completed command detail did not auto-collapse`);
    assert.equal(await group.locator(".tool-item.completed:visible").count(), 1, `${scenario}: expanded pending group hid completed work`);
    assert.equal(await group.locator(".tool-item.queued:visible").count(), 2, `${scenario}: expanded process lost queued work`);

    await group.locator(".tool-item.queued").first().locator(".tool-summary").click();
    await assertRunningProcess(page, `${scenario}: tool detail`);
    assert.equal(await group.locator(".tool-summary[aria-expanded=\"true\"]").count(), 1, `${scenario}: clicked tool detail did not open`);

    // Individual tools can be toggled while the running process stays inline.
    await group.locator(".tool-item.queued").first().locator(".tool-summary").click();
    assert.equal(await group.locator('.tool-summary[aria-expanded="true"]').count(), 0, `${scenario}: clicked tool detail did not close`);
    await group.locator(".tool-item.queued").first().locator(".tool-summary").click();
    assert.equal(await inlineProcess.locator(".tool-item:visible").count(), 3, `${scenario}: detail toggle hid inline tools`);

    fixture.toolStart(commands[1]);
    fixture.toolUpdate(commands[1], "second partial");
    await waitForToolEvent(page, commands[1], "running", "second partial");
    await assertRunningProcess(page, `${scenario}: tool update`);
    assert.equal(await group.locator(".tool-item.running:visible").count(), 1, `${scenario}: inline process hid running work`);
    fixture.toolEnd(commands[1], "second failed", true);
    await waitForToolEvent(page, commands[1], "failed");
    assert.equal(await group.locator(".tool-item.failed:visible").count(), 1, `${scenario}: inline process hid a failed command`);
    assert.equal(await group.locator(".tool-item.failed .tool-summary").getAttribute("aria-expanded"), "true", `${scenario}: failure reset the opened command`);
    await group.getByText("second failed", { exact: true }).waitFor();
    await assertRunningProcess(page, `${scenario}: failed command`);

    fixture.toolStart(commands[2]);
    fixture.toolUpdate(commands[2], "third partial");
    await waitForToolEvent(page, commands[2], "running", "third partial");
    fixture.toolEnd(commands[2], "third complete");
    await waitForToolEvent(page, commands[2], "completed", "third complete");
    const runId = fixture.active.state.activeRun?.id;
    assert.ok(runId, `${scenario}: missing active run before settlement`);
    fixture.end(fixture.assistant(Date.now(), [fixture.text(`${scenario} 命令检查完成。`, "final_answer")]));
    await page.getByText(`${scenario} 命令检查完成。`, { exact: true }).waitFor();
    await assertRunningProcess(page, `${scenario}: final before idle`);
    fixture.settle();
    await waitForFoldEvent(page, "run.settled", { runId });
    const process = page.locator(".turn-process").first();
    assert.equal(await process.locator(".turn-process-summary").getAttribute("aria-expanded"), "false", `${scenario}: idle process should start collapsed`);
    assert.equal(await page.locator(".working-indicator").count(), 0, `${scenario}: idle retained working indicator`);
    await assertProcessBeforeFinalReply(page, `${scenario}: idle process`);
    await page.waitForFunction(() => document.querySelector(".turn-process")?.querySelector(".turn-process-summary")?.getAttribute("aria-expanded") === "false" && [...document.querySelectorAll(".turn-process .tool-item")].every((node) => node.getClientRects().length === 0));
    assert.equal(await group.locator(".activity-group-label:visible").count(), 0, `${scenario}: parent fold left the command group visible`);
    assert.equal(await group.locator(".tool-item:visible").count(), 0, `${scenario}: parent fold left a command visible`);
    await snapshot(page, `${scenario}-process-collapsed`);
    await page.screenshot({ path: join(shotDir, `${scenario}-process-collapsed.png`) });

    // Settled parent and group folds preserve individual detail state.
    await process.locator(".turn-process-summary").click();
    await group.locator(".activity-group-label").waitFor();
    assert.equal(await group.locator(".activity-group-label").getAttribute("aria-expanded"), "true", `${scenario}: manual active group expansion was not preserved`);
    await group.locator(".activity-group-label").click();
    await group.locator('.activity-group-label[aria-expanded="false"]').waitFor();
    assert.equal(await group.locator(".tool-item:visible").count(), 0, `${scenario}: group fold left commands visible`);
    await group.locator(".activity-group-label").click();
    await group.getByText("second failed", { exact: true }).waitFor();
    assert.equal(await group.locator(".tool-item.failed .tool-summary").getAttribute("aria-expanded"), "true", `${scenario}: group toggle reset failure detail`);
    await process.locator(".turn-process-summary").click();
    await process.locator(".turn-process-summary").click();
    assert.equal(await group.locator(".activity-group-label").getAttribute("aria-expanded"), "true", `${scenario}: parent toggle reset group state`);
    await group.getByText("second failed", { exact: true }).waitFor();
    await process.locator(".turn-process-summary").click();

    fixture.start();
    fixture.user(`检查单条 ${shell} 命令。`);
    const single = { type: "toolCall", id: `${scenario}-single`, name: shell, arguments: { command: `single-${shell}` } };
    fixture.end(fixture.assistant(Date.now(), [fixture.text("检查单条命令。", "commentary"), single], { stopReason: "toolUse" }));
    await waitForToolEvent(page, single, "queued");
    await assertRunningProcess(page, `${scenario}: single command`);
    const singleInline = page.locator("section.turn-process-stack").last();
    const singleRow = singleInline.locator(".tool-item");
    assert.equal(await singleRow.count(), 1, `${scenario}: inline process hid the queued command`);
    await singleRow.locator(".tool-summary .turn-process-chevron").waitFor();
    await singleRow.locator(".tool-summary").click();
    await singleRow.locator('.tool-summary[aria-expanded="true"]').waitFor();
    assert.equal(await singleRow.locator(".tool-target").textContent(), "命令", `${scenario}: expanded command is repeated in its summary`);
    const expandedCommand = await singleRow.innerText();
    assert.equal(expandedCommand.split(`$ ${single.arguments.command}`).length - 1, 1, `${scenario}: command detail should appear once`);
    await singleRow.screenshot({ path: join(shotDir, `${scenario}-command-expanded.png`) });
    await singleRow.locator(".tool-summary").click();
    await singleRow.locator('.tool-summary[aria-expanded="false"]').waitFor();
    await singleRow.locator(".tool-summary").click();
    fixture.toolStart(single);
    fixture.toolUpdate(single, "single partial");
    await waitForToolEvent(page, single, "running", "single partial");
    assert.equal(await singleInline.locator(".tool-item:visible").count(), 1, `${scenario}: inline process hid running single command`);
    await assertRunningProcess(page, `${scenario}: single update`);
    fixture.toolEnd(single, "single complete");
    await waitForToolEvent(page, single, "completed", "single complete");
    const singleRunId = fixture.active.state.activeRun?.id;
    assert.ok(singleRunId, `${scenario}: missing single-command run before settlement`);
    fixture.end(fixture.assistant(Date.now(), [fixture.text(`${scenario} 单条命令检查完成。`, "final_answer")]));
    await page.getByText(`${scenario} 单条命令检查完成。`, { exact: true }).waitFor();
    await assertRunningProcess(page, `${scenario}: single final before idle`);
    fixture.settle();
    await waitForFoldEvent(page, "run.settled", { runId: singleRunId });
    const singleProcess = page.locator(".turn-process").last();
    assert.equal(await singleProcess.locator(".turn-process-summary").getAttribute("aria-expanded"), "false", `${scenario}: idle single process should start collapsed`);
    await singleProcess.locator(".turn-process-summary").click();
    await singleProcess.locator(".tool-item.completed:visible").waitFor();
    assert.equal(await singleProcess.locator(".tool-summary").getAttribute("aria-expanded"), "true", `${scenario}: reopening reset single detail`);
    await singleProcess.locator(".turn-process-summary").click();
    await singleProcess.locator(".turn-process-summary").click();
    assert.equal(await singleProcess.locator(".tool-summary").getAttribute("aria-expanded"), "true", `${scenario}: parent toggle reset single detail`);
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
