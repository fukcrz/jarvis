import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
const { generateUnifiedPatch } = await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js")).href);

// 用固定的结构化事件喂给构建好的 Jarvis，按同一组场景截图，便于改前/改后对比。
// 用法：JARVIS_COMPARE_OUT=/path/to/dir node scripts/ui-compare-shots.mjs
// 不做行为断言（行为由 ui-fold-smoke 负责），只保证每个场景都渲染出来。
const outDir = process.env["JARVIS_COMPARE_OUT"] ?? join(tmpdir(), "jarvis-compare-shots");
await mkdir(outDir, { recursive: true });
const envKeys = ["JARVIS_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NODE_ENV", "PORT", "HOST", "LOG_LEVEL", "JARVIS_DESKTOP"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "jarvis-compare-home-"));
const workspacePath = await mkdtemp(join(tmpdir(), "jarvis-compare-ws-"));
const DETAIL_KEY = "jarvis.timeline.detailLevel";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let app;
let browser;

const loginBefore = [
  "export function loginErrorMessage(code: string): string {",
  "  switch (code) {",
  "    case \"bad_password\":",
  "      return \"Wrong password\";",
  "    case \"locked\":",
  "      return \"Account locked\";",
  "    default:",
  "      return \"Login failed\";",
  "  }",
  "}",
  "",
].join("\n");
const loginAfter = [
  "export function loginErrorMessage(code: string): string {",
  "  switch (code) {",
  "    case \"bad_password\":",
  "      return \"密码不正确，请重新输入\";",
  "    case \"locked\":",
  "      return \"账号已锁定，请 15 分钟后再试\";",
  "    case \"expired\":",
  "      return \"登录已过期，请重新登录\";",
  "    default:",
  "      return \"登录失败，请稍后再试\";",
  "  }",
  "}",
  "",
].join("\n");
const testContent = [
  "import { describe, expect, it } from \"vitest\";",
  "import { loginErrorMessage } from \"../src/login\";",
  "",
  "describe(\"loginErrorMessage\", () => {",
  "  it(\"returns Chinese copy\", () => {",
  "    expect(loginErrorMessage(\"bad_password\")).toBe(\"密码不正确，请重新输入\");",
  "    expect(loginErrorMessage(\"expired\")).toBe(\"登录已过期，请重新登录\");",
  "  });",
  "});",
  "",
].join("\n");

const longAnswer = [
  "## 结论",
  "",
  "登录页的错误提示已经全部改成中文，新增 1 个测试，`npm test` 全部通过。",
  "",
  "## 改动明细",
  "",
  "| 文件 | 改动 | 行数 | 说明 | 是否需要复核 | 备注 |",
  "| --- | --- | --- | --- | --- | --- |",
  "| src/login.ts | 修改 | +6 −3 | 错误提示改成中文，新增登录过期分支 | 否 | 文案和产品确认过 |",
  "| tests/login.test.ts | 新增 | +9 | 覆盖密码错误和登录过期两种情况 | 否 | 使用 vitest |",
  "| src/i18n/zh.json | 未改 | 0 | 这次没有抽成多语言文件，后续可以再整理 | 是 | 等多语言方案定了再动 |",
  "",
  "## 关键代码",
  "",
  "```ts",
  "case \"expired\":",
  "  return \"登录已过期，请重新登录\";",
  "```",
  "",
  "## 后续建议",
  "",
  "1. 把错误码集中到一个枚举里，避免拼写错误。",
  "2. 多语言方案确定后，再把这些文案搬到 `zh.json`。",
  "3. 登录锁定时间目前写死 15 分钟，最好从接口读取。",
  "",
  "### 验证",
  "",
  "- `npm test -- login`：2 个用例通过",
  "- 手动打开登录页，输错密码能看到新的提示",
].join("\n");

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
    await sleep(100);
  }
  throw new Error(`Session ${sessionId} was not listed`);
}

async function waitForSocket(page, sessionId) {
  await page.waitForFunction((id) => {
    const sockets = window.__jarvisSockets?.filter((socket) => socket.url.includes(`/sessions/${id}/events`)) ?? [];
    return sockets.length >= 1 && sockets.at(-1)?.readyState === 1;
  }, sessionId, { timeout: 15_000 });
}

