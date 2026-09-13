import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

interface TestSocket {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
  close(): void;
}

interface TestSocketConstructor {
  new(url: string): TestSocket;
}

let app: FastifyInstance | undefined;
let jarvisHome: string;
let sessionDir: string;
let previousJarvisHome: string | undefined;
let previousAgentDir: string | undefined;
let previousSessionDir: string | undefined;

beforeEach(async () => {
  previousJarvisHome = process.env["JARVIS_HOME"];
  previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  previousSessionDir = process.env["PI_CODING_AGENT_SESSION_DIR"];
  jarvisHome = await mkdtemp(join(tmpdir(), "jarvis-app-test-"));
  sessionDir = join(jarvisHome, "sessions");
  process.env["JARVIS_HOME"] = jarvisHome;
  process.env["PI_CODING_AGENT_DIR"] = join(jarvisHome, "agent");
  process.env["PI_CODING_AGENT_SESSION_DIR"] = sessionDir;
  app = await buildApp();
});

afterEach(async () => {
  await app?.close();
  if (previousJarvisHome === undefined) delete process.env["JARVIS_HOME"];
  else process.env["JARVIS_HOME"] = previousJarvisHome;
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  if (previousSessionDir === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  else process.env["PI_CODING_AGENT_SESSION_DIR"] = previousSessionDir;
  vi.restoreAllMocks();
  await rm(jarvisHome, { force: true, recursive: true });
  app = undefined;
});

function activeApp(): FastifyInstance {
  if (app === undefined) throw new Error("Test app was not initialized");
  return app;
}

function createSocket(url: string): TestSocket {
  const constructor = (globalThis as unknown as { WebSocket?: TestSocketConstructor }).WebSocket;
  if (constructor === undefined) throw new Error("Node WebSocket is unavailable");
  return new constructor(url);
}

function waitForOpen(socket: TestSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket did not open")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket failed to connect"));
    }, { once: true });
  });
}

function nextJsonMessage(socket: TestSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket did not receive an event")), 5_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
}

/** 会话 Cookie：从 login/password 响应的 set-cookie 头中取出 `name=value` 部分。 */
function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") throw new Error("Expected a session cookie in the response");
  return raw.split(";")[0] ?? "";
}

interface InjectSocket { on(event: string, listener: (...args: unknown[]) => void): unknown; close(): void }

/** 等待注入的 WebSocket 关闭，返回关闭码（未认证时为 4401）。 */
function nextInjectSocketClose(socket: InjectSocket): Promise<number> {
  return new Promise((resolve) => { socket.on("close", (...args: unknown[]) => { resolve(Number(args[0])); }); });
}

function nextInjectSocketMessage(socket: InjectSocket): Promise<unknown> {
  return new Promise((resolve) => { socket.on("message", (...args: unknown[]) => { resolve(JSON.parse(String(args[0]))); }); });
}

async function writeToolImageSession(workspacePath: string, imageData: string): Promise<{ id: string; toolId: string }> {
  const id = randomUUID();
  const timestamp = new Date("2026-08-09T00:00:00.000Z");
  const userId = randomUUID();
  const assistantId = randomUUID();
  const toolResultId = randomUUID();
  const toolId = "call_read_image";
  const header = { type: "session", version: 3, id, timestamp: timestamp.toISOString(), cwd: workspacePath };
  const entries = [
    header,
    {
      type: "message",
      id: userId,
      parentId: null,
      timestamp: new Date(timestamp.getTime() + 1_000).toISOString(),
      message: { role: "user", content: "Read the screenshot", timestamp: timestamp.getTime() + 1_000 },
    },
    {
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: new Date(timestamp.getTime() + 2_000).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolId, name: "read", arguments: { path: "shot.png" } }],
        timestamp: timestamp.getTime() + 2_000,
      },
    },
    {
      type: "message",
      id: toolResultId,
      parentId: assistantId,
      timestamp: new Date(timestamp.getTime() + 3_000).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: toolId,
        toolName: "read",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: imageData, mimeType: "image/png" },
        ],
        timestamp: timestamp.getTime() + 3_000,
      },
    },
  ];
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, `${timestamp.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`), `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`);
  return { id, toolId };
}

async function writeConversationSession(workspacePath: string): Promise<{ id: string; user1: string; assistant1: string; user2: string; assistant2: string }> {
  const id = randomUUID();
  const timestamp = new Date("2026-08-09T00:00:00.000Z");
  const entry = (entryId: string, parentId: string | null, role: "user" | "assistant", text: string, offset: number) => {
    const entryTimestamp = new Date(timestamp.getTime() + offset).toISOString();
    const messageTimestamp = timestamp.getTime() + offset;
    return {
      type: "message",
      id: entryId,
      parentId,
      timestamp: entryTimestamp,
      message: role === "user"
        ? { role, content: text, timestamp: messageTimestamp }
        : {
          role,
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: "openai",
          model: "test-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: messageTimestamp,
        },
    };
  };
  const user1 = randomUUID();
  const assistant1 = randomUUID();
  const user2 = randomUUID();
  const assistant2 = randomUUID();
  const header = { type: "session", version: 3, id, timestamp: timestamp.toISOString(), cwd: workspacePath };
  const entries = [
    header,
    entry(user1, null, "user", "First question", 1_000),
    entry(assistant1, user1, "assistant", "First answer", 2_000),
    entry(user2, assistant1, "user", "Second question", 3_000),
    entry(assistant2, user2, "assistant", "Second answer", 4_000),
  ];
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, `${timestamp.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`), `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`);
  return {
    id,
    user1: `message:user:${String(timestamp.getTime() + 1_000)}`,
    assistant1: `message:assistant:${String(timestamp.getTime() + 2_000)}`,
    user2: `message:user:${String(timestamp.getTime() + 3_000)}`,
    assistant2: `message:assistant:${String(timestamp.getTime() + 4_000)}`,
  };
}

