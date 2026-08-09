import { chromium } from "playwright";

const baseUrl = process.env["JARVIS_URL"] ?? "http://127.0.0.1:5173";
const isolatedSessionId = process.env["JARVIS_SESSION"];
const browser = await chromium.launch({ headless: true });
const failures = [];

async function capture(name, viewport, path, openNavigation = false) {
  const context = await browser.newContext({ viewport });
  if (isolatedSessionId !== undefined) {
    const workspacesResponse = await context.request.get(`${baseUrl}/api/workspaces`);
    const workspaces = await workspacesResponse.json();
    const workspaceId = workspaces.workspaces?.[0]?.id;
    if (typeof workspaceId === "string") {
      await context.addInitScript(({ workspaceId: id, sessionId: selectedSessionId }) => {
        localStorage.setItem("jarvis.workspace", id);
        localStorage.setItem("jarvis.session", selectedSessionId);
      }, { workspaceId, sessionId: isolatedSessionId });
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
    }
  }
  const page = await context.newPage();
  page.on("pageerror",  (error) => failures.push(`${name}: page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`${name}: console error: ${message.text()}`);
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".chat-header").waitFor({ state: "visible", timeout: 15_000 });
  const selectedSession = isolatedSessionId === undefined ? undefined : page.locator(`.session-row.selected[data-session-id="${isolatedSessionId}"]`);
  if (selectedSession !== undefined) await selectedSession.first().waitFor({ state: "attached", timeout: 15_000 });
  await page.waitForTimeout(1_000);
  if (openNavigation) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(".mobile-sidebar .sidebar-toolbar").waitFor({ state: "visible" });
    if (selectedSession !== undefined) await selectedSession.last().waitFor({ state: "visible" });
  } else {
    await page.locator(".desktop-sidebar .sidebar-toolbar").waitFor({ state: "visible" });
    if (selectedSession !== undefined) await selectedSession.first().waitFor({ state: "visible" });
    const projectToggle = page.locator(".project-toggle").first();
    await projectToggle.waitFor({ state: "visible" });
    if (await projectToggle.getAttribute("aria-expanded") !== "true") await projectToggle.click();
    await page.locator(".project-sessions").first().waitFor({ state: "visible" });
    await projectToggle.click();
    await page.locator(".project-toggle[aria-expanded='false']").first().waitFor({ state: "visible" });
    await projectToggle.click();
    await page.locator(".project-sessions").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Choose model" }).click();
    await page.locator(".model-menu").waitFor({ state: "visible" });
    if (await page.locator(".model-menu-item small, .model-capability").count() !== 0) failures.push(`${name}: model menu still shows redundant metadata`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Add project" }).click();
    await page.getByRole("dialog", { name: "Projects" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Rename session" }).click();
    await page.getByRole("dialog", { name: "Rename session" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Close dialog" }).click();
  }

  const viewportOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (viewportOverflow) failures.push(`${name}: unexpected horizontal viewport overflow`);
  if (!openNavigation && isolatedSessionId !== undefined) await verifyStreamingMarkdown(page, name, isolatedSessionId);
  await page.screenshot({ path, fullPage: true });
  if (!openNavigation) await verifyComposerShortcuts(page, name, isolatedSessionId);
  await context.close();
}

async function verifyStreamingMarkdown(page, name, sessionId) {
  await page.waitForFunction((selected) => window.__jarvisSockets?.some((socket) => socket.url.includes(`/sessions/${selected}/events`) && socket.readyState === WebSocket.OPEN), sessionId, { timeout: 15_000 });
  const emittedAt = new Date().toISOString();
  await page.evaluate(({ selected, emittedAt }) => {
    const socket = window.__jarvisSockets.find((candidate) => candidate.url.includes(`/sessions/${selected}/events`) && candidate.readyState === WebSocket.OPEN);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      version: 1,
      sessionId: selected,
      runId: "markdown-smoke",
      seq: 900000001,
      emittedAt,
      type: "assistant.delta",
      payload: { messageId: "markdown-smoke", delta: "# Streaming heading\n\n**Bold text** with `inline code`.\n\n- First item\n- Second item" },
    }) }));
  }, { selected: sessionId, emittedAt });

  const message = page.locator('.message-row.streaming').filter({ hasText: "Streaming heading" });
  await message.getByRole("heading", { name: "Streaming heading", level: 1 }).waitFor({ state: "visible", timeout: 5_000 });
  if (await message.locator("strong").textContent() !== "Bold text") failures.push(`${name}: streaming Markdown did not render bold text`);
  if (await message.locator("code").textContent() !== "inline code") failures.push(`${name}: streaming Markdown did not render inline code`);
  if (JSON.stringify(await message.locator("li").allTextContents()) !== JSON.stringify(["First item", "Second item"])) failures.push(`${name}: streaming Markdown did not render a list`);
  if (await message.locator(".streaming-text").count() !== 0) failures.push(`${name}: streaming message still uses the plain-text renderer`);
  if (await message.locator(".streaming-cursor").count() !== 1) failures.push(`${name}: streaming cursor is missing`);
}

async function verifyComposerShortcuts(page, name, sessionId) {
  const editor = page.locator(".composer-editor .cm-content");
  if (await editor.count() === 0) return;
  const editorSurface = page.locator(".composer-editor .cm-editor");
  const bounds = await editorSurface.boundingBox();
  if (bounds === null || bounds.height < 100) {
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
  if (sessionId !== undefined) await verifyDraftStability(page, name, sessionId, editor);
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
  await page.waitForFunction(() => document.querySelector(".composer-editor .cm-placeholder") !== null, undefined, { timeout: 5_000 });
  if (prompts.length !== 1 || prompts[0]?.text !== "First line\nSecond line") failures.push(`${name}: Enter did not send the editor value`);
}

async function verifyDraftStability(page, name, sessionId, editor) {
  const expected = "Draft remains stable while the session updates.";
  await editor.click();
  for (const [index, character] of [...expected].entries()) {
    await page.keyboard.insertText(character);
    await page.evaluate(({ selected, index }) => {
      const socket = window.__jarvisSockets.find((candidate) => candidate.url.includes(`/sessions/${selected}/events`) && candidate.readyState === WebSocket.OPEN);
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        version: 1,
        sessionId: selected,
        seq: 900001000 + index,
        emittedAt: new Date().toISOString(),
        type: "session.updated",
        payload: { status: { sessionId: selected, runState: "idle" } },
      }) }));
    }, { selected: sessionId, index });
  }
  await page.waitForTimeout(260);
  if (await editor.textContent() !== expected) failures.push(`${name}: draft changed after session updates`);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(260);
  if (!await editor.locator(".cm-placeholder").isVisible()) failures.push(`${name}: cleared draft returned after session updates`);
}

try {
  await capture("desktop", { width: 1440, height: 960 }, "/tmp/jarvis-desktop.png");
  await capture("mobile", { width: 390, height: 844 }, "/tmp/jarvis-mobile.png", true);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log("UI smoke passed", { desktop: "/tmp/jarvis-desktop.png", mobile: "/tmp/jarvis-mobile.png" });
} finally {
  await browser.close();
}