async function openChat(page, baseUrl, workspaceId, sessionId) {
  const url = `${baseUrl}/#/chat/${workspaceId}/${sessionId}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await page.locator(".timeline-shell").waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator(".timeline-shell").waitFor({ state: "visible", timeout: 20_000 });
  }
  await waitForSocket(page, sessionId);
}

function createFixture(services, ref) {
  const active = services.sessions.active.get(`${ref.workspaceId}:${ref.sessionId}`);
  assert.ok(active, "isolated session was not opened");
  const handler = services.sessions.piEvents;
  const manager = active.session.sessionManager;
  const signature = (phase) => JSON.stringify({ v: 1, id: phase, phase });
  const text = (value, phase) => ({ type: "text", text: value, ...(phase === undefined ? {} : { textSignature: signature(phase) }) });
  let last = Date.now() - 120_000;
  const assistant = (content, extra = {}) => {
    last = Math.max(Date.now(), last + 1);
    const output = extra.output ?? 0;
    delete extra.output;
    return {
      role: "assistant", timestamp: last, content, stopReason: "stop", api: "openai-responses", provider: "fixture", model: "fixture",
      usage: { input: 1200, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra,
    };
  };
  const update = (partial, event) => handler.handle(active, { type: "message_update", message: partial, assistantMessageEvent: { ...event, partial } });
  const end = (message) => {
    handler.handle(active, { type: "message_end", message });
    manager.appendMessage(message);
  };
  const user = (value) => end({ role: "user", timestamp: Date.now(), content: [{ type: "text", text: value }] });
  const start = () => handler.handle(active, { type: "agent_start" });
  const settle = () => services.sessions.settleRun(active, active.state.activeRun?.id);
  const toolStart = (call) => handler.handle(active, { type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
  const toolEnd = (call, value, isError = false, details) => {
    const result = { content: [{ type: "text", text: value }], details: details ?? (call.name === "bash" ? { exitCode: isError ? 1 : 0 } : undefined) };
    handler.handle(active, { type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError });
    manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: Date.now(), content: result.content, details: result.details, isError });
  };
  const callEnd = (partial, contentIndex) => update(partial, { type: "toolcall_end", contentIndex, toolCall: partial.content[contentIndex] });
  /** 流式发出一个思考块（带真实耗时），再发出其余文本块。 */
  const streamThinking = async (message, index, ms) => {
    const thought = message.content[index].thinking;
    update(message, { type: "thinking_start", contentIndex: index });
    update(message, { type: "thinking_delta", contentIndex: index, delta: thought });
    await sleep(ms);
    update(message, { type: "thinking_end", contentIndex: index, content: thought });
  };
  const streamText = (message, index) => {
    const value = message.content[index].text;
    update(message, { type: "text_start", contentIndex: index });
    update(message, { type: "text_delta", contentIndex: index, delta: value });
    update(message, { type: "text_end", contentIndex: index, content: value });
  };
  return { active, text, assistant, update, end, user, start, settle, toolStart, toolEnd, callEnd, streamThinking, streamText };
}

async function newSession(baseUrl, workspace) {
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await waitForSessionListed(baseUrl, workspace.id, session.id);
  return { session, fixture: createFixture(app.jarvis, { workspaceId: workspace.id, sessionId: session.id }) };
}

async function newPage(viewport, label, detail) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(label === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(({ key, value }) => {
    const NativeWebSocket = window.WebSocket;
    window.__jarvisSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) { super(...args); window.__jarvisSockets.push(this); }
    };
    if (value !== undefined) window.localStorage.setItem(key, value);
  }, { key: DETAIL_KEY, value: detail });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`${label}: page error: ${error.message}`));
  return { context, page };
}

async function shot(page, name) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await sleep(150);
  await page.screenshot({ path: join(outDir, `${name}.png`) });
}

/** 一轮完整的写代码回合：思考、说明、读/搜/改/写/命令，然后给出最终回答。 */
async function codingTurn(fixture, prefix, finalText) {
  fixture.start();
  fixture.user("把登录页的错误提示改成中文，并补一个测试。");
  const thought = "先看 login.ts 里错误码有哪些分支。\n再确认测试目录结构，测试要覆盖新增的过期分支。";
  const calls = [
    { type: "toolCall", id: `${prefix}-read`, name: "read", arguments: { path: "src/login.ts" } },
    { type: "toolCall", id: `${prefix}-grep`, name: "grep", arguments: { pattern: "loginErrorMessage", path: "src" } },
    { type: "toolCall", id: `${prefix}-edit`, name: "edit", arguments: { path: "src/login.ts", edits: [
      { oldText: "      return \"Wrong password\";\n    case \"locked\":\n      return \"Account locked\";", newText: "      return \"密码不正确，请重新输入\";\n    case \"locked\":\n      return \"账号已锁定，请 15 分钟后再试\";\n    case \"expired\":\n      return \"登录已过期，请重新登录\";" },
      { oldText: "      return \"Login failed\";", newText: "      return \"登录失败，请稍后再试\";" },
    ] } },
    { type: "toolCall", id: `${prefix}-write`, name: "write", arguments: { path: "tests/login.test.ts", content: testContent } },
    { type: "toolCall", id: `${prefix}-bash`, name: "bash", arguments: { command: "npm test -- login" } },
  ];
  const first = fixture.assistant([{ type: "thinking", thinking: thought }, fixture.text("先看一下现有的错误提示和测试结构，然后改文案、补测试。", "commentary"), ...calls], { stopReason: "toolUse", output: 420 });
  await fixture.streamThinking(first, 0, 2_100);
  fixture.streamText(first, 1);
  for (const index of [2, 3, 4, 5, 6]) fixture.callEnd(first, index);
  fixture.end(first);
  fixture.toolStart(calls[0]); fixture.toolEnd(calls[0], loginBefore);
  fixture.toolStart(calls[1]); fixture.toolEnd(calls[1], "src/login.ts:1:export function loginErrorMessage(code: string): string {\nsrc/pages/login.tsx:12:  const message = loginErrorMessage(error.code);");
  fixture.toolStart(calls[2]); fixture.toolEnd(calls[2], "Successfully replaced 2 block(s) in src/login.ts.", false, { patch: generateUnifiedPatch("src/login.ts", loginBefore, loginAfter), firstChangedLine: 4 });
  fixture.toolStart(calls[3]); fixture.toolEnd(calls[3], `Successfully wrote ${String(testContent.length)} bytes to tests/login.test.ts`);
  fixture.toolStart(calls[4]); fixture.toolEnd(calls[4], " RUN  v5.0.1\n ✓ tests/login.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)");
  const second = fixture.assistant([{ type: "thinking", thinking: "测试都过了，整理一下改动给用户。" }, fixture.text(finalText, "final_answer")], { output: 933 });
  await fixture.streamThinking(second, 0, 1_200);
  fixture.streamText(second, 1);
  fixture.end(second);
  fixture.settle();
}

async function scenarioCoding(baseUrl, workspace, viewport, label) {
  const { session, fixture } = await newSession(baseUrl, workspace);
  const { context, page } = await newPage(viewport, label);
  try {
    await openChat(page, baseUrl, workspace.id, session.id);
    await codingTurn(fixture, `${label}-coding`, "已把登录页的错误提示改成中文，新增了登录过期的提示，并补了 2 个测试，`npm test -- login` 通过。");
    await page.waitForFunction(() => document.querySelector(".thinking-item.running, .tool-item.running") === null);
    await page.getByText("npm test -- login` 通过", { exact: false }).or(page.getByText("通过。", { exact: false })).first().waitFor();
    await shot(page, `${label}-settled`);
    await page.locator(".turn-process-summary").first().click();
    await sleep(200);
    await shot(page, `${label}-expanded`);
    // 打开编辑行看 diff（改前只有原始输入）。
    const editRow = page.locator(".tool-summary").filter({ hasText: "login.ts" }).filter({ hasText: /编辑/ }).first();
    for (const group of await page.locator(".turn-process-body .activity-group-label[aria-expanded=\"false\"]").all()) await group.click().catch(() => undefined);
    if (await editRow.count() > 0 && await editRow.isVisible()) {
      await editRow.click();
      await sleep(200);
      await editRow.scrollIntoViewIfNeeded();
    }
    await shot(page, `${label}-edit-open`);
    await page.locator(".turn-process-summary").first().click();
    const changes = page.locator(".turn-changes-summary").first();
    if (await changes.count() > 0) {
      await changes.click();
      await sleep(200);
      await page.locator(".turn-changes").first().scrollIntoViewIfNeeded();
    }
    await shot(page, `${label}-turn-changes`);
  } finally {
    await context.close();
  }
  for (const detail of ["concise", "verbose"]) {
    const view = await newPage(viewport, label, detail);
    try {
      await openChat(view.page, baseUrl, workspace.id, session.id);
      await view.page.locator(".message-row.assistant").last().waitFor();
      await sleep(300);
      await shot(view.page, `${label}-detail-${detail}`);
    } finally {
      await view.context.close();
    }
  }
}

