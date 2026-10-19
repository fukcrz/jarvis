import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

// Run after building: node scripts/ui-run-status-smoke.mjs
// Inject protocol events into the real session socket, as in ui-smoke.mjs.
// This isolates frontend semantics: no prompt, model, tools, or subprocesses run.
// The fixture is intentionally not persisted; do not reload during a scenario.
const shotDir = process.env.JARVIS_SMOKE_SHOTS ?? join(tmpdir(), "jarvis-run-status-smoke");
const envKeys = ["JARVIS_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "JARVIS_DESKTOP"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const failures = [];
const reports = [];
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

async function waitForCount(page, selector, count) {
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector, count });
}

async function screenshot(page, name) {
  await paint(page);
  await page.screenshot({ path: join(shotDir, `${name}.png`) });
}

function eventFixture(page, sessionId, label) {
  let seq = 900_000_000;
  let clock = Date.now() - 120_000;
  const createdAt = () => new Date(clock += 1_000).toISOString();
  let activeRun = { id: `${label}-run`, startedAt: new Date().toISOString() };
  const status = (extra = {}) => ({ sessionId, runState: "running", activeRun, ...extra });
  const beginRun = (runLabel, kind = "llm") => { activeRun = { id: `${label}-${runLabel}-run`, startedAt: new Date().toISOString(), kind }; return activeRun; };
  const emit = async (type, payload) => {
    const event = { version: 1, sessionId, runId: activeRun.id, seq: ++seq, emittedAt: new Date().toISOString(), type, payload };
    await page.evaluate(({ sessionId, event }) => {
      const socket = window.__jarvisSockets.find((socket) => socket.url.includes(`/sessions/${sessionId}/events`) && socket.readyState === WebSocket.OPEN);
      if (socket === undefined) throw new Error("Fixture session socket is not open");
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    }, { sessionId, event });
    await paint(page);
  };
  const message = (id, role, text, extra = {}) => ({ kind: "message", id: `${label}-${id}`, role, text, createdAt: createdAt(), ...extra });
  return { emit, status, createdAt, message, beginRun };
}

async function scrollDistance(page, distance) {
  // Dispatch a real wheel gesture first so streaming auto-follow releases.
  await page.locator(".timeline").dispatchEvent("wheel", { deltaY: -1 });
  await page.locator(".timeline").evaluate((node, distance) => {
    const range = node.scrollHeight - node.clientHeight;
    if (range < distance) throw new Error(`Fixture has insufficient scroll range: ${range} < ${distance}`);
    node.scrollTop = range - distance;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, distance);
  await page.waitForFunction((distance) => {
    const node = document.querySelector(".timeline");
    return node !== null && Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop - distance) <= 2;
  }, distance);
  await paint(page);
}

