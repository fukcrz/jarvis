import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const shotDir = process.env["JARVIS_SMOKE_SHOTS"] ?? join(tmpdir(), "jarvis-mobile-session-enter-smoke");
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

async function createProject(baseUrl, cwd, label) {
  const { workspace } = await api(baseUrl, "/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, label }),
  });
  const { session } = await api(baseUrl, `/api/workspaces/${workspace.id}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { workspace, session };
}

const home = await mkdtemp(join(tmpdir(), "jarvis-mobile-enter-home-"));
const alphaPath = await mkdtemp(join(tmpdir(), "jarvis-mobile-enter-alpha-"));
const betaPath = await mkdtemp(join(tmpdir(), "jarvis-mobile-enter-beta-"));
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

  const alpha = await createProject(baseUrl, alphaPath, "Alpha");
  const beta = await createProject(baseUrl, betaPath, "Beta");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.addInitScript(({ alphaId, betaId }) => {
    window.localStorage.setItem("jarvis.workspace", alphaId);
    window.localStorage.removeItem("jarvis.session");
    window.localStorage.setItem("jarvis.mobile.session-project", "all");
    window.localStorage.setItem("jarvis.mobile.projects.expanded", JSON.stringify({ [alphaId]: true, [betaId]: true }));
  }, { alphaId: alpha.workspace.id, betaId: beta.workspace.id });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));

  const hashes = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) hashes.push(frame.url());
  });

  await page.goto(`${baseUrl}/#/projects`, { waitUntil: "domcontentloaded" });
  await page.locator(".mobile-all-sessions-page").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(`.mobile-session-row[data-session-id="${beta.session.id}"]`).waitFor({ state: "visible", timeout: 10_000 });
  await page.screenshot({ path: join(shotDir, "01-list.png") });

  await page.locator(`.mobile-session-row[data-session-id="${beta.session.id}"] .mobile-session-select`).click();
  await page.waitForTimeout(700);
  const afterBetaClick = new URL(page.url()).hash;
  await page.screenshot({ path: join(shotDir, "02-after-beta-click.png") });
  if (afterBetaClick !== `#/chat/${beta.workspace.id}/${beta.session.id}`) {
    failures.push(`first click into Beta bounced: ${afterBetaClick}`);
  }
  if (await page.locator(".mobile-chat-page").count() === 0) {
    failures.push("first click into Beta did not show the chat page");
  }

  if (await page.locator(".mobile-chat-header").count() > 0) {
    await page.getByRole("button", { name: "返回会话列表" }).click();
  }
  await page.locator(".mobile-all-sessions-page").waitFor({ state: "visible", timeout: 8_000 });
  await page.locator(`.mobile-session-row[data-session-id="${alpha.session.id}"] .mobile-session-select`).click();
  await page.waitForTimeout(700);
  const afterAlphaClick = new URL(page.url()).hash;
  await page.screenshot({ path: join(shotDir, "03-after-alpha-click.png") });
  if (afterAlphaClick !== `#/chat/${alpha.workspace.id}/${alpha.session.id}`) {
    failures.push(`first click back into Alpha bounced: ${afterAlphaClick}`);
  }

  if (await page.locator(".mobile-chat-header").count() > 0) {
    await page.getByRole("button", { name: "返回会话列表" }).click();
  }
  await page.locator(".mobile-all-sessions-page").waitFor({ state: "visible", timeout: 8_000 });
  await page.getByRole("button", { name: "在 Beta 中新建会话" }).click();
  await page.waitForTimeout(1200);
  const afterCreate = new URL(page.url()).hash;
  await page.screenshot({ path: join(shotDir, "04-after-new-session.png") });
  if (!afterCreate.startsWith(`#/chat/${beta.workspace.id}/`)) {
    failures.push(`new session in Beta bounced: ${afterCreate}`);
  }
  if (await page.locator(".mobile-chat-page").count() === 0) {
    failures.push("new session in Beta did not show the chat page");
  }

  const report = {
    baseUrl,
    hashes,
    afterBetaClick,
    afterAlphaClick,
    afterCreate,
    screenshots: {
      list: join(shotDir, "01-list.png"),
      beta: join(shotDir, "02-after-beta-click.png"),
      alpha: join(shotDir, "03-after-alpha-click.png"),
      created: join(shotDir, "04-after-new-session.png"),
    },
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log("mobile session enter smoke passed");
} finally {
  await browser?.close();
  await app?.close();
  restoreEnv();
  await rm(home, { force: true, recursive: true });
  await rm(alphaPath, { force: true, recursive: true });
  await rm(betaPath, { force: true, recursive: true });
}