async function scenarioLongAnswer(baseUrl, workspace, viewport, label) {
  const { session, fixture } = await newSession(baseUrl, workspace);
  const { context, page } = await newPage(viewport, label);
  try {
    await openChat(page, baseUrl, workspace.id, session.id);
    fixture.start();
    fixture.user("总结一下这次改动，列个表。");
    fixture.end(fixture.assistant([fixture.text(longAnswer, "final_answer")], { output: 1480 }));
    fixture.settle();
    await page.locator(".message-content table").waitFor();
    await page.evaluate(() => { const el = document.querySelector(".timeline"); if (el) el.scrollTop = 0; });
    await shot(page, `${label}-long-top`);
    await page.locator(".message-content table").scrollIntoViewIfNeeded();
    await page.evaluate(() => { const el = document.querySelector(".timeline"); const table = document.querySelector(".message-content table"); if (el && table) el.scrollTop += table.getBoundingClientRect().top - el.getBoundingClientRect().top - 80; });
    await shot(page, `${label}-long-table`);
    await page.evaluate(() => { const el = document.querySelector(".timeline"); if (el) el.scrollTop = el.scrollHeight; });
    await page.locator(".message-row.assistant").last().hover().catch(() => undefined);
    await shot(page, `${label}-long-bottom`);
  } finally {
    await context.close();
  }
}

