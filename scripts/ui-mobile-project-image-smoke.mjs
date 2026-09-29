import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const shotDir = process.env["JARVIS_SMOKE_SHOTS"] ?? join(tmpdir(), "jarvis-mobile-project-image-smoke");
mkdirSync(shotDir, { recursive: true });
const envKeys = ["JARVIS_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NODE_ENV", "PORT", "HOST"];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const home = await mkdtemp(join(tmpdir(), "jarvis-mobile-project-image-home-"));
const activePath = await mkdtemp(join(tmpdir(), "jarvis-mobile-project-image-active-"));
const emptyPath = await mkdtemp(join(tmpdir(), "jarvis-mobile-project-image-empty-"));
let app;
let browser;

async function api(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${path}: ${String(response.status)}`);
  return response.json();
}

try {
  process.env.JARVIS_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, "sessions");
  process.env.NODE_ENV = "production";
  process.env.HOST = "127.0.0.1";
  delete process.env.PORT;
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await writeFile(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({
    providers: { "image-test": { baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "vision", input: ["text", "image"] }] } },
  }));

  const appModule = await import(pathToFileURL(resolve("dist/server/server/app.js")).href);
  app = await appModule.buildApp({ serveStatic: true, staticRoot: resolve("dist/client") });
  const baseUrl = new URL(await app.listen({ host: "127.0.0.1", port: 0 })).origin;
  if (baseUrl.includes(":9528")) throw new Error("refusing to bind production port 9528");

  const active = (await api(baseUrl, "/api/workspaces", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: activePath, label: "Active" }),
  })).workspace;
  await api(baseUrl, "/api/workspaces", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: emptyPath, label: "Empty" }),
  });
  const session = (await api(baseUrl, `/api/workspaces/${active.id}/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).session;
  await api(baseUrl, `/api/workspaces/${active.id}/sessions/${session.id}/model`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "image-test", modelId: "vision" }),
  });
  const staleId = randomUUID();
  const staleAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  mkdirSync(sessionDir, { recursive: true });
  const staleFile = join(sessionDir, `${staleAt.replace(/[:.]/g, "-")}_${staleId}.jsonl`);
  await writeFile(staleFile, `${JSON.stringify({ type: "session", version: 3, id: staleId, timestamp: staleAt, cwd: emptyPath })}\n`);
  await utimes(staleFile, new Date(staleAt), new Date(staleAt));

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.addInitScript(() => {
    window.localStorage.setItem("jarvis.mobile.session-project", "all");
    window.localStorage.setItem("jarvis.sessions.focus", "false");
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/index.html#/projects`, { waitUntil: "domcontentloaded" });
  await page.locator(".mobile-all-sessions-page").waitFor();
  await page.getByRole("button", { name: "展开Active的会话" }).waitFor();
  await page.getByRole("button", { name: "展开Empty的会话" }).waitFor();

  const allChip = page.locator('.mobile-session-projects button[aria-pressed="true"]');
  if (await allChip.textContent() !== "全部") throw new Error("all chip is not selected");
  const styles = await page.locator('.mobile-session-projects button').evaluateAll((buttons) => buttons.slice(0, 2).map((button) => {
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return { label: button.textContent, pressed: button.getAttribute("aria-pressed"), border: style.borderColor, background: style.backgroundColor, color: style.color, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }));
  if (styles[0].border === styles[1].border || styles[0].background === styles[1].background) throw new Error("selected all chip is not visually distinct");
  if (styles[0].rect.width <= 0 || styles[0].rect.height <= 0) throw new Error("selected chip has no visible bounds");
  await page.screenshot({ path: join(shotDir, "01-selected-all.png") });

  await page.getByRole("button", { name: "开启聚焦会话" }).click();
  if (await page.getByRole("button", { name: "展开Empty的会话" }).count() !== 0) throw new Error("project with only stale sessions is visible in focus mode");
  await page.screenshot({ path: join(shotDir, "02-focus-mode.png") });
  await page.getByRole("button", { name: "关闭聚焦会话" }).click();
  await page.getByRole("button", { name: "展开Empty的会话" }).waitFor();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  const selectedProject = page.locator('.mobile-session-projects button[aria-pressed="true"]');
  if (await selectedProject.textContent() !== "Active") throw new Error("project chip is not selected");
  const projectStyle = await selectedProject.evaluate((button) => ({ border: getComputedStyle(button).borderColor, background: getComputedStyle(button).backgroundColor }));
  if (projectStyle.border !== styles[0].border || projectStyle.background !== styles[0].background) throw new Error("selected project chip does not match the selected all chip");
  await page.locator(`.mobile-session-row[data-session-id="${session.id}"] .mobile-session-select`).click();
  await page.locator('.composer-file-input').waitFor();

  const input = page.locator('.composer-file-input');
  let chooserCount = 0;
  page.on("filechooser", () => { chooserCount += 1; });
  const png = { name: "same.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") };
  const firstChooser = page.waitForEvent("filechooser");
  await input.tap();
  await (await firstChooser).setFiles(png);
  await page.locator('.composer-attachment:not(.preparing)').first().waitFor();
  if (chooserCount !== 1) throw new Error(`first tap opened ${String(chooserCount)} file choosers`);

  const delayedClickPrevented = await input.evaluate((element) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  if (!delayedClickPrevented || chooserCount !== 1) throw new Error("delayed click reopened file chooser without a new gesture");

  const secondChooser = page.waitForEvent("filechooser");
  await input.click();
  await (await secondChooser).setFiles(png);
  await page.locator('.composer-attachment:not(.preparing)').nth(1).waitFor();
  if (chooserCount !== 2) throw new Error(`second tap opened ${String(chooserCount)} file choosers total`);
  const attachmentCount = await page.locator('.composer-attachment:not(.preparing)').count();
  if (attachmentCount !== 2) throw new Error(`same-image reselect produced ${String(attachmentCount)} attachments`);
  await page.screenshot({ path: join(shotDir, "03-same-image-twice.png") });

  const canceledChooser = page.waitForEvent("filechooser");
  await input.click();
  await (await canceledChooser).setFiles([]);
  const afterCancelChooser = page.waitForEvent("filechooser");
  await input.click();
  await (await afterCancelChooser).setFiles(png);
  await page.locator('.composer-attachment:not(.preparing)').nth(2).waitFor();
  if (chooserCount !== 4) throw new Error(`picker cancellation and retry opened ${String(chooserCount)} choosers total`);

  console.log(JSON.stringify({ styles, chooserCount, attachmentCount, screenshots: ["01-selected-all.png", "02-focus-mode.png", "03-same-image-twice.png"].map((name) => join(shotDir, name)) }, null, 2));
  console.log("mobile project and image smoke passed");
} finally {
  await browser?.close();
  await app?.close();
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { force: true, recursive: true });
  await rm(activePath, { force: true, recursive: true });
  await rm(emptyPath, { force: true, recursive: true });
}