async function assertActive(page, label, expectedLabel, { bottom = true } = {}) {
  await page.locator(".timeline-feed .working-indicator").waitFor({ state: "attached" });
  await page.waitForFunction((text) => document.querySelector(".working-indicator")?.textContent?.includes(text), expectedLabel);
  const layout = await page.evaluate(() => {
    const feed = document.querySelector(".timeline-feed");
    const indicator = feed.querySelector(".working-indicator");
    const box = indicator.getBoundingClientRect();
    const timeline = document.querySelector(".timeline");
    const dock = document.querySelector(".chat-dock").getBoundingClientRect();
    const latest = [...feed.querySelectorAll(".message-row, .thinking-item, .tool-item")].filter((node) => node.getClientRects().length > 0).at(-1);
    const latestBox = latest?.getBoundingClientRect();
    return {
      position: getComputedStyle(indicator).position,
      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height },
      latestBottom: latestBox?.bottom,
      afterLatest: latest !== undefined && !!(latest.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING),
      feedLast: feed.lastElementChild === indicator,
      count: document.querySelectorAll(".working-indicator").length,
      summaries: document.querySelectorAll(".turn-process-summary").length,
      changes: document.querySelectorAll(".turn-changes").length,
      distance: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
      dockTop: dock.top,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(layout.count, 1, `${label}: duplicate working indicator`);
  assert.equal(layout.position, "static", `${label}: inline indicator must participate in normal flow`);
  assert.ok(layout.feedLast && layout.afterLatest, `${label}: indicator must follow the newest content in the feed`);
  assert.ok(layout.box.top >= layout.latestBottom - 1, `${label}: indicator overlaps latest content`);
  assert.ok(layout.box.top - layout.latestBottom < 100, `${label}: indicator is detached from latest content`);
  assert.ok(layout.box.height > 0, `${label}: indicator has no layout height`);
  assert.equal(layout.summaries, 0, `${label}: active turn acquired a process fold before run idle`);
  assert.equal(layout.changes, 0, `${label}: active turn acquired completed changes`);
  assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${label}: horizontal overflow`);
  if (bottom) {
    assert.ok(layout.distance < 3, `${label}: latest content is not followed (${layout.distance}px)`);
    assert.ok(layout.box.bottom <= layout.dockTop + 1, `${label}: composer covers the inline indicator`);
    await waitForCount(page, ".run-status-bar", 0);
  }
  return layout;
}

async function assertFloating(page, label) {
  await page.locator(".run-status-bar").waitFor({ state: "visible" });
  const layout = await page.locator(".run-status-bar").evaluate((node) => {
    const box = node.getBoundingClientRect();
    const shell = node.closest(".timeline-shell").getBoundingClientRect();
    const dock = document.querySelector(".chat-dock").getBoundingClientRect();
    const timeline = document.querySelector(".timeline");
    return { position: getComputedStyle(node).position, inFeed: node.closest(".timeline-feed") !== null,
      left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height,
      shellLeft: shell.left, shellRight: shell.right, dockTop: dock.top,
      distance: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop };
  });
  assert.equal(layout.position, "absolute", `${label}: floating control positioning`);
  assert.equal(layout.inFeed, false, `${label}: floating control entered the feed`);
  assert.ok(layout.distance > 300, `${label}: floating control appeared within 300px`);
  assert.ok(layout.height > 0 && layout.left >= layout.shellLeft && layout.right <= layout.shellRight, `${label}: floating control escaped chat bounds`);
  assert.ok(layout.top >= 0 && layout.bottom <= layout.dockTop, `${label}: floating control overlaps composer`);
  return layout;
}

async function assertCompleted(page, label, finalText) {
  await waitForCount(page, ".working-indicator, .run-status-bar", 0);
  await page.locator(".turn-process-summary[aria-expanded='false']").waitFor();
  const body = page.locator(".message-body.assistant").filter({ has: page.locator(".turn-changes") });
  assert.equal(await body.count(), 1, `${label}: completed details must belong to final reply`);
  assert.equal(await body.locator(":scope > .message-content").innerText(), finalText);
  const layout = await body.evaluate((node) => {
    const content = node.querySelector(":scope > .message-content");
    const process = node.querySelector(".turn-process");
    const changes = node.querySelector(".turn-changes");
    const footer = node.querySelector(":scope > .assistant-message-footer");
    const nodes = [content, process, changes, footer];
    return {
      present: nodes.every(Boolean),
      order: nodes.every((node, index) => index === 0 || !!(nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
      boxes: nodes.map((node) => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, height: box.height, position: getComputedStyle(node).position }; }),
      footerActions: footer?.querySelectorAll(".message-action-button").length,
      footerMeta: footer?.querySelectorAll(".message-generation-meta").length,
    };
  });
  assert.ok(layout.present && layout.order, `${label}: expected content → process → file changes → footer inside assistant body`);
  for (const [index, box] of layout.boxes.entries()) {
    assert.ok(box.height > 0 && !["absolute", "fixed"].includes(box.position), `${label}: completed section is outside normal flow`);
    if (index > 0) assert.ok(box.top >= layout.boxes[index - 1].bottom - 1, `${label}: completed sections visually overlap or reorder`);
  }
  assert.ok(layout.footerActions >= 2 && layout.footerMeta === 1, `${label}: copy/fork/tokens footer missing`);
  await body.getByRole("button", { name: "复制整段回答", exact: true }).waitFor();
  await body.getByRole("button", { name: "从此处分支", exact: true }).waitFor();
  assert.equal(await body.locator(".turn-process-body").count(), 0, `${label}: completed process is not collapsed`);
  return layout;
}

async function exercise(baseUrl, workspace, label, viewport) {
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, {});
  // Wait for the real session list before navigating (same isolation as fold smoke).
  const deadline = Date.now() + 10_000;
  while (true) {
    const { sessions } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`);
    if (sessions.some((entry) => entry.id === session.id)) break;
    assert.ok(Date.now() < deadline, `${label}: new session was not listed`);
    await new Promise((done) => setTimeout(done, 100));
  }
  const context = await browser.newContext({ viewport, ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  const report = { label, viewport, states: [] };
  reports.push(report);
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
    page.on("console", (message) => { if (message.type() === "error") failures.push(`${label}: console error: ${message.text()} ${message.location().url}`); });
    const runtimeLoaded = page.waitForResponse((response) => response.url().endsWith(`/sessions/${session.id}/runtime`) && response.ok());
    await page.goto(`${baseUrl}/#/chat/${workspace.id}/${session.id}`, { waitUntil: "domcontentloaded" });
    await page.locator(".timeline-shell").waitFor();
    await page.waitForFunction((id) => window.__jarvisSockets.some((socket) => socket.url.includes(`/sessions/${id}/events`) && socket.readyState === 1), session.id);
    // Finish the initial runtime hydration before sending frontend-only events.
    await runtimeLoaded;
    await page.locator(".composer-editor .cm-content").waitFor();
    await paint(page);
    const { emit, status, message, createdAt, beginRun } = eventFixture(page, session.id, label);
    const recordActive = async (state, text, options) => report.states.push({ state, layout: await assertActive(page, `${label}/${state}`, text, options) });
    await emit("message.created", { message: message("history-user", "user", "Earlier history for scroll regression") });
    await emit("assistant.completed", { message: message("history-reply", "assistant", Array.from({ length: 42 }, (_, i) => `History paragraph ${i + 1}: retain enough content to scroll independently of the sidebar.`).join("\n\n")) });
    await emit("message.created", { message: message("user", "user", "Check run status and file changes") });
    await emit("run.started", { status: status() });

    const commentary = message("commentary", "assistant", "Inspecting timeline status before editing.", { phase: "commentary", assistantMessageId: `${label}-response-1`, contentIndex: 0 });
    await emit("assistant.delta", { messageId: commentary.id, createdAt: commentary.createdAt, phase: commentary.phase, assistantMessageId: commentary.assistantMessageId, contentIndex: 0, delta: commentary.text });
    await page.locator(".message-row.streaming").waitFor();
    await recordActive("streaming", "正在回复");
    await screenshot(page, `${label}-running-bottom`);
    await emit("assistant.completed", { message: commentary });
    await waitForCount(page, ".message-row.streaming", 0);
    await recordActive("message-end-gap", "执行中");

    const tool = { kind: "tool", id: `${label}-edit`, createdAt: createdAt(), name: "edit", title: "Edit file", state: "running", target: "fixture.ts", inputPreview: "fixture.ts", assistantMessageId: `${label}-response-1`, contentIndex: 1 };
    await emit("tool.upsert", { tool });
    await page.locator(".tool-item.running").waitFor();
    await recordActive("tool-execution", "正在执行");
    const fileChange = { kind: "edit", path: "fixture.ts", added: 1, removed: 1, diff: "@@ -1 +1 @@\n-export const status = 'old';\n+export const status = 'ready';" };
    await emit("tool.upsert", { tool: { ...tool, state: "completed", output: "Updated fixture.ts", durationMs: 1200, fileChange } });
    await recordActive("tool-end-gap", "执行中");

    const thought = { thinkingId: `${label}-thought`, createdAt: createdAt(), assistantMessageId: `${label}-response-2`, contentIndex: 0 };
    const thoughtText = "Verify inline status.\nCheck scroll boundaries.\nPreserve thinking controls.\nVerify completed details and file diff.";
    await emit("thinking.delta", { ...thought, delta: thoughtText });
    await page.locator(".thinking-item.running .thinking-body").waitFor();
    await recordActive("thinking", "思考中");
    // Long thinking stays expanded while generating, and can still be folded manually.
    const thinking = page.locator(".thinking-item.running");
    assert.equal(await thinking.locator(".thinking-summary").getAttribute("aria-expanded"), "true");
    await thinking.locator(".thinking-summary").click();
    await waitForCount(page, ".thinking-item.running .thinking-body", 0);
    assert.equal(await thinking.locator(".thinking-summary").getAttribute("aria-expanded"), "false");
    await thinking.locator(".thinking-summary").click();
    await thinking.locator(".thinking-body").waitFor();
    await scrollDistance(page, 0);
    await recordActive("thinking-reopened", "思考中");
    // Leave it manually folded so completion also verifies that choice survives.
    await thinking.locator(".thinking-summary").click();
    await scrollDistance(page, 0);
    await emit("thinking.completed", { ...thought, text: thoughtText, durationMs: 1800 });
    await recordActive("thinking-end-gap", "执行中");

    const retrying = { attempt: 1, maxAttempts: 3, delayMs: 20_000, retryAt: new Date(Date.now() + 20_000).toISOString(), errorMessage: "Fixture retry" };
    await emit("run.retrying", { status: status({ retrying }) });
    await recordActive("retry", "等待重试");
    await emit("run.retryEnd", { status: status() });
    await emit("run.compactionStarted", { status: status({ compacting: { reason: "overflow", startedAt: new Date().toISOString() } }) });
    await recordActive("compaction", "正在压缩上下文");
    await emit("run.compactionEnded", { status: status() });
    await emit("run.stopping", { status: status({ runState: "stopping" }) });
    await recordActive("stopping", "正在停止");
    // Restore the same synthetic run to finish this frontend-only scenario.
    await emit("session.updated", { status: status() });

    for (const distance of [299, 300]) {
      await scrollDistance(page, distance);
      await waitForCount(page, ".run-status-bar", 0);
    }
    await scrollDistance(page, 301);
    report.threshold = await assertFloating(page, `${label}/301px`);
    await scrollDistance(page, 600);
    report.floating = await assertFloating(page, label);
    await recordActive("scrolled-up", "执行中", { bottom: false });
    await screenshot(page, `${label}-scrolled-up`);

    if (label === "desktop") {
      const toggle = page.locator(`.project-node[data-workspace-id="${workspace.id}"] .project-toggle`);
      const before = await page.locator(".timeline").evaluate((node) => node.scrollTop);
      await toggle.click();
      await assertFloating(page, `${label}/sidebar-toggle`);
      await toggle.click();
      await page.locator(".sidebar").dispatchEvent("wheel", { deltaY: 600 });
      await page.locator(".sidebar").evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
      await paint(page);
      const after = await page.locator(".timeline").evaluate((node) => node.scrollTop);
      assert.ok(Math.abs(before - after) < 2, `${label}: sidebar changed timeline scroll position`);
      await assertFloating(page, `${label}/sidebar-scroll`);
      const resizer = page.getByRole("separator", { name: "调整侧栏宽度" });
      await resizer.focus();
      await page.keyboard.press("ArrowRight");
      await paint(page);
      await assertFloating(page, `${label}/sidebar-resize`);
    } else {
      const editor = page.locator(".composer-editor .cm-content");
      await editor.fill(Array.from({ length: 12 }, (_, i) => `Draft line ${i + 1}`).join("\n"));
      await page.waitForFunction(() => document.querySelector(".composer-editor").getBoundingClientRect().height > 140);
      await waitForCount(page, ".run-status-bar", 0);
      await recordActive("tall-composer", "执行中", { bottom: false });
      await editor.fill("");
      await editor.blur();
      await page.waitForFunction(() => document.querySelector(".composer-editor").getBoundingClientRect().height <= 140);
      await scrollDistance(page, 600);
      await assertFloating(page, `${label}/composer-restored`);
    }
    await scrollDistance(page, 0);
    await recordActive("returned-bottom", "执行中");
    if (label === "desktop") {
      await page.locator(".sidebar").dispatchEvent("wheel", { deltaY: -600 });
      await paint(page);
      await waitForCount(page, ".run-status-bar", 0);
    }

    const finalText = "Run status regression completed.\n\nThe timeline retains process details and the file diff.";
    const final = message("final", "assistant", finalText, {
      phase: "final_answer", assistantMessageId: `${label}-response-3`, contentIndex: 0,
      generation: { usage: { input: 120, output: 32, cacheRead: 0, cacheWrite: 0, total: 152 }, durationMs: 2400 },
    });
    await emit("assistant.delta", { messageId: final.id, createdAt: final.createdAt, phase: final.phase, assistantMessageId: final.assistantMessageId, contentIndex: 0, delta: finalText });
    await recordActive("final-streaming", "正在回复");
    await emit("assistant.completed", { message: final });
    await recordActive("final-message-end-before-idle", "执行中");
    await emit("run.settled", { status: { sessionId: session.id, runState: "idle" } });
    await scrollDistance(page, 0);
    report.completed = await assertCompleted(page, label, finalText);
    await screenshot(page, `${label}-completed`);
    await page.locator(".message-body.assistant").filter({ has: page.locator(".turn-changes") }).screenshot({ path: join(shotDir, `${label}-completed-reply.png`) });

    const process = page.locator(".turn-process");
    await process.locator(".turn-process-summary").click();
    await process.locator(".turn-process-body").waitFor();
    await process.locator(".tool-item.completed").waitFor();
    const completedThinking = process.locator(".thinking-item.completed");
    await completedThinking.locator(".thinking-summary").waitFor();
    assert.equal(await completedThinking.locator(".thinking-summary").getAttribute("aria-expanded"), "false", `${label}: completion lost the manually folded thinking state`);
    await completedThinking.locator(".thinking-summary").click();
    await completedThinking.locator(".thinking-body").waitFor();
    await completedThinking.locator(".thinking-summary").click();
    await process.locator(".turn-process-summary").click();
    await waitForCount(page, ".turn-process-body", 0);

    const changes = page.locator(".turn-changes");
    await changes.locator(".turn-changes-summary").click();
    await changes.locator(".turn-changes-files").waitFor();
    assert.equal(await changes.locator(".turn-changes-file").count(), 1);
    await changes.getByText("export const status = 'ready';", { exact: false }).waitFor();
    await screenshot(page, `${label}-changes-expanded`);
    await changes.locator(".turn-changes-collapse").click();
    await waitForCount(page, ".turn-changes-files", 0);
    await scrollDistance(page, 0);
    await assertCompleted(page, label, finalText);

    // Manual compaction preserves the preceding completed reply and its details.
    beginRun("compaction", "compaction");
    await emit("run.started", { status: status({ compacting: { reason: "manual", startedAt: new Date().toISOString() } }) });
    await page.locator(".working-indicator").filter({ hasText: "正在压缩上下文" }).waitFor();
    await page.locator(".turn-process-summary[aria-expanded='false']").waitFor();
    await page.locator(".turn-changes").waitFor();
    assert.equal(await page.locator("section.turn-process-stack").count(), 0, `${label}: manual compaction reopened completed work`);
    await emit("run.settled", { status: { sessionId: session.id, runState: "idle" } });
    await assertCompleted(page, label, finalText);

    // A standalone !cmd stays after the completed reply without folding it away.
    beginRun("command", "bash");
    await emit("run.started", { status: status() });
    const standaloneTool = { kind: "tool", id: `bash:${label}-standalone`, createdAt: createdAt(), name: "bash", title: "Run command", state: "running", inputPreview: "git status", output: "clean" };
    await emit("tool.upsert", { tool: standaloneTool });
    await page.locator(".command-item.running").waitFor();
    await page.locator(".turn-changes").waitFor();
    await emit("tool.upsert", { tool: { ...standaloneTool, state: "completed" } });
    await emit("run.settled", { status: { sessionId: session.id, runState: "idle" } });
    await assertCompleted(page, label, finalText);
    const standalone = page.locator(".command-item").filter({ hasText: "git status" });
    await standalone.waitFor();
    assert.equal(await standalone.locator("xpath=ancestor::*[contains(@class, 'turn-process')]").count(), 0, `${label}: standalone command was folded into completed work`);
    const replyBeforeCommand = await standalone.evaluate((node) => !!(document.querySelector(".turn-changes").compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.ok(replyBeforeCommand, `${label}: standalone command moved above preceding reply`);

    // A completed run may contain only process entries: it must still settle into a
    // reachable folded turn rather than manufacturing an assistant reply.
    const noFinalText = `Read-only run without assistant reply (${label})`;
    await emit("message.created", { message: message("no-final-user", "user", noFinalText) });
    beginRun("no-final");
    await emit("run.started", { status: status() });
    const readOnlyTool = { kind: "tool", id: `${label}-read-only`, createdAt: createdAt(), name: "read", title: "Read file", state: "running", target: "fixture.ts", inputPreview: "fixture.ts", assistantMessageId: `${label}-no-final-response`, contentIndex: 0 };
    await emit("tool.upsert", { tool: readOnlyTool });
    await emit("tool.upsert", { tool: { ...readOnlyTool, state: "completed", output: "export const status = 'ready';" } });
    await emit("run.settled", { status: { sessionId: session.id, runState: "idle" } });
    await waitForCount(page, ".working-indicator, .run-status-bar", 0);
    const noFinalProcess = page.locator(".turn-process-summary").last();
    await noFinalProcess.waitFor({ state: "visible" });
    assert.equal(await page.locator(".timeline-feed .message-row.user").getByText(noFinalText, { exact: true }).count(), 1, `${label}: no-final user message missing`);
    assert.equal(await page.locator(".message-body.assistant").filter({ hasText: noFinalText }).count(), 0, `${label}: no-final run manufactured an assistant reply`);
    assert.equal(await noFinalProcess.getAttribute("aria-expanded"), "false", `${label}: no-final process was not folded`);
    await noFinalProcess.click();
    await page.locator(".tool-item.completed").last().waitFor({ state: "visible" });
    const noFinalTool = page.locator(".tool-item.completed").last();
    await noFinalTool.locator(".tool-summary").click();
    await noFinalTool.getByText("export const status = 'ready';", { exact: true }).waitFor({ state: "visible" });
    await noFinalProcess.click();
    await waitForCount(page, ".turn-process-body", 0);

    // A failed tool after commentary keeps the full process and lifts one failure
    // card outside the folded process.
    const failureUserText = `Commentary then tool failure (${label})`;
    await emit("message.created", { message: message("failure-user", "user", failureUserText) });
    beginRun("failure");
    await emit("run.started", { status: status() });
    const failureCommentary = message("failure-commentary", "assistant", `Full commentary before failure (${label})`, { phase: "commentary", assistantMessageId: `${label}-failure-response`, contentIndex: 0 });
    await emit("assistant.delta", { messageId: failureCommentary.id, createdAt: failureCommentary.createdAt, phase: failureCommentary.phase, assistantMessageId: failureCommentary.assistantMessageId, contentIndex: 0, delta: failureCommentary.text });
    await emit("assistant.completed", { message: failureCommentary });
    const failedTool = { kind: "tool", id: `${label}-failed-tool`, createdAt: createdAt(), name: "read", title: "Read file", state: "failed", target: "fixture.ts", inputPreview: "fixture.ts", error: `Complete tool error output (${label})`, assistantMessageId: `${label}-failure-response`, contentIndex: 1 };
    await emit("tool.upsert", { tool: failedTool });
    await emit("timeline.upsert", { item: { kind: "error", id: `${label}-failure-error`, createdAt: createdAt(), code: "PI_TOOL_FAILED", message: `Tool failed completely (${label})`, state: "failed", groupId: failedTool.id } });
    await emit("run.failed", { status: { sessionId: session.id, runState: "idle" } });
    await waitForCount(page, ".working-indicator, .run-status-bar", 0);
    const failureCard = page.locator(".turn-failure");
    await failureCard.waitFor({ state: "visible" });
    assert.equal(await failureCard.count(), 1, `${label}: expected one final turn failure card`);
    assert.equal(await failureCard.locator("xpath=ancestor::*[contains(@class, 'turn-process')]").count(), 0, `${label}: failure card remained inside collapsed process`);
    const failureProcess = page.locator(".turn-process-summary").last();
    assert.equal(await failureProcess.getAttribute("aria-expanded"), "false", `${label}: failed process was not folded`);
    await failureProcess.click();
    await page.getByText(failureCommentary.text, { exact: true }).waitFor({ state: "visible" });
    const failedToolElement = page.locator(".tool-item.failed").last();
    await failedToolElement.waitFor({ state: "visible" });
    await failedToolElement.locator(".tool-summary").click();
    await failedToolElement.getByText(failedTool.error, { exact: true }).waitFor({ state: "visible" });
    assert.equal(await failedToolElement.getByText(failedTool.error, { exact: true }).count(), 1, `${label}: failed tool content was truncated`);
    await failureProcess.click();
    await failureCard.getByRole("button", { name: "原始错误" }).click();
    await failureCard.getByText(failedTool.error, { exact: true }).waitFor({ state: "visible" });
    await screenshot(page, `${label}-failure-and-no-final`);
    assert.deepEqual(failures, [], `${label}: browser errors`);
  } catch (error) {
    const page = context.pages()[0];
    if (page !== undefined) await screenshot(page, `${label}-failure`).catch(() => undefined);
    throw error;
  } finally {
    await context.close();
  }
}

try {
  await mkdir(shotDir, { recursive: true });
  temporaryRoot = await mkdtemp(join(tmpdir(), "jarvis-run-status-home-"));
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
  const { workspace } = await api(baseUrl, "/api/workspaces", { cwd: workspacePath, label: "Run status smoke" });
  browser = await chromium.launch({ headless: true });
  for (const [label, viewport] of [["desktop", { width: 1440, height: 960 }], ["mobile", { width: 390, height: 844 }]]) {
    await exercise(baseUrl, workspace, label, viewport);
  }
  assert.deepEqual(failures, []);
  console.log(`OK: run status smoke passed on desktop and mobile; artifacts: ${shotDir}`);
} finally {
  // Nested finally blocks ensure every cleanup runs even if another cleanup fails.
  try {
    await writeFile(join(shotDir, "report.json"), JSON.stringify({ reports, failures }, null, 2));
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