async function scenarioFailure(baseUrl, workspace, viewport, label) {
  const { session, fixture } = await newSession(baseUrl, workspace);
  const { context, page } = await newPage(viewport, label);
  try {
    await openChat(page, baseUrl, workspace.id, session.id);
    fixture.start();
    fixture.user("跑一下完整的检查。");
    const failedCall = { type: "toolCall", id: `${label}-failed`, name: "bash", arguments: { command: "npm run check" } };
    fixture.end(fixture.assistant([fixture.text("先跑完整检查。", "commentary"), failedCall], { stopReason: "toolUse" }));
    fixture.toolStart(failedCall);
    fixture.toolEnd(failedCall, "src/login.ts(4,7): error TS2322: Type 'number' is not assignable to type 'string'.\n1 error", true);
    fixture.end(fixture.assistant([], { stopReason: "error", errorMessage: "403 Forbidden: {\"error\":{\"message\":\"Your API key does not have access to this model\",\"type\":\"permission_error\"}}" }));
    fixture.end(fixture.assistant([], { stopReason: "error", errorMessage: "403 Forbidden: {\"error\":{\"message\":\"Your API key does not have access to this model\",\"type\":\"permission_error\"}}" }));
    app.jarvis.sessions.failRun(fixture.active, fixture.active.state.activeRun?.id, "PI_RUNTIME_ERROR", "403 Forbidden");
    await page.locator(".timeline-error, .run-failure").first().waitFor();
    await sleep(300);
    await shot(page, `${label}-failed`);
    const header = page.locator(".timeline-error-header, .run-failure-header").first();
    await header.click();
    await sleep(200);
    await shot(page, `${label}-failed-open`);
  } finally {
    await context.close();
  }
}

