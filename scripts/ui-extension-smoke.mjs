/**
 * 扩展「选择 / 输入」卡片的冒烟验证：把 `ask_user_question` 在非终端宿主里的 RPC 回退负载投进
 * 一个真实会话，断言渲染把折叠在标题里的预览块并回各自的选项、重新同步快照不会清掉已输入的内容，
 * 并在移动端 / 桌面端各截一张图。
 *
 * 单独成脚本的原因：`ui-smoke.mjs` 的同类检查挂在整条流水线后面（命令补全、运行反馈等），
 * 前者一旦抖动就再也跑不到这里；这段检查只依赖会话页 + WebSocket，能独立、稳定地跑完。
 *
 * 用法（需要先起开发服务：npm run dev）：
 *   npm run test:ui:extension
 *   JARVIS_URL=http://127.0.0.1:28471 SHOT_DIR=/tmp node scripts/ui-extension-smoke.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.env["JARVIS_URL"] ?? "http://127.0.0.1:28471").replace(/\/$/, "");
const shotDir = process.env["SHOT_DIR"] ?? join(process.cwd(), "test-results");

/** 直接取自真实会话：`ask_user_question` 的标题 = 问题 + 每个选项的预览块。 */
const FIRST_LABEL = "a8pi → anzhiyu → relay1 → a8pi2 → relay2";
const SECOND_LABEL = "a8pi → a8pi2 → anzhiyu → relay1 → relay2";
const THIRD_LABEL = "anzhiyu → a8pi → relay1 → a8pi2 → relay2";
const OPTIONS = [
  `1. ${FIRST_LABEL} — 不发明新规则，直接沿用 terra/5.5/gpt-sol/gpt6 现有顺序；luna 只需按同一排序重排（或补齐）。`,
  `2. ${SECOND_LABEL} — 同一家（https://www.a8pi.com）的两个 key 相邻，a8pi2 上移到 anzhiyu 之前；会影响 terra/5.5/gpt-sol/gpt6 三组现有顺序。`,
  `3. ${THIRD_LABEL} — anzhiyu 提到第一优先，a8pi 第二；同样会影响 terra/5.5/gpt-sol/gpt6 现有顺序。`,
  "4. Type something.",
];
const TITLE = [
  "[统一顺序] gpt 组统一后的 provider 优先顺序，确定哪一种？",
  "",
  `--- 1. ${FIRST_LABEL} preview ---`,
  "统一后（推荐）",
  "",
  " luna  : a8pi → anzhiyu → relay-tech-gpt1 → a8pi2 → relay-tech-gpt2",
  " terra : a8pi → anzhiyu → relay-tech-gpt1 → a8pi2 → relay-tech-gpt2",
  " 5.5   : a8pi → anzhiyu → relay-tech-gpt1 → a8pi2 → relay-tech-gpt2",
  "",
  "说明：a8pi2 是 f9da106 时按「置于 relay1 之后」加的，顺序保持不变。",
  "",
  `--- 2. ${SECOND_LABEL} preview ---`,
  "按“同厂相邻”排序",
  "",
  " luna  : a8pi → a8pi2 → anzhiyu → relay-tech-gpt1 → relay-tech-gpt2",
  "",
  `--- 3. ${THIRD_LABEL} preview ---`,
  "anzhiyu 优先",
  "",
  "注意：anzhiyu 的 luna 目前正在熔断（failures=4），排队靠前意味新任务会反复先撞它，之后才降级到 relay-tech。",
].join("\n");

const failures = [];
let browser;
let workspaceDir;
let workspaceId;

