import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
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
    const workspace = created.json() as { workspace: { id: string; cwd: string; label: string } };
    expect(workspace.workspace).toMatchObject({ cwd: workspacePath, label: "Scratch" });

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

    await activeApp().close();
    app = await buildApp({ serveStatic: true, staticRoot });
    const server = activeApp();

    const asset = await server.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("window.jarvis = true;");

    const fallback = await server.inject({ method: "GET", url: "/sessions/example" });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toBe("<main>Jarvis shell</main>");

    const missingApi = await server.inject({ method: "GET", url: "/api/not-a-route" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "Route not found" } });
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

  it("rejects Fork and edit while the session is running", async () => {
    const server = activeApp();
    const workspacePath = join(jarvisHome, "message-action-busy-workspace");
    await mkdir(workspacePath);
    const workspace = (await server.inject({ method: "POST", url: "/api/workspaces", payload: { cwd: workspacePath } })).json<{ workspace: { id: string } }>().workspace;
    const source = await writeConversationSession(workspacePath);
    const baseUrl = `/api/workspaces/${workspace.id}/sessions/${source.id}`;
    vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(() => new Promise(() => undefined) as never);
    await server.inject({ method: "POST", url: `${baseUrl}/prompt`, payload: { text: "Keep running", clientRequestId: randomUUID() } });

    const fork = await server.inject({ method: "POST", url: `${baseUrl}/fork`, payload: { messageId: source.user1 } });
    const edit = await server.inject({ method: "POST", url: `${baseUrl}/edit-and-resend`, payload: { messageId: source.user1, text: "Edited", clientRequestId: randomUUID() } });
    expect(fork.statusCode).toBe(409);
    expect(edit.statusCode).toBe(409);
    expect(fork.json()).toMatchObject({ error: { code: "SESSION_BUSY" } });
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