describe("Jarvis HTTP and WebSocket API", () => {
  it("loads settings and persists an assistant name update", async () => {
    await app?.close();
    await writeFile(join(jarvisHome, "settings.json"), JSON.stringify({ version: 1, assistantName: "Legacy Jarvis", uiMode: "beautiful" }));
    app = await buildApp();
    const server = activeApp();

    const initial = await server.inject({ method: "GET", url: "/api/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ settings: { assistantName: "Legacy Jarvis" } });

    const updated = await server.inject({ method: "PATCH", url: "/api/settings", payload: { assistantName: "Renamed Jarvis" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ settings: { assistantName: "Renamed Jarvis" } });
    const persisted = JSON.parse(await readFile(join(jarvisHome, "settings.json"), "utf8")) as { assistantName: string };
    expect(persisted.assistantName).toBe("Renamed Jarvis");
  });

  it("lists the platform's directory root picker", async () => {
    const roots = await activeApp().inject({ method: "GET", url: "/api/directories?roots=true" });
    expect(roots.statusCode).toBe(200);
    if (platform() === "win32") {
      expect(roots.json()).toMatchObject({ directory: { name: "Drives", path: "", isRootPicker: true } });
      expect((roots.json() as { directory: { entries: Array<{ path: string }> } }).directory.entries).toContainEqual(expect.objectContaining({ path: "C:\\" }));
    } else {
      expect(roots.json()).toMatchObject({ directory: { name: "/", path: "/", isRootPicker: false } });
    }
  });

  it("lists directories with absolute paths and does not hide or confine them to the workspace", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "directory-workspace");
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await mkdir(join(workspacePath, ".git"));
    await mkdir(join(workspacePath, "node_modules", "hidden"), { recursive: true });
    await writeFile(join(workspacePath, "README.md"), "# Test");
    await writeFile(join(jarvisHome, "sibling.txt"), "outside");
    const created = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } });
    const workspace = created.json() as { workspace: { id: string } };
    const posix = (value: string) => value.replaceAll("\\", "/");

    const listing = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/directory` });
    expect(listing.statusCode).toBe(200);
    const directory = (listing.json() as { directory: { path: string; parent?: string; entries: Array<{ name: string; kind: string }> } }).directory;
    expect(posix(directory.path)).toBe(posix(workspacePath));
    expect(directory.parent === undefined ? undefined : posix(directory.parent)).toBe(posix(dirname(workspacePath)));
    expect(directory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: ".git", kind: "directory" }),
      expect.objectContaining({ name: "node_modules", kind: "directory" }),
      expect.objectContaining({ name: "README.md", kind: "file" }),
      expect.objectContaining({ name: "src", kind: "directory" }),
    ]));

    const parent = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/directory?path=${encodeURIComponent("..")}` });
    expect(parent.statusCode).toBe(200);
    expect((parent.json() as { directory: { entries: Array<{ name: string }> } }).directory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "directory-workspace" }),
      expect.objectContaining({ name: "sibling.txt" }),
    ]));

    const file = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/file?path=${encodeURIComponent(join(jarvisHome, "sibling.txt"))}` });
    expect(file.statusCode).toBe(200);
    expect(file.json()).toMatchObject({ file: { name: "sibling.txt", content: "outside" } });
  });

  it("searches workspace files for composer references without exposing ignored directories", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "file-search-workspace");
    await mkdir(join(workspacePath, "src", "server"), { recursive: true });
    await mkdir(join(workspacePath, "node_modules", "hidden"), { recursive: true });
    await mkdir(join(workspacePath, ".git", "objects"), { recursive: true });
    await writeFile(join(workspacePath, "src", "server", "session-service.ts"), "export {};");
    await writeFile(join(workspacePath, "README.md"), "# Test");
    await writeFile(join(workspacePath, "node_modules", "hidden", "package.js"), "module.exports = {};");
    await writeFile(join(workspacePath, ".git", "objects", "ignored"), "ignored");

    const created = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } });
    const workspace = created.json() as { workspace: { id: string } };
    const searched = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/files?query=session` });

    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toEqual({ files: [{ path: "src/server/session-service.ts" }] });

    const allFiles = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/files` });
    expect(allFiles.statusCode).toBe(200);
    expect(allFiles.json()).toMatchObject({ files: expect.arrayContaining([{ path: "README.md" }, { path: "src/server/session-service.ts" }]) });
    expect(JSON.stringify(allFiles.json())).not.toContain("node_modules");
    expect(JSON.stringify(allFiles.json())).not.toContain(".git");
  });

  it("lists session JSONL files for composer session references", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "session-file-search-workspace");
    await mkdir(workspacePath);
    const created = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } });
    const workspace = created.json() as { workspace: { id: string } };
    const sessionId = randomUUID();
    const timestamp = new Date().toISOString();
    const sessionFile = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: workspacePath }),
      JSON.stringify({ type: "session_info", id: "aabbccdd", parentId: null, timestamp, name: "Auth refactor" }),
      JSON.stringify({ type: "message", id: "11223344", parentId: "aabbccdd", timestamp, message: { role: "user", content: "Review authentication", timestamp: Date.parse(timestamp) } }),
    ].join("\n") + "\n");

    const searched = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/session-files` });

    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toEqual({ sessions: [{ id: sessionId, name: "Auth refactor", preview: "Review authentication", path: sessionFile }] });
  });

  it("lists a composer command that Jarvis can execute", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "commands-workspace");
    await mkdir(workspacePath);
    const createdWorkspace = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } });
    const workspace = createdWorkspace.json() as { workspace: { id: string } };
    const createdSession = await server.inject({ method: "POST", url: `/api/workspaces/${workspace.workspace.id}/sessions`, payload: {} });
    const session = createdSession.json() as { session: { id: string } };

    const response = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/sessions/${session.session.id}/commands` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ commands: expect.arrayContaining([expect.objectContaining({ name: "compact" })]) });
  });

  it("marks out-of-scope models and still allows selecting them", async () => {
    const agentDir = join(jarvisHome, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ enabledModels: ["test-a/*"] }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "test-a": { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "alpha" }] },
        "test-b": { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "beta" }] },
      },
    }));

    const server = activeApp();
    const workspacePath = join(jarvisHome, "model-scope-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;

    const runtime = await server.inject({ method: "GET", url: `${baseUrl}/runtime` });
    expect(runtime.statusCode).toBe(200);
    const available = runtime.json<{ model: { available: Array<{ provider: string; id: string; inScope: boolean }> } }>().model.available;
    expect(available).toEqual(expect.arrayContaining([
      { provider: "test-a", id: "alpha", name: "alpha", reasoning: false, vision: false, inScope: true },
      { provider: "test-b", id: "beta", name: "beta", reasoning: false, vision: false, inScope: false },
    ]));

    // Selecting a model outside the enabled scope is the escape hatch: Pi's
    // setModel only checks auth, scope only limits cycling/defaults.
    const switched = await server.inject({ method: "PUT", url: `${baseUrl}/model`, payload: { provider: "test-b", modelId: "beta" } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ model: { provider: "test-b", id: "beta", inScope: false } });

    const after = await server.inject({ method: "GET", url: `${baseUrl}/runtime` });
    expect(after.json()).toMatchObject({ model: { current: { provider: "test-b", id: "beta", inScope: false } } });
  });

  it("reads and updates the enabled models scope via the settings API", async () => {
    const agentDir = join(jarvisHome, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "test-a": { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "alpha" }, { id: "gamma" }] },
        "test-b": { baseUrl: "http://localhost:1/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "beta" }] },
      },
    }));

    const server = activeApp();

    // 未设置 pattern → 不限制（全部启用）
    const initial = await server.inject({ method: "GET", url: "/api/settings/enabled-models" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ enabledModels: { patterns: [], resolved: [] } });

    // 保存部分选择 → 写入精确 patterns，resolved 返回解析结果
    const partial = await server.inject({ method: "PUT", url: "/api/settings/enabled-models", payload: { models: [{ provider: "test-a", id: "alpha" }, { provider: "test-b", id: "beta" }] } });
    expect(partial.statusCode).toBe(200);
    const body = partial.json<{ enabledModels: { patterns: string[]; resolved: Array<{ provider: string; id: string }> } }>().enabledModels;
    expect(body.patterns).toEqual(["test-a/alpha", "test-b/**"]);
    expect(body.resolved).toEqual(expect.arrayContaining([
      { provider: "test-a", id: "alpha" },
      { provider: "test-b", id: "beta" },
    ]));

    const persisted = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { enabledModels?: string[] };
    expect(persisted.enabledModels).toEqual(["test-a/alpha", "test-b/**"]);

    // 会话模型选择器按新范围过滤
    const workspacePath = join(jarvisHome, "enabled-models-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const runtime = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${session.id}/runtime` });
    const available = runtime.json<{ model: { available: Array<{ provider: string; id: string; inScope: boolean }> } }>().model.available;
    expect(available.find((model) => model.provider === "test-a" && model.id === "gamma")).toMatchObject({ inScope: false });
    expect(available.find((model) => model.provider === "test-a" && model.id === "alpha")).toMatchObject({ inScope: true });

    // 全选 → 折叠为 provider/** patterns
    const all = await server.inject({ method: "PUT", url: "/api/settings/enabled-models", payload: { models: [{ provider: "test-a", id: "alpha" }, { provider: "test-a", id: "gamma" }, { provider: "test-b", id: "beta" }] } });
    expect(all.statusCode).toBe(200);
    expect(all.json<{ enabledModels: { patterns: string[] } }>().enabledModels.patterns).toEqual(["test-a/**", "test-b/**"]);

    // 清空选择 → 不限制
    const cleared = await server.inject({ method: "PUT", url: "/api/settings/enabled-models", payload: { models: [] } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ enabledModels: { patterns: [], resolved: [] } });

    // 未知模型 → 400
    const unknown = await server.inject({ method: "PUT", url: "/api/settings/enabled-models", payload: { models: [{ provider: "test-a", id: "nope" }] } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: "MODEL_NOT_FOUND" } });
  });

  it("fetches the model list from a custom provider's compatibility endpoint", async () => {
    const agentDir = join(jarvisHome, "agent");
    await mkdir(agentDir, { recursive: true });
    const { createServer } = await import("node:http");
    const httpServer = createServer((request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "alpha-new" }, { id: "beta-new" }] }));
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { "test-custom": { baseUrl, api: "openai-completions", apiKey: "test-key", models: [{ id: "alpha" }] } },
    }));
    try {
      const server = activeApp();
      const response = await server.inject({ method: "POST", url: "/api/settings/providers/test-custom/fetch-models", payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ models: [{ id: "alpha-new" }, { id: "beta-new" }] });
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("saves custom provider headers and compat without dropping unknown compat keys", async () => {
    const agentDir = join(jarvisHome, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [{ id: "alpha", cost: { input: 1 } }],
          compat: { supportsDeveloperRole: true, extraFlag: true },
        },
      },
    }));
    const server = activeApp();
    const saved = await server.inject({
      method: "PUT",
      url: "/api/settings/custom-providers/local",
      payload: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        authHeader: true,
        headers: { "X-Title": "Jarvis" },
        compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
        models: [{ id: "alpha", reasoning: true, vision: true }],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      provider: {
        id: "local",
        headers: { "X-Title": "Jarvis" },
        compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
        models: [{ id: "alpha", reasoning: true, vision: true }],
      },
    });
    const persisted = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as {
      providers: { local: { headers?: Record<string, string>; compat?: Record<string, unknown>; models: Array<{ reasoning: boolean; input: string[]; cost?: unknown }> } };
    };
    expect(persisted.providers.local.headers).toEqual({ "X-Title": "Jarvis" });
    expect(persisted.providers.local.compat).toEqual({ extraFlag: true, supportsDeveloperRole: false, thinkingFormat: "deepseek" });
    expect(persisted.providers.local.models[0]).toMatchObject({ reasoning: true, input: ["text", "image"], cost: { input: 1 } });
    const listed = await server.inject({ method: "GET", url: "/api/settings/custom-providers" });
    expect(listed.json<{ providers: Array<{ id: string; headers?: Record<string, string>; compat?: Record<string, unknown> }> }>().providers.find((provider) => provider.id === "local")).toMatchObject({
      headers: { "X-Title": "Jarvis" },
      compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
    });
  });

  it("overrides a built-in provider connection without replacing its model catalog", async () => {
    const agentDir = join(jarvisHome, "agent");
    await mkdir(agentDir, { recursive: true });
    const server = activeApp();
    const before = (await server.inject({ method: "GET", url: "/api/settings/providers" })).json<{ providers: Array<{ id: string; models: unknown[]; custom: boolean; override?: unknown }> }>().providers.find((provider) => provider.id === "openai");
    expect(before?.custom).toBe(false);
    expect(before?.override).toBeUndefined();
    const catalogSize = before?.models.length ?? 0;
    expect(catalogSize).toBeGreaterThan(0);

    const saved = await server.inject({
      method: "PUT",
      url: "/api/settings/providers/openai/override",
      payload: {
        baseUrl: "https://proxy.example.com/v1",
        headers: { "X-Proxy": "1" },
        compat: { supportsDeveloperRole: false },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      override: {
        baseUrl: "https://proxy.example.com/v1",
        headers: { "X-Proxy": "1" },
        compat: { supportsDeveloperRole: false },
      },
    });

    const persisted = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as { providers: { openai: Record<string, unknown> } };
    expect(persisted.providers.openai).toEqual({
      baseUrl: "https://proxy.example.com/v1",
      headers: { "X-Proxy": "1" },
      compat: { supportsDeveloperRole: false },
    });
    expect(persisted.providers.openai["models"]).toBeUndefined();
    expect(persisted.providers.openai["api"]).toBeUndefined();

    const listed = (await server.inject({ method: "GET", url: "/api/settings/providers" })).json<{ providers: Array<{ id: string; custom: boolean; override?: { baseUrl?: string }; models: unknown[] }> }>().providers.find((provider) => provider.id === "openai");
    expect(listed).toMatchObject({ custom: false, override: { baseUrl: "https://proxy.example.com/v1" } });
    expect(listed?.models.length).toBe(catalogSize);

    const customList = await server.inject({ method: "GET", url: "/api/settings/custom-providers" });
    expect(customList.json<{ providers: Array<{ id: string }> }>().providers.find((provider) => provider.id === "openai")).toBeUndefined();

    const emptied = await server.inject({ method: "PUT", url: "/api/settings/providers/openai/override", payload: {} });
    expect(emptied.statusCode).toBe(200);
    expect(emptied.json()).toEqual({ override: null });
    expect(JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")).providers["openai"]).toBeUndefined();

    const restored = await server.inject({
      method: "PUT",
      url: "/api/settings/providers/openai/override",
      payload: { baseUrl: "https://proxy.example.com/v1" },
    });
    expect(restored.statusCode).toBe(200);

    const cleared = await server.inject({ method: "DELETE", url: "/api/settings/providers/openai/override" });
    expect(cleared.statusCode).toBe(200);
    const after = JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as { providers: Record<string, unknown> };
    expect(after.providers["openai"]).toBeUndefined();
  });

  it("fetches the model list from a built-in provider override", async () => {
    const agentDir = join(jarvisHome, "agent");
    await mkdir(agentDir, { recursive: true });
    const { createServer } = await import("node:http");
    const seen: { url?: string; header?: string } = {};
    const httpServer = createServer((request, response) => {
      seen.url = request.url;
      seen.header = typeof request.headers["x-proxy"] === "string" ? request.headers["x-proxy"] : undefined;
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "proxy-model" }] }));
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
    const server = activeApp();
    const saved = await server.inject({
      method: "PUT",
      url: "/api/settings/providers/openai/override",
      payload: { baseUrl, headers: { "X-Proxy": "1" } },
    });
    expect(saved.statusCode).toBe(200);
    try {
      const response = await server.inject({ method: "POST", url: "/api/settings/providers/openai/fetch-models", payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ models: [{ id: "proxy-model" }] });
      expect(seen.url).toBe("/v1/models");
      expect(seen.header).toBe("1");
    } finally {
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects connection overrides on a custom provider", async () => {
    const agentDir = join(jarvisHome, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: { local: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "alpha" }] } },
    }));
    const server = activeApp();
    const response = await server.inject({ method: "PUT", url: "/api/settings/providers/local/override", payload: { baseUrl: "https://proxy.example.com/v1" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "PROVIDER_IS_CUSTOM" } });
  });

  it("starts a manual compaction once for a repeated direct request", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "manual-compact-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const compactSpy = vi.spyOn(AgentSession.prototype, "compact").mockResolvedValue(undefined as never);
    const requestId = randomUUID();
    const url = `/api/workspaces/${workspace.id}/sessions/${session.id}/compact`;

    const first = await server.inject({ method: "POST", url, payload: { customInstructions: "Keep the test evidence", clientRequestId: requestId } });
    expect(first.statusCode).toBe(200);
    const accepted = first.json() as { accepted: boolean; runId: string };
    expect(accepted.accepted).toBe(true);
    await vi.waitFor(() => expect(compactSpy).toHaveBeenCalledWith("Keep the test evidence"));

    const replay = await server.inject({ method: "POST", url, payload: { customInstructions: "Keep the test evidence", clientRequestId: requestId } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(accepted);
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });

  it("routes /compact through Jarvis once and leaves attachments or a same-named Pi template alone", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "compact-command-workspace");
    await mkdir(join(workspacePath, ".pi", "prompts"), { recursive: true });
    const createdWorkspace = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } });
    const workspace = createdWorkspace.json() as { workspace: { id: string } };
    const createdSession = await server.inject({ method: "POST", url: `/api/workspaces/${workspace.workspace.id}/sessions`, payload: {} });
    const session = createdSession.json() as { session: { id: string } };
    const promptPath = join(workspacePath, ".pi", "prompts", "compact.md");

    const compactSpy = vi.spyOn(AgentSession.prototype, "compact").mockResolvedValue(undefined as never);
    const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockResolvedValue(undefined);
    const requestId = randomUUID();
    const first = await server.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.workspace.id}/sessions/${session.session.id}/prompt`,
      payload: { text: "/compact preserve current work", clientRequestId: requestId },
    });
    expect(first.statusCode).toBe(200);
    const accepted = first.json() as { accepted: boolean; runId: string };
    expect(accepted.accepted).toBe(true);
    await vi.waitFor(() => expect(compactSpy).toHaveBeenCalledWith("preserve current work"));

    const replay = await server.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.workspace.id}/sessions/${session.session.id}/prompt`,
      payload: { text: "/compact preserve current work", clientRequestId: requestId },
    });
    expect(replay.json()).toEqual(accepted);
    expect(compactSpy).toHaveBeenCalledTimes(1);

    const attachedPrompt = await server.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.workspace.id}/sessions/${session.session.id}/prompt`,
      payload: {
        text: "/compact",
        clientRequestId: randomUUID(),
        images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      },
    });
    expect(attachedPrompt.statusCode).toBe(200);
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalledWith("/compact", expect.objectContaining({ images: expect.any(Array) })));
    expect(compactSpy).toHaveBeenCalledTimes(1);

    await writeFile(promptPath, "---\ndescription: Project compact template\n---\nTemplate body");
    const templateWorkspace = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } });
    const templateSession = await server.inject({ method: "POST", url: `/api/workspaces/${templateWorkspace.json<{ workspace: { id: string } }>().workspace.id}/sessions`, payload: {} });
    const templateRef = { workspaceId: templateWorkspace.json<{ workspace: { id: string } }>().workspace.id, sessionId: templateSession.json<{ session: { id: string } }>().session.id };

    const commands = await server.inject({ method: "GET", url: `/api/workspaces/${templateRef.workspaceId}/sessions/${templateRef.sessionId}/commands` });
    expect(commands.json()).toMatchObject({ commands: expect.arrayContaining([expect.objectContaining({ name: "compact", source: "prompt" })]) });
    expect(commands.json()).not.toMatchObject({ commands: expect.arrayContaining([expect.objectContaining({ name: "compact", source: "jarvis" })]) });

    const templateRequest = await server.inject({
      method: "POST",
      url: `/api/workspaces/${templateRef.workspaceId}/sessions/${templateRef.sessionId}/prompt`,
      payload: { text: "/compact", clientRequestId: randomUUID() },
    });
    expect(templateRequest.statusCode).toBe(200);
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalledWith("/compact", expect.anything()));
    expect(compactSpy).toHaveBeenCalledTimes(1);
  });

  it("prefers a same-named Pi extension command over Jarvis compact", async () => {
    const server = activeApp();
    const extensionsPath = join(jarvisHome, "agent", "extensions");
    await mkdir(extensionsPath, { recursive: true });
    await writeFile(join(extensionsPath, "compact-command.js"), `export default function (pi) {
  pi.registerCommand("compact", {
    description: "Project compact command",
    handler: async () => {},
  });
}
`);
    const workspacePath = join(jarvisHome, "extension-compact-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const compactSpy = vi.spyOn(AgentSession.prototype, "compact").mockResolvedValue(undefined as never);
    const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockResolvedValue(undefined);

    const commands = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${session.id}/commands` });
    expect(commands.statusCode).toBe(200);
    expect(commands.json()).toMatchObject({ commands: expect.arrayContaining([{ name: "compact", description: "Project compact command", source: "extension" }]) });
    expect(commands.json()).not.toMatchObject({ commands: expect.arrayContaining([expect.objectContaining({ name: "compact", source: "jarvis" })]) });

    const response = await server.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/sessions/${session.id}/prompt`,
      payload: { text: "/compact", clientRequestId: randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalledWith("/compact", expect.anything()));
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("lists selectable child directories and records a project's last opened time", async () => {
    const server = activeApp();
    const browserRoot = join(jarvisHome, "browser-root");
    const project = join(browserRoot, "project");
    await mkdir(project, { recursive: true });
    await mkdir(join(browserRoot, ".git"));
    await writeFile(join(browserRoot, "notes.txt"), "not a directory");

    const listing = await server.inject({ method: "GET", url: `/api/directories?path=${encodeURIComponent(browserRoot)}` });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({ directory: { path: browserRoot, isGitRepository: true, entries: [{ name: ".git", path: join(browserRoot, ".git") }, { name: "project", path: project }] } });

    const created = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: project } });
    expect(created.statusCode).toBe(200);
    const workspace = created.json() as { workspace: { id: string; lastOpenedAt: string } };
    expect(workspace.workspace.lastOpenedAt).toEqual(expect.any(String));

    const opened = await server.inject({ method: "POST", url: `/api/workspaces/${workspace.workspace.id}/open`, payload: {} });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ workspace: { id: workspace.workspace.id, lastOpenedAt: expect.any(String) } });
  });

  it("returns API validation errors and persists workspace changes", async () => {
    const server = activeApp();
    const health = await server.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, version: 1 });

    const invalid = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: "" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });

    const emptyJson = await server.inject({ method: "DELETE", url: "/api/workspaces/00000000-0000-4000-8000-000000000000", headers: { "content-type": "application/json" }, payload: "" });
    expect(emptyJson.statusCode).toBe(400);
    expect(emptyJson.json()).toMatchObject({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });

    const invalidModel = await server.inject({ method: "PUT", url: "/api/workspaces/00000000-0000-4000-8000-000000000000/sessions/00000000-0000-4000-8000-000000000000/model", payload: { provider: "", modelId: "" } });
    expect(invalidModel.statusCode).toBe(400);
    expect(invalidModel.json()).toMatchObject({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });

    const invalidThinking = await server.inject({ method: "PUT", url: "/api/workspaces/00000000-0000-4000-8000-000000000000/sessions/00000000-0000-4000-8000-000000000000/thinking", payload: { level: "turbo" } });
    expect(invalidThinking.statusCode).toBe(400);
    expect(invalidThinking.json()).toMatchObject({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });

    const workspacePath = join(jarvisHome, "workspace");
    await mkdir(workspacePath);
    const created = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath, label: "Scratch" } });
    expect(created.statusCode).toBe(200);
    const workspace = created.json() as { workspace: { id: string; cwd: string; label: string; sortOrder: number } };
    expect(workspace.workspace).toMatchObject({ cwd: workspacePath, label: "Scratch", sortOrder: expect.any(Number) });

    const anotherPath = join(jarvisHome, "another-workspace");
    await mkdir(anotherPath);
    const another = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: anotherPath, label: "Another" } });
    const anotherWorkspace = another.json() as { workspace: { id: string; sortOrder: number } };
    const listedBeforeReorder = await server.inject({ method: "GET", url: "/api/workspaces" });
    const allWorkspaceIds = (listedBeforeReorder.json() as { workspaces: Array<{ id: string }> }).workspaces.map((item) => item.id);
    const reordered = await server.inject({ method: "PUT", url: "/api/workspaces/order", payload: { ids: [anotherWorkspace.workspace.id, workspace.workspace.id, ...allWorkspaceIds.filter((id) => id !== anotherWorkspace.workspace.id && id !== workspace.workspace.id)] } });
    expect(reordered.statusCode).toBe(200);
    const reorderedWorkspaces = (reordered.json() as { workspaces: Array<{ id: string; sortOrder: number }> }).workspaces;
    expect(reorderedWorkspaces.find((item) => item.id === anotherWorkspace.workspace.id)).toMatchObject({ sortOrder: 0 });
    expect(reorderedWorkspaces.find((item) => item.id === workspace.workspace.id)).toMatchObject({ sortOrder: 1 });

    const renamed = await server.inject({ method: "PATCH", url: `/api/workspaces/${workspace.workspace.id}`, payload: { label: "Renamed" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ workspace: { id: workspace.workspace.id, label: "Renamed" } });

    const removed = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true });
  });

  it("serves concrete assets and falls back to the SPA in production mode", async () => {
    const staticRoot = join(jarvisHome, "static");
    await mkdir(join(staticRoot, "assets"), { recursive: true });
    await writeFile(join(staticRoot, "index.html"), "<main>Jarvis shell</main>");
    await writeFile(join(staticRoot, "assets", "app.js"), "window.jarvis = true;");
    await writeFile(join(staticRoot, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");

    await activeApp().close();
    app = await buildApp({ serveStatic: true, staticRoot });
    const server = activeApp();

    const asset = await server.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("application/javascript");
    expect(asset.body).toBe("window.jarvis = true;");

    const favicon = await server.inject({ method: "GET", url: "/favicon.svg" });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["content-type"]).toContain("image/svg+xml");
    expect(favicon.body).toBe("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");

    const fallback = await server.inject({ method: "GET", url: "/sessions/example" });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toBe("<main>Jarvis shell</main>");

    const missingRootFile = await server.inject({ method: "GET", url: "/missing.ico" });
    expect(missingRootFile.statusCode).toBe(200);
    expect(missingRootFile.body).toBe("<main>Jarvis shell</main>");

    const missingApi = await server.inject({ method: "GET", url: "/api/not-a-route" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  it("serves local files via absolute and workspace-relative paths, with download support", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    const workspaceRoot = join(jarvisHome, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const registered = await activeApp().inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspaceRoot } });
    expect(registered.statusCode).toBe(200);
    const absolutePath = join(workspaceRoot, "demo.png");
    await writeFile(absolutePath, png);
    await writeFile(join(workspaceRoot, "shot.png"), png);
    await writeFile(join(workspaceRoot, "notes.pdf"), "%PDF-1.4");
    await writeFile(join(workspaceRoot, "secret.txt"), "private");

    // 绝对路径：/api/files?path=/abs/demo.png
    const absolute = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent(absolutePath)}` });
    expect(absolute.statusCode).toBe(200);
    expect(absolute.headers["content-type"]).toContain("image/png");
    expect(absolute.rawPayload).toEqual(png);

    // 相对路径 + cwd 基准：/api/files?path=shot.png&cwd=/workspace
    const relative = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("shot.png")}&cwd=${encodeURIComponent(workspaceRoot)}` });
    expect(relative.statusCode).toBe(200);
    expect(relative.headers["content-type"]).toContain("image/png");
    expect(relative.rawPayload).toEqual(png);

    // 相对路径无 cwd 时回退到进程 cwd：找不到 → 404
    const missing = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("nope.png")}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "FILE_NOT_FOUND" } });

    // 非图片扩展名不再拒绝：文本文件按 text/plain 返回
    const textFile = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("secret.txt")}&cwd=${encodeURIComponent(workspaceRoot)}` });
    expect(textFile.statusCode).toBe(200);
    expect(textFile.headers["content-type"]).toContain("text/plain");
    expect(textFile.rawPayload.toString()).toBe("private");

    const checkedText = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("secret.txt")}&cwd=${encodeURIComponent(workspaceRoot)}&text=check` });
    expect(checkedText.statusCode).toBe(200);
    expect(checkedText.json()).toEqual({ file: { path: join(workspaceRoot, "secret.txt"), name: "secret.txt", content: "", size: 7, truncated: false } });

    const previewText = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("secret.txt")}&cwd=${encodeURIComponent(workspaceRoot)}&text=1` });
    expect(previewText.statusCode).toBe(200);
    expect(previewText.json()).toEqual({ file: { path: join(workspaceRoot, "secret.txt"), name: "secret.txt", content: "private", size: 7, truncated: false } });

    await writeFile(join(workspaceRoot, "invalid.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    const invalidText = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("invalid.txt")}&cwd=${encodeURIComponent(workspaceRoot)}&text=1` });
    expect(invalidText.statusCode).toBe(415);
    expect(invalidText.json()).toMatchObject({ error: { code: "FILE_BINARY" } });

    await writeFile(join(workspaceRoot, "binary.txt"), Buffer.from([0x61, 0x00, 0x62]));
    const binaryText = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("binary.txt")}&cwd=${encodeURIComponent(workspaceRoot)}&text=check` });
    expect(binaryText.statusCode).toBe(415);
    expect(binaryText.json()).toMatchObject({ error: { code: "FILE_BINARY" } });

    await writeFile(join(workspaceRoot, "page.html"), "<script>alert(1)</script>");
    const htmlText = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("page.html")}&cwd=${encodeURIComponent(workspaceRoot)}&text=1` });
    expect(htmlText.statusCode).toBe(200);
    expect(htmlText.json()).toMatchObject({ file: { content: "<script>alert(1)</script>" } });

    // PDF 按 application/pdf 返回
    const pdf = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("notes.pdf")}&cwd=${encodeURIComponent(workspaceRoot)}` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");

    // download=1 附加附件分发头
    const download = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent("notes.pdf")}&cwd=${encodeURIComponent(workspaceRoot)}&download=1` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment;");
    expect(download.headers["content-disposition"]).toContain("notes.pdf");

    // 未知扩展名回退到 octet-stream
    const unknownPath = join(workspaceRoot, "blob.unknownext");
    await writeFile(unknownPath, "data");
    const unknown = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent(unknownPath)}` });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.headers["content-type"]).toContain("application/octet-stream");

    // 工作区之外的绝对路径也可以读取（例如系统临时目录里的截图）。
    const outsideDir = await mkdtemp(join(tmpdir(), "jarvis-outside-"));
    try {
      const outsidePath = join(outsideDir, "outside.txt");
      await writeFile(outsidePath, "outside");
      const outside = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent(outsidePath)}` });
      expect(outside.statusCode).toBe(200);
      expect(outside.rawPayload.toString()).toBe("outside");
    } finally {
      await rm(outsideDir, { force: true, recursive: true });
    }

    // 目录 → 404
    const directory = await activeApp().inject({ method: "GET", url: `/api/files?path=${encodeURIComponent(workspaceRoot)}` });
    expect(directory.statusCode).toBe(404);
    expect(directory.json()).toMatchObject({ error: { code: "FILE_NOT_FOUND" } });
  });

  it("streams files with byte range support so media can seek", async () => {
    const workspaceRoot = join(jarvisHome, "range-workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const registered = await activeApp().inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspaceRoot } });
    expect(registered.statusCode).toBe(200);
    await writeFile(join(workspaceRoot, "clip.mp4"), "01234567");
    const url = (range?: string) => ({ method: "GET" as const, url: `/api/files?path=clip.mp4&cwd=${encodeURIComponent(workspaceRoot)}`, ...(range === undefined ? {} : { headers: { range } }) });

    const full = await activeApp().inject(url());
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["content-type"]).toContain("video/mp4");
    expect(full.rawPayload.toString()).toBe("01234567");

    const head = await activeApp().inject(url("bytes=0-3"));
    expect(head.statusCode).toBe(206);
    expect(head.headers["content-range"]).toBe("bytes 0-3/8");
    expect(head.headers["content-length"]).toBe("4");
    expect(head.rawPayload.toString()).toBe("0123");

    const tail = await activeApp().inject(url("bytes=4-"));
    expect(tail.statusCode).toBe(206);
    expect(tail.headers["content-range"]).toBe("bytes 4-7/8");
    expect(tail.rawPayload.toString()).toBe("4567");

    const suffix = await activeApp().inject(url("bytes=-2"));
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe("bytes 6-7/8");
    expect(suffix.rawPayload.toString()).toBe("67");

    // 越界 → 416，并告知实际大小
    const unsatisfiable = await activeApp().inject(url("bytes=99-"));
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe("bytes */8");

    // 多段 Range（浏览器极少发）不做支持，退回整档返回
    const multi = await activeApp().inject(url("bytes=0-1,3-4"));
    expect(multi.statusCode).toBe(200);
    expect(multi.rawPayload.toString()).toBe("01234567");
  });

  it("deletes files and recursively deletes directories, including paths outside the workspace", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "entry-delete-workspace");
    const nestedPath = join(workspacePath, "src", "nested");
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(workspacePath, "remove.txt"), "remove");
    await writeFile(join(nestedPath, "keep.txt"), "remove");
    await writeFile(join(jarvisHome, "outside.txt"), "outside");
    const created = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } });
    const workspace = created.json() as { workspace: { id: string } };

    const file = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/entry?path=remove.txt` });
    expect(file.statusCode).toBe(200);
    expect(file.json()).toEqual({ removed: true });
    expect(existsSync(join(workspacePath, "remove.txt"))).toBe(false);

    const directory = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/entry?path=src` });
    expect(directory.statusCode).toBe(200);
    expect(existsSync(join(workspacePath, "src"))).toBe(false);

    const root = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/entry?path=` });
    expect(root.statusCode).toBe(400);
    expect(root.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const dot = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/entry?path=.` });
    expect(dot.statusCode).toBe(400);
    expect(dot.json()).toMatchObject({ error: { code: "FILE_DELETE_INVALID" } });

    if (platform() !== "win32") {
      await symlink(join(jarvisHome, "outside.txt"), join(workspacePath, "linked.txt"));
      const linked = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/entry?path=linked.txt` });
      expect(linked.statusCode).toBe(400);
      expect(linked.json()).toMatchObject({ error: { code: "FILE_DELETE_INVALID" } });
    }

    const outside = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/entry?path=..%2Foutside.txt` });
    expect(outside.statusCode).toBe(200);
    expect(existsSync(join(jarvisHome, "outside.txt"))).toBe(false);
  });

  it("deletes a session JSONL file and broadcasts a workspace event", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "delete-session-workspace");
    await mkdir(workspacePath);
    const created = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath, label: "Delete session" } });
    const workspace = created.json() as { workspace: { id: string } };
    const sessionId = randomUUID();
    const timestamp = new Date().toISOString();
    const sessionFile = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: workspacePath })}\n`);
    expect(existsSync(sessionFile)).toBe(true);

    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(`/api/workspaces/${workspace.workspace.id}/events`, address);
    endpoint.protocol = "ws:";
    const socket = createSocket(endpoint.toString());
    await waitForOpen(socket);

    const received = nextJsonMessage(socket);
    const removed = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/sessions/${sessionId}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true });
    await expect(received).resolves.toEqual({ version: 1, type: "session.deleted", workspaceId: workspace.workspace.id, sessionId });
    expect(existsSync(sessionFile)).toBe(false);

    const listed = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/sessions` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ sessions: [] });
    socket.close();
  });

  it("searches the full session text, not only the title or first message", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "fulltext-search-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);

    const miss = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions?query=no-such-needle` });
    expect(miss.statusCode).toBe(200);
    expect(miss.json()).toEqual({ sessions: [] });

    // "Second answer" 只出现在后续 assistant 消息中，不在标题也不在首条用户消息里。
    const hit = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions?query=${encodeURIComponent("Second answer")}` });
    expect(hit.statusCode).toBe(200);
    const sessions = (hit.json() as { sessions: ({ id: string; matchSnippet?: string })[] }).sessions;
    expect(sessions.map((session) => session.id)).toContain(source.id);
    const matched = sessions.find((session) => session.id === source.id);
    expect(matched?.matchSnippet).toContain("Second answer");

    // 无 query 的普通列表不携带命中片段。
    const plain = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions` });
    for (const session of (plain.json() as { sessions: ({ matchSnippet?: string })[] }).sessions) expect(session.matchSnippet).toBeUndefined();
  });

  it("deletes a newly-created session before Pi persists its JSONL file", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "new-session-delete-workspace");
    await mkdir(workspacePath);
    const createdWorkspace = await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath, label: "New session delete" } });
    const workspace = createdWorkspace.json() as { workspace: { id: string } };
    const createdSession = await server.inject({ method: "POST", url: `/api/workspaces/${workspace.workspace.id}/sessions`, payload: {} });
    expect(createdSession.statusCode).toBe(200);
    const session = createdSession.json() as { session: { id: string } };

    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(`/api/workspaces/${workspace.workspace.id}/events`, address);
    endpoint.protocol = "ws:";
    const socket = createSocket(endpoint.toString());
    await waitForOpen(socket);

    const received = nextJsonMessage(socket);
    const removed = await server.inject({ method: "DELETE", url: `/api/workspaces/${workspace.workspace.id}/sessions/${session.session.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true });
    await expect(received).resolves.toEqual({ version: 1, type: "session.deleted", workspaceId: workspace.workspace.id, sessionId: session.session.id });

    const listed = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.workspace.id}/sessions` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ sessions: [] });
    socket.close();
  });

  it("cleans idle project sessions while keeping the current and busy ones", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "cleanup-sessions-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath, label: "Cleanup sessions" } })).json<{ workspace: { id: string } }>().workspace;
    const keep = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const idle = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const busy = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions/${busy.id}/prompt`, payload: { text: "keep running", clientRequestId: randomUUID() } });
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalled());

    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(`/api/workspaces/${workspace.id}/events`, address);
    endpoint.protocol = "ws:";
    const socket = createSocket(endpoint.toString());
    await waitForOpen(socket);
    const received = nextJsonMessage(socket);

    const cleaned = await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions/cleanup`, payload: { keepSessionId: keep.id } });
    expect(cleaned.statusCode).toBe(200);
    const body = cleaned.json() as { removed: string[]; skipped: Array<{ id: string; reason: string }> };
    expect(body.removed).toEqual([idle.id]);
    expect(body.skipped).toEqual([{ id: busy.id, reason: "busy" }]);
    await expect(received).resolves.toEqual({ version: 1, type: "session.deleted", workspaceId: workspace.id, sessionId: idle.id });

    const listed = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions` });
    expect(listed.statusCode).toBe(200);
    const remaining = (listed.json() as { sessions: Array<{ id: string }> }).sessions.map((session) => session.id).sort();
    expect(remaining).toEqual([busy.id, keep.id].sort());
    socket.close();
  });

  it("stars a session and skips it during cleanup", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "starred-sessions-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath, label: "Starred sessions" } })).json<{ workspace: { id: string } }>().workspace;
    const keep = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const starred = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const idle = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;

    const patched = await server.inject({ method: "PATCH", url: `/api/workspaces/${workspace.id}/sessions/${starred.id}`, payload: { starred: true } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ session: { id: starred.id, starred: true } });

    const listed = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions` });
    expect((listed.json() as { sessions: Array<{ id: string; starred?: boolean }> }).sessions.find((session) => session.id === starred.id)?.starred).toBe(true);

    const cleaned = await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions/cleanup`, payload: { keepSessionId: keep.id } });
    expect(cleaned.statusCode).toBe(200);
    expect(cleaned.json()).toMatchObject({ removed: [idle.id], skipped: [] });

    const remaining = (await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions` })).json() as { sessions: Array<{ id: string; starred?: boolean }> };
    expect(remaining.sessions.map((session) => session.id).sort()).toEqual([keep.id, starred.id].sort());
    expect(remaining.sessions.find((session) => session.id === starred.id)?.starred).toBe(true);
  });

  it("serves tool images from an opened session without inlining bytes in the timeline", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "tool-image-workspace");
    await mkdir(workspacePath);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const imageData = png.toString("base64");
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeToolImageSession(workspacePath, imageData);
    const closed = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${source.id}/media/${source.toolId}/0` });
    expect(closed.statusCode).toBe(404);

    const timeline = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${source.id}/timeline` });
    expect(timeline.statusCode).toBe(200);
    const items = (timeline.json() as { items: Array<{ kind: string; id: string; images?: Array<{ mimeType: string; data?: string; url?: string }> }> }).items;
    const tool = items.find((item) => item.kind === "tool" && item.id === source.toolId);
    expect(tool?.images).toEqual([{ mimeType: "image/png", url: `/api/workspaces/${workspace.id}/sessions/${source.id}/media/${source.toolId}/0` }]);
    expect(JSON.stringify(timeline.json())).not.toContain(imageData);

    const media = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${source.id}/media/${source.toolId}/0` });
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toContain("image/png");
    expect(media.rawPayload).toEqual(png);

    const missing = await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${source.id}/media/${source.toolId}/9` });
    expect(missing.statusCode).toBe(404);
  });

  it("forks user and assistant message history into independent sessions", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "fork-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${source.id}`;

    const forkAtUser = await server.inject({ method: "POST", url: `${baseUrl}/fork`, payload: { messageId: source.user2 } });
    const forkAtAssistant = await server.inject({ method: "POST", url: `${baseUrl}/fork`, payload: { messageId: source.assistant1 } });
    expect(forkAtUser.statusCode).toBe(200);
    expect(forkAtAssistant.statusCode).toBe(200);
    const userFork = forkAtUser.json<{ session: { id: string } }>().session;
    const assistantFork = forkAtAssistant.json<{ session: { id: string } }>().session;
    expect(userFork.id).not.toBe(source.id);
    expect(assistantFork.id).not.toBe(source.id);

    const userHistory = (await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${userFork.id}/timeline` })).json<{ items: Array<{ id: string }> }>();
    const assistantHistory = (await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${assistantFork.id}/timeline` })).json<{ items: Array<{ id: string }> }>();
    expect(userHistory.items.map((item) => item.id)).toEqual([source.user1, source.assistant1, source.user2]);
    expect(assistantHistory.items.map((item) => item.id)).toEqual([source.user1, source.assistant1]);
  });

  it("forks all messages when messageId is omitted on an idle session", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "fork-omitted-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${source.id}`;

    const forked = await server.inject({ method: "POST", url: `${baseUrl}/fork`, payload: {} });
    expect(forked.statusCode).toBe(200);
    const session = forked.json<{ session: { id: string } }>().session;
    expect(session.id).not.toBe(source.id);
    const history = (await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${session.id}/timeline` })).json<{ items: Array<{ id: string }> }>();
    expect(history.items.map((item) => item.id)).toEqual([source.user1, source.assistant1, source.user2, source.assistant2]);
  });

  it("session-level fork while running stops at the last settled turn", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "fork-running-omitted-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${source.id}`;
    // 模拟真实运行：prompt 挂起，但用户消息已追加到分支（正在输出中的这一轮）。
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(function (this: AgentSession, text: string) {
      this.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      return new Promise(() => undefined) as never;
    });
    await server.inject({ method: "POST", url: `${baseUrl}/prompt`, payload: { text: "Keep running", clientRequestId: randomUUID() } });

    const forked = await server.inject({ method: "POST", url: `${baseUrl}/fork`, payload: {} });
    expect(forked.statusCode).toBe(200);
    const session = forked.json<{ session: { id: string } }>().session;
    const history = (await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${session.id}/timeline` })).json<{ items: Array<{ id: string }> }>();
    // 正在输出的 user 消息不进分支：只到上一条（assistant2）。
    expect(history.items.map((item) => item.id)).toEqual([source.user1, source.assistant1, source.user2, source.assistant2]);
  });

  it("edits only a user message, truncates the visible tail, and publishes a rewrite", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "edit-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${source.id}`;

    const invalid = await server.inject({ method: "POST", url: `${baseUrl}/edit-and-resend`, payload: { messageId: source.assistant1, text: "No", clientRequestId: randomUUID() } });
    expect(invalid.statusCode).toBe(404);
    expect(invalid.json()).toMatchObject({ error: { code: "MESSAGE_NOT_FOUND" } });

    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(`${baseUrl}/events`, address);
    endpoint.protocol = "ws:";
    const socket = createSocket(endpoint.toString());
    await waitForOpen(socket);
    const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);

    const rewritten = nextJsonMessage(socket);
    const response = await server.inject({ method: "POST", url: `${baseUrl}/edit-and-resend`, payload: { messageId: source.user2, text: "Edited question", clientRequestId: randomUUID() } });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalledWith("Edited question", expect.objectContaining({ source: "rpc" })));
    await expect(rewritten).resolves.toMatchObject({ type: "session.rewritten", sessionId: source.id, payload: { items: [{ id: source.user1 }, { id: source.assistant1 }], status: { runState: "idle" } } });

    const timeline = (await server.inject({ method: "GET", url: `${baseUrl}/timeline` })).json<{ items: Array<{ id: string }> }>();
    expect(timeline.items.map((item) => item.id)).toEqual([source.user1, source.assistant1]);
    socket.close();
  });

  it("serializes concurrent rewrites and runs extension shutdown before replacement", async () => {
    const server = activeApp();
    const extensionsPath = join(jarvisHome, "agent", "extensions");
    await mkdir(extensionsPath, { recursive: true });
    const logPath = join(jarvisHome, "extension-lifecycle.log");
    await writeFile(join(extensionsPath, "lifecycle-log.ts"), `import { appendFileSync } from "node:fs";
      const logPath = ${JSON.stringify(logPath)};
      export default function (pi) {
        pi.on("session_start", async (event) => { appendFileSync(logPath, "start:" + event.reason + "\\n"); });
        pi.on("session_shutdown", async (event, ctx) => {
          ctx.ui.setStatus("lifecycle", "closing");
          appendFileSync(logPath, "shutdown:" + event.reason + "\\n");
        });
      }`);
    const workspacePath = join(jarvisHome, "edit-lifecycle-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${source.id}`;
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);

    const [first, second] = await Promise.all([
      server.inject({ method: "POST", url: `${baseUrl}/edit-and-resend`, payload: { messageId: source.user2, text: "First edit", clientRequestId: randomUUID() } }),
      server.inject({ method: "POST", url: `${baseUrl}/edit-and-resend`, payload: { messageId: source.user2, text: "Second edit", clientRequestId: randomUUID() } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    await vi.waitFor(async () => {
      await expect(readFile(logPath, "utf8")).resolves.toContain("shutdown:resume\n");
    });
    const lifecycle = await readFile(logPath, "utf8");
    expect(lifecycle.indexOf("shutdown:resume\n")).toBeGreaterThan(lifecycle.indexOf("start:"));
    expect(lifecycle.match(/shutdown:resume\n/g)).toHaveLength(1);
  });

  it("keeps the originating run active through an extension compaction handoff and continuation", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "compaction-handoff-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation((callback) => {
      listener = callback as unknown as typeof listener;
      return () => undefined;
    });
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;

    const accepted = (await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Continue this task", clientRequestId: randomUUID() } })).json<{ runId: string }>();
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" } });
    listener?.({ type: "agent_settled" });
    listener?.({ type: "compaction_start", reason: "manual" });

    const compacting = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ status: { runState: string; activeRun?: { id: string }; compacting?: unknown } }>();
    expect(compacting.status).toMatchObject({ runState: "running", activeRun: { id: accepted.runId }, compacting: { reason: "manual" } });

    listener?.({ type: "compaction_end", reason: "manual", result: { summary: "summary" }, aborted: false, willRetry: false });
    listener?.({ type: "agent_start" });
    const continuing = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ status: { runState: string; activeRun?: { id: string } } }>();
    expect(continuing.status).toMatchObject({ runState: "running", activeRun: { id: accepted.runId } });

    listener?.({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
    listener?.({ type: "agent_settled" });
    await vi.waitFor(async () => {
      const settled = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ status: { runState: string; lastError?: unknown } }>();
      expect(settled.status).toMatchObject({ runState: "idle" });
      expect(settled.status.lastError).toBeUndefined();
    });
  });

  it("settles a stopped run when Pi abort never resolves", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "abort-timeout-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    vi.spyOn(AgentSession.prototype, "abort").mockImplementation(() => new Promise(() => undefined) as never);
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;
    const accepted = (await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Keep running", clientRequestId: randomUUID() } })).json<{ runId: string }>();

    vi.useFakeTimers();
    const stopping = server.inject({ method: "POST", url: `${sessionUrl}/abort`, payload: { runId: accepted.runId } });
    await vi.advanceTimersByTimeAsync(8_000);
    const response = await stopping;
    expect(response.statusCode).toBe(200);
    const runtime = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ status: { runState: string; activeRun?: unknown } }>();
    expect(runtime.status).toMatchObject({ runState: "idle" });
    expect(runtime.status.activeRun).toBeUndefined();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("allows Fork while the session is running but still rejects edit", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "message-action-busy-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${source.id}`;
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    await server.inject({ method: "POST", url: `${baseUrl}/prompt`, payload: { text: "Keep running", clientRequestId: randomUUID() } });

    const fork = await server.inject({ method: "POST", url: `${baseUrl}/fork`, payload: { messageId: source.user1 } });
    expect(fork.statusCode).toBe(200);
    const forked = fork.json<{ session: { id: string } }>().session;
    expect(forked.id).not.toBe(source.id);
    const history = (await server.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/sessions/${forked.id}/timeline` })).json<{ items: Array<{ id: string }> }>();
    expect(history.items.map((item) => item.id)).toEqual([source.user1]);

    const edit = await server.inject({ method: "POST", url: `${baseUrl}/edit-and-resend`, payload: { messageId: source.user1, text: "Edited", clientRequestId: randomUUID() } });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ error: { code: "SESSION_BUSY" } });
  });

  it("delivers a workspace event through the standard WebSocket endpoint", async () => {
    const server = activeApp();
    const listed = await server.inject({ method: "GET", url: "/api/workspaces" });
    const workspaces = listed.json() as { workspaces: Array<{ id: string }> };
    const workspace = workspaces.workspaces[0];
    if (workspace === undefined) throw new Error("Expected default workspace");

    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL(`/api/workspaces/${workspace.id}/events`, address);
    endpoint.protocol = "ws:";
    const socket = createSocket(endpoint.toString());
    await waitForOpen(socket);

    const expected = {
      version: 1 as const,
      type: "session.updated" as const,
      workspaceId: workspace.id,
      session: {
        id: "5f6c305e-d51a-447f-a62a-d0f4835c946f",
        workspaceId: workspace.id,
        name: null,
        preview: "Test event",
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        runState: "idle" as const,
      },
    };
    const received = nextJsonMessage(socket);
    server.jarvis.events.publishWorkspace(workspace.id, expected);

    await expect(received).resolves.toEqual(expected);
    socket.close();
  });

  it("starts a bash run for !cmd and streams output deltas to the session socket", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "bash-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const bashSpy = vi.spyOn(AgentSession.prototype, "executeBash").mockImplementation(async (command, onChunk) => {
      onChunk?.(`ran ${command}`);
      return { output: `ran ${command}`, exitCode: 0, cancelled: false, truncated: false } as never;
    });
    const requestId = randomUUID();
    const url = `/api/workspaces/${workspace.id}/sessions/${session.id}/bash`;

    const response = await server.inject({ method: "POST", url, payload: { command: "echo hi", excludeFromContext: true, clientRequestId: requestId } });
    expect(response.statusCode).toBe(200);
    const accepted = response.json() as { accepted: boolean; runId: string };
    expect(accepted.accepted).toBe(true);
    await vi.waitFor(() => expect(bashSpy).toHaveBeenCalledWith("echo hi", expect.any(Function), expect.objectContaining({ excludeFromContext: true })));

    const replay = await server.inject({ method: "POST", url, payload: { command: "echo hi", excludeFromContext: true, clientRequestId: requestId } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(accepted);
    expect(bashSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty bash command and a bash command while a run is active", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "bash-validation-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const url = `/api/workspaces/${workspace.id}/sessions/${session.id}/bash`;

    const empty = await server.inject({ method: "POST", url, payload: { command: "   ", excludeFromContext: false, clientRequestId: randomUUID() } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: "COMMAND_EMPTY" } });

    const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions/${session.id}/prompt`, payload: { text: "keep running", clientRequestId: randomUUID() } });
    await vi.waitFor(() => expect(promptSpy).toHaveBeenCalled());

    const busy = await server.inject({ method: "POST", url, payload: { command: "echo busy", excludeFromContext: false, clientRequestId: randomUUID() } });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "SESSION_BUSY" } });
  });
});