try {
  workspaceDir = await mkdtemp(join(tmpdir(), "jarvis-select-smoke-"));
  const created = await (await fetch(`${baseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: workspaceDir, label: "Jarvis Select Smoke" }),
  })).json();
  workspaceId = created.workspace.id;
  const session = await (await fetch(`${baseUrl}/api/workspaces/${workspaceId}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })).json();
  const sessionId = session.session.id;

  browser = await chromium.launch({ headless: true });
  for (const [index, viewport] of [{ name: "desktop", width: 1440, height: 960 }, { name: "mobile", width: 390, height: 844 }].entries()) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
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
    page.on("pageerror", (error) => failures.push(`${viewport.name}: page error: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") failures.push(`${viewport.name}: console error: ${message.text().slice(0, 200)}`); });

    /** 记录每次提交给扩展的选择结果；后端不可见，只在这里断言。 */
    const submissions = [];
    await page.route("**/api/workspaces/*/sessions/*/extension-ui", async (route) => {
      submissions.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({ contentType: "application/json", body: "{}" });
    });
    // 真实环境里待回答的对话框由服务端保留在快照里；这里注入的卡片也要出现在 runtime 快照中，
    // 否则「重新同步」时卡片会整个消失，测不到「同一张卡片重新水合后状态是否保留」。
    let pendingInput;
    await page.route("**/api/workspaces/*/sessions/*/runtime", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const cards = [...(body.extensionUi?.cards ?? []), ...(pendingInput === undefined ? [] : [pendingInput])];
      await route.fulfill({ response, json: { ...body, extensionUi: { ...(body.extensionUi ?? { dialogs: [], cards: [], statuses: {}, widgets: {} }), cards } } });
    });

    const requestId = `c0ffee00-0000-4000-8000-00000000001${String(index)}`;
    const emit = (event) => page.evaluate((payload) => {
      const socket = window.__jarvisSockets.find((candidate) => candidate.url.includes(`/sessions/${payload.sessionId}/events`) && candidate.readyState === 1);
      if (socket === undefined) throw new Error("Session event socket is not open");
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
    }, event);
    // seq 取足够大的值，保证事件排在会话已有事件之后。
    const request = (seq, type, payload) => emit({ version: 1, sessionId, seq, emittedAt: new Date().toISOString(), type, payload });

    await page.goto(`${baseUrl}/#/chat/${workspaceId}/${sessionId}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((id) => window.__jarvisSockets?.some((socket) => socket.url.includes(`/sessions/${id}/events`) && socket.readyState === 1), sessionId, { timeout: 15_000 });
    await request(900_000_001, "extension.uiRequest", { request: { id: requestId, method: "select", title: TITLE, options: OPTIONS, timeout: 300_000 } });

    const card = page.locator(".extension-operation.select.pending");
    await card.waitFor({ state: "visible", timeout: 5_000 });
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    await card.screenshot({ path: join(shotDir, `select-${viewport.name}.png`) });

    const innerText = await card.innerText();
    const labels = (await card.locator(".extension-select-label").allTextContents()).map((label) => label.trim());
    if (innerText.includes("preview ---")) failures.push(`${viewport.name}: 折叠在标题里的预览块没有和选项合并`);
    if (JSON.stringify(labels) !== JSON.stringify([FIRST_LABEL, SECOND_LABEL, THIRD_LABEL, "Type something."])) failures.push(`${viewport.name}: 选项没有拆成序号/标签/描述：${JSON.stringify(labels)}`);
    if (innerText.split(FIRST_LABEL).length - 1 !== 1) failures.push(`${viewport.name}: 同一个选项标签渲染了多次`);
    if (await card.locator(".extension-select-preview-body").count() !== 0) failures.push(`${viewport.name}: 预览默认应当是折叠的`);
    if (await card.locator(".extension-select-option.custom").count() !== 1) failures.push(`${viewport.name}: 「Type something.」行没有独立样式`);
    if ((await card.locator(".extension-dialog-header").textContent())?.trim() !== "统一顺序") failures.push(`${viewport.name}: 问题短标签没有单独渲染`);
    if ((await card.locator(".extension-select-preview-hint").first().textContent())?.trim() !== "统一后（推荐）") failures.push(`${viewport.name}: 折叠摘要不是该选项预览的首行`);

    const firstOption = card.locator(".extension-select-option").first();
    const toggle = firstOption.locator(".extension-select-preview-toggle");
    const preview = firstOption.locator(".extension-select-preview-body");

    // 键盘：预览开关是独立控件，在它上面按 Enter 只能开合预览，不能顺带提交该选项。
    await toggle.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    if (submissions.length !== 0) failures.push(`${viewport.name}: 在预览开关上按 Enter 误提交了选项`);
    if (await preview.count() === 0) failures.push(`${viewport.name}: 在预览开关上按 Enter 没有展开预览`);
    else {
      if (!(await preview.textContent())?.includes("terra : a8pi → anzhiyu")) failures.push(`${viewport.name}: 展开的不是该选项自己的预览`);
      await card.screenshot({ path: join(shotDir, `select-${viewport.name}-expanded.png`) });
      await page.keyboard.press("Enter");
      await preview.waitFor({ state: "hidden", timeout: 5_000 });
    }

    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) failures.push(`${viewport.name}: 卡片造成了横向溢出`);

    // 选项提交的值必须是扩展给出的原始字符串（扩展按下标解析回选项）。
    await firstOption.locator(".extension-select-choice").click();
    for (const deadline = Date.now() + 5_000; submissions.length === 0 && Date.now() < deadline;) await page.waitForTimeout(50);
    if (submissions.length === 0) failures.push(`${viewport.name}: 点击选项没有提交任何结果`);
    else if (submissions.length > 1) failures.push(`${viewport.name}: 点击选项提交了 ${String(submissions.length)} 次`);
    else if (submissions[0].id !== requestId || submissions[0].value !== OPTIONS[0]) failures.push(`${viewport.name}: 提交值与扩展原始字符串不一致：${JSON.stringify(submissions[0])}`);

    await request(900_000_002, "extension.uiSettled", { id: requestId, outcome: "answered", value: OPTIONS[0] });
    const answered = page.locator(".extension-operation.answered").filter({ hasText: "已选择" });
    await answered.waitFor({ state: "visible", timeout: 5_000 });
    const answeredText = await answered.innerText();
    if (answeredText.includes("不发明新规则")) failures.push(`${viewport.name}: 已选择结果行仍然回显整串原文`);
    if (!answeredText.includes(FIRST_LABEL)) failures.push(`${viewport.name}: 已选择结果行没有显示标签`);

    // 形态不匹配的自定义 select 必须原样回退成扁平行。
    const plainId = `${requestId.slice(0, -1)}9`;
    await request(900_000_003, "extension.uiRequest", { request: { id: plainId, method: "select", title: "选择要使用的模型", options: ["gpt-5.6-luna", "gpt-5.6-terra", "deepseek-v4-flash"], timeout: 300_000 } });
    const plainCard = page.locator(".extension-operation.select.pending").filter({ hasText: "选择要使用的模型" });
    await plainCard.waitFor({ state: "visible", timeout: 5_000 });
    if (await plainCard.locator(".extension-select-plain").count() !== 3) failures.push(`${viewport.name}: 非回退格式的 select 没有原样渲染`);
    if (await plainCard.locator(".extension-select-option").count() !== 0) failures.push(`${viewport.name}: 非回退格式的 select 被误解析`);
    await plainCard.screenshot({ path: join(shotDir, `select-${viewport.name}-plain.png`) });
    await request(900_000_004, "extension.uiSettled", { id: plainId, outcome: "cancelled" });

    // 输入卡（问答题的自行输入）：移动端切后台/回前台、网络恢复都会触发 resync → 重拉权威快照。
    // 同一张卡片重新水合时不能把已经写了一半的内容清掉。
    const inputId = `${requestId.slice(0, -1)}8`;
    const answer = "一刀切，除非必要，否则不在";
    pendingInput = {
      kind: "extension-ui",
      id: `ext:${inputId}`,
      createdAt: new Date().toISOString(),
      request: { id: inputId, method: "input", title: "[严格程度] 规则写多硬？\n\n输入你的回答：", timeout: 300_000 },
    };
    await request(900_000_005, "extension.uiRequest", { request: pendingInput.request });
    const inputCard = page.locator(".extension-operation.input.pending");
    await inputCard.waitFor({ state: "visible", timeout: 5_000 });
    const field = inputCard.locator(".extension-dialog-input");
    await field.click();
    await page.keyboard.type(answer);
    await inputCard.screenshot({ path: join(shotDir, `input-${viewport.name}.png`) });
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await page.waitForTimeout(800);
    if (await inputCard.count() !== 1) failures.push(`${viewport.name}: 重新同步快照后输入卡整个消失了`);
    else if (await field.inputValue() !== answer) failures.push(`${viewport.name}: 重新同步快照后输入框内容被清空（现在是「${await field.inputValue()}」）`);
    if (submissions.length !== 1) failures.push(`${viewport.name}: 输入卡重新同步期间发生了多余提交`);
    await request(900_000_006, "extension.uiSettled", { id: inputId, outcome: "cancelled" });
    pendingInput = undefined;

    await context.close();
  }
} catch (error) {
  failures.push(`未捕获异常：${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close();
  if (workspaceId !== undefined) {
    const removed = await fetch(`${baseUrl}/api/workspaces/${workspaceId}`, { method: "DELETE" }).then((response) => response.ok).catch(() => false);
    if (!removed) failures.push(`临时工作区 ${workspaceId} 未能删除，请手动清理 ~/.jarvis/workspaces.json`);
  }
  if (workspaceDir !== undefined) await rm(workspaceDir, { force: true, recursive: true }).catch(() => undefined);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Extension dialog smoke passed → ${shotDir}/select-*.png, ${shotDir}/input-*.png`);
}