async function scenarioRunning(baseUrl, workspace, viewport, label) {
  const { session, fixture } = await newSession(baseUrl, workspace);
  const { context, page } = await newPage(viewport, label);
  try {
    await openChat(page, baseUrl, workspace.id, session.id);
    await codingTurn(fixture, `${label}-before-run`, longAnswer);
    fixture.start();
    fixture.user("再把注册页也改一下。");
    const calls = [
      { type: "toolCall", id: `${label}-run-read`, name: "read", arguments: { path: "src/register.ts" } },
      { type: "toolCall", id: `${label}-run-bash`, name: "bash", arguments: { command: "npm test -- register --reporter=verbose" } },
    ];
    const message = fixture.assistant([{ type: "thinking", thinking: "注册页的错误码和登录页类似，先看现有实现。" }, fixture.text("先看注册页现有的错误提示。", "commentary"), ...calls], { stopReason: "toolUse", output: 210 });
    await fixture.streamThinking(message, 0, 1_100);
    fixture.streamText(message, 1);
    fixture.callEnd(message, 2); fixture.callEnd(message, 3);
    fixture.end(message);
    fixture.toolStart(calls[0]); fixture.toolEnd(calls[0], "export function registerErrorMessage() {}");
    fixture.toolStart(calls[1]);
    await page.locator(".command-item.running").waitFor();
    await sleep(1_200);
    await shot(page, `${label}-running`);
    await page.evaluate(() => { const el = document.querySelector(".timeline"); if (el) el.scrollTop = Math.max(0, el.scrollHeight * 0.25); });
    await sleep(300);
    await shot(page, `${label}-running-scrolled`);
    fixture.toolEnd(calls[1], "ok");
    fixture.end(fixture.assistant([fixture.text("注册页也改好了。", "final_answer")]));
    fixture.settle();
  } finally {
    await context.close();
  }
}


const WIDE = { width: 1440, height: 900 };

async function sidebarShots(page, name) {
  await shot(page, name);
  const box = await page.locator(".sidebar").boundingBox();
  if (box !== null) await page.screenshot({ path: join(outDir, `${name}-header.png`), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 260) } });
}