describe("extension UI endpoint", () => {
  it("publishes session_start dialogs and retains them in the runtime snapshot", async () => {
    const server = activeApp();
    const extensionsPath = join(jarvisHome, "agent", "extensions");
    await mkdir(extensionsPath, { recursive: true });
    await writeFile(join(extensionsPath, "startup-confirm.ts"), `export default function (pi) {
      pi.on("session_start", async (_event, ctx) => { await ctx.ui.confirm("Confirm startup", "Allow this session?"); });
    }`);
    const workspacePath = join(jarvisHome, "extension-ui-startup-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const runtimeUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}/runtime`;

    await vi.waitFor(async () => {
      const runtime = (await server.inject({ method: "GET", url: runtimeUrl })).json<{ extensionUi?: { dialogs: Array<{ request: { id: string; method: string; title: string } }> } }>();
      expect(runtime.extensionUi?.dialogs).toEqual([expect.objectContaining({ request: expect.objectContaining({ method: "confirm", title: "Confirm startup" }) })]);
    });
    const runtime = (await server.inject({ method: "GET", url: runtimeUrl })).json<{ extensionUi: { dialogs: Array<{ request: { id: string } }> } }>();
    const response = await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions/${session.id}/extension-ui`, payload: { id: runtime.extensionUi.dialogs[0]!.request.id, confirmed: false } });
    expect(response.statusCode).toBe(200);
  });

  it("resolves a pending extension UI request and rejects unknown ids", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "extension-ui-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const url = `/api/workspaces/${workspace.id}/sessions/${session.id}/extension-ui`;
    const unknown = await server.inject({ method: "POST", url, payload: { id: randomUUID(), value: "x" } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "UI_REQUEST_NOT_FOUND" } });

    const invalid = await server.inject({ method: "POST", url, payload: { id: "not-a-uuid", value: "x" } });
    expect(invalid.statusCode).toBe(400);
  });

  it("rejects responses for cancelled-while-confirming shapes", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "extension-ui-workspace-2");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const url = `/api/workspaces/${workspace.id}/sessions/${session.id}/extension-ui`;
    const response = await server.inject({ method: "POST", url, payload: { id: randomUUID(), cancelled: true, value: "both" } });
    expect(response.statusCode).toBe(404); // 未知 id（没有任何 pending 请求）
  });
});

describe("message queue", () => {
  it("queues prompts as follow-up by default and as steering when requested", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "queue-steer-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;

    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    const steerSpy = vi.spyOn(AgentSession.prototype, "steer").mockResolvedValue(undefined);
    const followUpSpy = vi.spyOn(AgentSession.prototype, "followUp").mockResolvedValue(undefined);
    await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Keep running", clientRequestId: randomUUID() } });

    // 缺省：后续消息（全部完成后投递）。
    const queued = await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Later note", clientRequestId: randomUUID() } });
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({ accepted: true, queued: true, behavior: "followUp" });
    await vi.waitFor(() => expect(followUpSpy).toHaveBeenCalledWith("Later note", []));

    // 显式 behavior=steer：插队（当前回合工具调用后投递）。
    const steering = await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Steer now", clientRequestId: randomUUID(), behavior: "steer" } });
    expect(steering.statusCode).toBe(200);
    expect(steering.json()).toMatchObject({ accepted: true, queued: true, behavior: "steer" });
    await vi.waitFor(() => expect(steerSpy).toHaveBeenCalledWith("Steer now", []));
    expect(followUpSpy).toHaveBeenCalledTimes(1);
  });

  it("switches a queued message between follow-up and steering", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "queue-toggle-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation((callback) => {
      listener = callback as unknown as typeof listener;
      return () => undefined;
    });
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    const steering: string[] = ["First steer"];
    const followUp: string[] = ["Later note"];
    const steerSpy = vi.spyOn(AgentSession.prototype, "steer").mockResolvedValue(undefined);
    const followUpSpy = vi.spyOn(AgentSession.prototype, "followUp").mockResolvedValue(undefined);
    vi.spyOn(AgentSession.prototype, "getSteeringMessages").mockImplementation(() => steering);
    vi.spyOn(AgentSession.prototype, "getFollowUpMessages").mockImplementation(() => followUp);
    vi.spyOn(AgentSession.prototype, "clearQueue").mockImplementation(() => {
      const removed = { steering: [...steering], followUp: [...followUp] };
      steering.splice(0, steering.length);
      followUp.splice(0, followUp.length);
      return removed as never;
    });
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;
    await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Continue", clientRequestId: randomUUID() } });
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ type: "queue_update", steering: [...steering], followUp: [...followUp] });

    let runtime = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: Array<{ id: string; kind: string }>; followUp: Array<{ id: string; kind: string }> } }>();
    const followUpId = runtime.queue.followUp[0]?.id;
    expect(followUpId).toBeDefined();

    // 后续 → 插队：其余消息按原顺序重入，目标以 steer 入队。
    const switched = await server.inject({ method: "PATCH", url: `${sessionUrl}/queue/${encodeURIComponent(followUpId!)}`, payload: { kind: "steer" } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({ updated: { id: followUpId, kind: "steer", text: "Later note" } });
    await vi.waitFor(() => expect(steerSpy).toHaveBeenCalledWith("First steer"));
    await vi.waitFor(() => expect(steerSpy).toHaveBeenCalledWith("Later note"));
    expect(followUpSpy).toHaveBeenCalledTimes(0);

    // 插队 → 后续：目标以 followUp 重入。模拟真实重入后的队列状态。
    steering.push("First steer", "Later note");
    listener?.({ type: "queue_update", steering: [...steering], followUp: [] });
    runtime = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: Array<{ id: string; kind: string }>; followUp: Array<{ id: string; kind: string }> } }>();
    const steerId = runtime.queue.steering[1]?.id;
    expect(steerId).toBeDefined();
    const back = await server.inject({ method: "PATCH", url: `${sessionUrl}/queue/${encodeURIComponent(steerId!)}`, payload: { kind: "followUp" } });
    expect(back.statusCode).toBe(200);
    await vi.waitFor(() => expect(followUpSpy).toHaveBeenCalledWith("Later note"));
    const empty = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: unknown[]; followUp: unknown[] } }>();
    expect(empty.queue.steering).toHaveLength(0);
    expect(empty.queue.followUp).toHaveLength(0);
  });

  it("publishes queue.updated from Pi queue_update events and mirrors it in runtime", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "queue-update-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation((callback) => {
      listener = callback as unknown as typeof listener;
      return () => undefined;
    });
    const steering: string[] = [];
    const followUp: string[] = [];
    vi.spyOn(AgentSession.prototype, "getSteeringMessages").mockImplementation(() => steering);
    vi.spyOn(AgentSession.prototype, "getFollowUpMessages").mockImplementation(() => followUp);
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;

    steering.push("Steer now");
    followUp.push("Later note");
    listener?.({ type: "queue_update", steering: [...steering], followUp: [...followUp] });

    await vi.waitFor(async () => {
      const runtime = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: Array<{ kind: string; text: string }>; followUp: Array<{ kind: string; text: string }> } }>();
      expect(runtime.queue.steering).toHaveLength(1);
      expect(runtime.queue.steering[0]).toMatchObject({ kind: "steer", text: "Steer now" });
      expect(runtime.queue.followUp[0]).toMatchObject({ kind: "followUp", text: "Later note" });
    });

    // 投递后队列收缩：镜像同步更新。
    steering.splice(0, 1);
    listener?.({ type: "queue_update", steering: [], followUp: [...followUp] });
    await vi.waitFor(async () => {
      const runtime = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: unknown[]; followUp: unknown[] } }>();
      expect(runtime.queue.steering).toHaveLength(0);
      expect(runtime.queue.followUp).toHaveLength(1);
    });
  });

  it("keeps the run active while messages are queued and settles after delivery", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "queue-settle-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation((callback) => {
      listener = callback as unknown as typeof listener;
      return () => undefined;
    });
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    const steering: string[] = [];
    vi.spyOn(AgentSession.prototype, "getSteeringMessages").mockImplementation(() => steering);
    vi.spyOn(AgentSession.prototype, "getFollowUpMessages").mockImplementation(() => []);
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;

    const accepted = (await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Continue", clientRequestId: randomUUID() } })).json<{ runId: string }>();
    await vi.waitFor(() => expect(listener).toBeDefined());

    // 排队消息未投递完：agent_settled 不应结束 run。
    steering.push("Queued note");
    listener?.({ type: "queue_update", steering: [...steering], followUp: [] });
    listener?.({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
    listener?.({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stillRunning = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ status: { runState: string; activeRun?: { id: string } } }>();
    expect(stillRunning.status).toMatchObject({ runState: "running", activeRun: { id: accepted.runId } });

    // 投递完成（队列清空）后 agent_settled 结束 run。
    steering.splice(0, 1);
    listener?.({ type: "queue_update", steering: [], followUp: [] });
    listener?.({ type: "agent_settled" });
    await vi.waitFor(async () => {
      const settled = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ status: { runState: string } }>();
      expect(settled.status.runState).toBe("idle");
    });
  });

  it("dequeues all queued messages and re-queues the remainder on single removal", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "queue-dequeue-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation((callback) => {
      listener = callback as unknown as typeof listener;
      return () => undefined;
    });
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    const steering: string[] = ["First note", "Second note"];
    const followUp: string[] = ["Later note"];
    const steerSpy = vi.spyOn(AgentSession.prototype, "steer").mockResolvedValue(undefined);
    const followUpSpy = vi.spyOn(AgentSession.prototype, "followUp").mockResolvedValue(undefined);
    vi.spyOn(AgentSession.prototype, "getSteeringMessages").mockImplementation(() => steering);
    vi.spyOn(AgentSession.prototype, "getFollowUpMessages").mockImplementation(() => followUp);
    const clearQueueSpy = vi.spyOn(AgentSession.prototype, "clearQueue").mockImplementation(() => {
      const removed = { steering: [...steering], followUp: [...followUp] };
      steering.splice(0, steering.length);
      followUp.splice(0, followUp.length);
      return removed as never;
    });
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;
    await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Continue", clientRequestId: randomUUID() } });
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ type: "queue_update", steering: [...steering], followUp: [...followUp] });

    // 单条删除：第一条 steering 被移除，其余按原顺序重入队。
    const runtime = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: Array<{ id: string }>; followUp: unknown[] } }>();
    const removedId = runtime.queue.steering[0]?.id;
    expect(removedId).toBeDefined();
    const removal = await server.inject({ method: "DELETE", url: `${sessionUrl}/queue/${encodeURIComponent(removedId!)}` });
    expect(removal.statusCode).toBe(200);
    await vi.waitFor(() => expect(clearQueueSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(steerSpy).toHaveBeenCalledWith("Second note"));
    expect(steerSpy).not.toHaveBeenCalledWith("First note");
    expect(followUpSpy).toHaveBeenCalledWith("Later note");

    // 全部取回。
    steering.push("First note", "Second note");
    followUp.push("Later note");
    listener?.({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
    const dequeued = await server.inject({ method: "POST", url: `${sessionUrl}/queue/dequeue`, payload: {} });
    expect(dequeued.statusCode).toBe(200);
    expect(dequeued.json()).toMatchObject({ steering: [{ text: "First note" }, { text: "Second note" }], followUp: [{ text: "Later note" }] });
    await vi.waitFor(() => expect(clearQueueSpy).toHaveBeenCalledTimes(2));
    const empty = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: unknown[]; followUp: unknown[] } }>();
    expect(empty.queue.steering).toHaveLength(0);
    expect(empty.queue.followUp).toHaveLength(0);
  });
});

describe("abort with queued messages", () => {
  it("dequeues queued messages on abort and returns them for editor restore", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "abort-queue-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    let listener: ((event: { type: string; [key: string]: unknown }) => void) | undefined;
    vi.spyOn(AgentSession.prototype, "subscribe").mockImplementation((callback) => {
      listener = callback as unknown as typeof listener;
      return () => undefined;
    });
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    const steering: string[] = ["Queued note"];
    const followUp: string[] = ["Later note"];
    const abortSpy = vi.spyOn(AgentSession.prototype, "abort").mockResolvedValue(undefined);
    vi.spyOn(AgentSession.prototype, "getSteeringMessages").mockImplementation(() => steering);
    vi.spyOn(AgentSession.prototype, "getFollowUpMessages").mockImplementation(() => followUp);
    vi.spyOn(AgentSession.prototype, "clearQueue").mockImplementation(() => {
      const removed = { steering: [...steering], followUp: [...followUp] };
      steering.splice(0, steering.length);
      followUp.splice(0, followUp.length);
      return removed as never;
    });
    const session = (await server.inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })).json<{ session: { id: string } }>().session;
    const sessionUrl = `/api/workspaces/${workspace.id}/sessions/${session.id}`;
    const accepted = (await server.inject({ method: "POST", url: `${sessionUrl}/prompt`, payload: { text: "Continue", clientRequestId: randomUUID() } })).json<{ runId: string }>();
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ type: "queue_update", steering: [...steering], followUp: [...followUp] });

    const aborted = await server.inject({ method: "POST", url: `${sessionUrl}/abort`, payload: { runId: accepted.runId } });
    expect(aborted.statusCode).toBe(200);
    expect(aborted.json()).toMatchObject({
      aborted: true,
      dequeued: { steering: [{ text: "Queued note" }], followUp: [{ text: "Later note" }] },
    });
    await vi.waitFor(() => expect(abortSpy).toHaveBeenCalledTimes(1));
    const runtime = (await server.inject({ method: "GET", url: `${sessionUrl}/runtime` })).json<{ queue: { steering: unknown[]; followUp: unknown[] } }>();
    expect(runtime.queue.steering).toHaveLength(0);
    expect(runtime.queue.followUp).toHaveLength(0);
  });
});

describe("tunnel entries", () => {
  it("adds, lists, updates without auto-start, and removes tunnel entries", async () => {
    const server = activeApp();

    // 添加：默认不自动启动
    const created = await server.inject({ method: "POST", url: "/api/tunnel", payload: { method: "cloudflared", name: "演示" } });
    expect(created.statusCode).toBe(200);
    const tunnel = created.json<{ tunnel: { id: string; method: string; enabled: boolean; state: string } }>().tunnel;
    expect(tunnel.id).toBeTruthy();
    expect(tunnel.method).toBe("cloudflared");
    expect(tunnel.enabled).toBe(false);
    expect(tunnel.state).toBe("idle");

    // 列表
    const listed = await server.inject({ method: "GET", url: "/api/tunnel" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ tunnels: [{ id: tunnel.id, method: "cloudflared", enabled: false, name: "演示" }] });

    // 更新为 sish（配置服务器），仍不自动启动
    const updated = await server.inject({ method: "PUT", url: `/api/tunnel/${tunnel.id}`, payload: { method: "sish", enabled: false, sish: { server: "user@tun.example.com" } } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ tunnel: { method: "sish", enabled: false, state: "idle", sish: { server: "user@tun.example.com" } } });

    // 未知条目 → 404
    const missing = await server.inject({ method: "POST", url: "/api/tunnel/00000000-0000-4000-8000-000000000000/start", payload: {} });
    expect(missing.statusCode).toBe(404);

    // 删除
    const removed = await server.inject({ method: "DELETE", url: `/api/tunnel/${tunnel.id}` });
    expect(removed.statusCode).toBe(200);
    const after = await server.inject({ method: "GET", url: "/api/tunnel" });
    expect(after.json()).toEqual({ tunnels: [] });
  });

  it("migrates legacy single-tunnel config into an entry with auto-start off", async () => {
    await app?.close();
    await writeFile(join(jarvisHome, "tunnel.json"), JSON.stringify({ version: 1, enabled: true, method: "sish", port: 9528, sish: { server: "user@tun.example.com", subdomain: "jarvis" } }));
    app = await buildApp();
    await app.jarvis.tunnel.initialize(9528);
    const server = activeApp();

    const listed = await server.inject({ method: "GET", url: "/api/tunnel" });
    expect(listed.statusCode).toBe(200);
    const tunnels = listed.json<{ tunnels: Array<{ method: string; enabled: boolean; sish?: { server: string; subdomain: string } }> }>().tunnels;
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]).toMatchObject({ method: "sish", enabled: false, sish: { server: "user@tun.example.com", subdomain: "jarvis" } });

    // 已迁移为 v2 持久化
    const persisted = JSON.parse(await readFile(join(jarvisHome, "tunnel.json"), "utf8")) as { version: number; tunnels: unknown[] };
    expect(persisted.version).toBe(2);
    expect(persisted.tunnels).toHaveLength(1);
  });

  it("keeps the API open until a password is set, then requires the session cookie", async () => {
    const server = activeApp();

    // 未设置密码：认证未启用，一切照旧。
    expect((await server.inject({ method: "GET", url: "/api/workspaces" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/auth/status" })).json()).toMatchObject({ auth: { required: false, authenticated: true } });

    const configured = await server.inject({ method: "PUT", url: "/api/auth/password", payload: { newPassword: "jarvis-long-password" } });
    expect(configured.statusCode).toBe(200);
    const session = sessionCookie(configured);

    // 设置密码后：无 Cookie 一律 401，只有公开路由例外。
    const blocked = await server.inject({ method: "GET", url: "/api/workspaces" });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect((await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: jarvisHome } })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/api/auth/status" })).json()).toMatchObject({ auth: { required: true, authenticated: false } });

    // 登录：错误密码 401，正确密码换新 Cookie。
    expect((await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "not-the-password" } })).statusCode).toBe(401);
    const login = await server.inject({ method: "POST", url: "/api/auth/login", payload: { password: "jarvis-long-password" } });
    expect(login.statusCode).toBe(200);
    const cookie = sessionCookie(login);
    expect(cookie).toContain("jarvis_auth=");
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Lax");
    expect((await server.inject({ method: "GET", url: "/api/workspaces", headers: { cookie } })).statusCode).toBe(200);
    expect(cookie).not.toBe(session);

    // 磁盘上只存 scrypt 哈希。
    const stored = await readFile(join(jarvisHome, "auth.json"), "utf8");
    expect(stored).not.toContain("jarvis-long-password");
    expect(JSON.parse(stored)).toMatchObject({ version: 1, password: { hash: expect.any(String), salt: expect.any(String) } });
  });

  it("closes unauthenticated WebSocket upgrades with 4401", async () => {
    const server = activeApp();
    const configured = await server.inject({ method: "PUT", url: "/api/auth/password", payload: { newPassword: "socket-password-value" } });
    const cookie = sessionCookie(configured);
    const workspaces = (await server.inject({ method: "GET", url: "/api/workspaces", headers: { cookie } })).json<{ workspaces: Array<{ id: string }> }>().workspaces;
    const workspace = workspaces[0];
    if (workspace === undefined) throw new Error("Expected default workspace");
    const path = `/api/workspaces/${workspace.id}/events`;

    const anonymous = await server.injectWS(path);
    await expect(nextInjectSocketClose(anonymous)).resolves.toBe(4401);

    const authorized = await server.injectWS(path, { headers: { cookie } });
    const received = nextInjectSocketMessage(authorized);
    server.jarvis.events.publishWorkspace(workspace.id, {
      version: 1,
      type: "session.deleted",
      workspaceId: workspace.id,
      sessionId: "5f6c305e-d51a-447f-a62a-d0f4835c946f",
    });
    await expect(received).resolves.toMatchObject({ type: "session.deleted" });
    authorized.close();
  });

  it("keeps sessions across a restart and revokes them on password change", async () => {
    const server = activeApp();
    const configured = await server.inject({ method: "PUT", url: "/api/auth/password", payload: { newPassword: "first-password-value" } });
    const first = sessionCookie(configured);
    expect((await server.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: first } })).statusCode).toBe(200);

    // 重启后仍然有效：会话是 HMAC 签名 token，密钥持久化在 auth.json。
    await app?.close();
    app = await buildApp();
    const restarted = activeApp();
    expect((await restarted.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: first } })).statusCode).toBe(200);

    // 改密码必须提供当前密码，成功后所有旧会话失效。
    expect((await restarted.inject({ method: "PUT", url: "/api/auth/password", headers: { cookie: first }, payload: { newPassword: "second-password-value" } })).statusCode).toBe(401);
    const changed = await restarted.inject({ method: "PUT", url: "/api/auth/password", headers: { cookie: first }, payload: { currentPassword: "first-password-value", newPassword: "second-password-value" } });
    expect(changed.statusCode).toBe(200);
    const second = sessionCookie(changed);
    expect((await restarted.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: first } })).statusCode).toBe(401);
    expect((await restarted.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: second } })).statusCode).toBe(200);

    // 退出登录只清本机 Cookie；退出所有设备让全部会话失效。
    const loggedOut = await restarted.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: second }, payload: {} });
    expect(loggedOut.statusCode).toBe(200);
    expect(loggedOut.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await restarted.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: second } })).statusCode).toBe(200);

    const revoked = await restarted.inject({ method: "POST", url: "/api/auth/logout-all", headers: { cookie: second }, payload: {} });
    expect(revoked.statusCode).toBe(200);
    expect((await restarted.inject({ method: "GET", url: "/api/workspaces", headers: { cookie: second } })).statusCode).toBe(401);

    // 关闭认证（newPassword = null）需要当前密码；关闭后恢复开放访问。
    const loginAgain = await restarted.inject({ method: "POST", url: "/api/auth/login", payload: { password: "second-password-value" } });
    expect(loginAgain.statusCode).toBe(200);
    const third = sessionCookie(loginAgain);
    expect((await restarted.inject({ method: "PUT", url: "/api/auth/password", headers: { cookie: third }, payload: { currentPassword: "wrong-value", newPassword: null } })).statusCode).toBe(401);
    const cleared = await restarted.inject({ method: "PUT", url: "/api/auth/password", headers: { cookie: third }, payload: { currentPassword: "second-password-value", newPassword: null } });
    expect(cleared.statusCode).toBe(200);
    expect((await restarted.inject({ method: "GET", url: "/api/workspaces" })).statusCode).toBe(200);
    expect((await restarted.inject({ method: "GET", url: "/api/auth/status" })).json()).toMatchObject({ auth: { required: false, authenticated: true } });
  });
});