/** PC 侧栏：项目标题栏按钮，以及（改后才有的）"新建会话"选项目弹窗，普通/聚焦模式各一套。 */
async function scenarioSidebar(baseUrl, workspace, viewport, label) {
  if (label !== "desktop") return;
  for (const extra of ["社区超市", "无人自助", "官网改版"]) {
    const cwd = await mkdtemp(join(tmpdir(), "jarvis-compare-extra-"));
    extraDirs.push(cwd);
    await api(baseUrl, "/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, label: extra }) });
  }
  const { session, fixture } = await newSession(baseUrl, workspace);
  fixture.start();
  fixture.user("把登录页的错误提示改成中文。");
  fixture.end(fixture.assistant([fixture.text("已改好。", "final_answer")]));
  fixture.settle();
  for (const mode of ["normal", "focus"]) {
    const view = await newPage(WIDE, label);
    await view.context.addInitScript((focus) => { window.localStorage.setItem("jarvis.sessions.focus", focus); }, String(mode === "focus"));
    try {
      await openChat(view.page, baseUrl, workspace.id, session.id);
      await sleep(300);
      await sidebarShots(view.page, `desktop-sidebar-${mode}`);
      const button = view.page.locator(".sidebar-toolbar-actions").getByRole("button", { name: "新建会话", exact: true });
      if (await button.count() > 0) {
        await button.hover();
        await sleep(400);
        await sidebarShots(view.page, `desktop-sidebar-${mode}-hover`);
        await button.click();
        await view.page.getByRole("dialog").waitFor();
        await sleep(250);
        await shot(view.page, `desktop-picker-${mode}`);
        if (mode === "focus") {
          // 聚焦模式下侧栏看不到的项目，也能从弹窗里新建会话。
          await view.page.getByRole("dialog").getByRole("button", { name: "官网改版" }).click();
          await view.page.getByRole("dialog").waitFor({ state: "hidden" });
          await view.page.locator(".sidebar .project-node").filter({ hasText: "官网改版" }).waitFor({ timeout: 10_000 });
          await sleep(300);
          await shot(view.page, `desktop-picker-${mode}-created`);
        }
      } else {
        await shot(view.page, `desktop-picker-${mode}`);
      }
    } finally {
      await view.context.close();
    }
  }
}

/** 一轮改了 7 个文件：看文件名小标签是否截断为 3 个 + "等 N 个"，以及简洁档是否隐藏。 */
async function scenarioManyFiles(baseUrl, workspace, viewport, label) {
  if (label !== "desktop") return;
  const { session, fixture } = await newSession(baseUrl, workspace);
  fixture.start();
  fixture.user("把所有页面的错误提示都改成中文。");
  const files = ["src/login.ts", "src/register.ts", "src/reset-password.ts", "src/profile.ts", "src/i18n/zh.json", "tests/login.test.ts", "tests/register.test.ts"];
  const calls = files.map((path, index) => ({ type: "toolCall", id: `many-${String(index)}`, name: "write", arguments: { path, content: `// ${path}\nexport const message = "中文提示";\n` } }));
  const first = fixture.assistant([fixture.text("逐个改写这些文件。", "commentary"), ...calls], { stopReason: "toolUse", output: 300 });
  fixture.streamText(first, 0);
  calls.forEach((_, index) => fixture.callEnd(first, index + 1));
  fixture.end(first);
  for (const call of calls) { fixture.toolStart(call); fixture.toolEnd(call, `Successfully wrote 40 bytes to ${call.arguments.path}`); }
  fixture.end(fixture.assistant([fixture.text("7 个文件的错误提示都改成中文了，测试也补上了。", "final_answer")], { output: 120 }));
  fixture.settle();
  for (const detail of ["normal", "concise"]) {
    const view = await newPage(WIDE, label, detail);
    try {
      await openChat(view.page, baseUrl, workspace.id, session.id);
      await view.page.locator(".message-row.assistant").last().waitFor();
      await sleep(400);
      await shot(view.page, `desktop-manyfiles-${detail}`);
      if (detail === "normal") {
        const more = view.page.locator(".turn-changes-more");
        if (await more.count() > 0) await more.first().click();
        else await view.page.locator(".turn-changes-summary").first().click();
        await sleep(300);
        await shot(view.page, `desktop-manyfiles-expanded`);
      }
    } finally {
      await view.context.close();
    }
  }
}

const extraDirs = [];
try {
  process.env.JARVIS_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, "sessions");
  process.env.NODE_ENV = "production";
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.PORT;
  delete process.env.JARVIS_DESKTOP;
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await mkdir(join(workspacePath, "tests"), { recursive: true });
  await writeFile(join(workspacePath, "src", "login.ts"), loginAfter);
  await writeFile(join(workspacePath, "tests", "login.test.ts"), testContent);
  const { buildApp } = await import(pathToFileURL(resolve("dist/server/server/app.js")).href);
  app = await buildApp({ serveStatic: true, staticRoot: resolve("dist/client") });
  const baseUrl = new URL(await app.listen({ host: "127.0.0.1", port: 0 })).origin;
  const { workspace } = await api(baseUrl, "/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: workspacePath, label: "登录页" }) });
  browser = await chromium.launch({ headless: true });
  const only = process.env["JARVIS_COMPARE_ONLY"]?.split(",");
  const scenarios = { coding: scenarioCoding, long: scenarioLongAnswer, failure: scenarioFailure, running: scenarioRunning, sidebar: scenarioSidebar, manyfiles: scenarioManyFiles };
  for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["mobile", { width: 390, height: 844 }]]) {
    for (const [name, run] of Object.entries(scenarios)) {
      if (only !== undefined ? !only.includes(name) : ["sidebar", "manyfiles"].includes(name)) continue;
      await run(baseUrl, workspace, viewport, label);
    }
  }
  console.log(`OK: compare shots written to ${outDir}`);
} finally {
  await browser?.close();
  app?.jarvis.events.terminateAll();
  await app?.close();
  restoreEnv();
  await rm(home, { recursive: true, force: true });
  await rm(workspacePath, { recursive: true, force: true });
  for (const dir of extraDirs) await rm(dir, { recursive: true, force: true });
}
