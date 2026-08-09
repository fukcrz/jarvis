import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
let previousSessionDir: string | undefined;

beforeEach(async () => {
  previousJarvisHome = process.env["JARVIS_HOME"];
  previousSessionDir = process.env["PI_CODING_AGENT_SESSION_DIR"];
  jarvisHome = await mkdtemp(join(tmpdir(), "jarvis-app-test-"));
  sessionDir = join(jarvisHome, "sessions");
  process.env["JARVIS_HOME"] = jarvisHome;
  process.env["PI_CODING_AGENT_SESSION_DIR"] = sessionDir;
  app = await buildApp();
});

afterEach(async () => {
  await app?.close();
  if (previousJarvisHome === undefined) delete process.env["JARVIS_HOME"];
  else process.env["JARVIS_HOME"] = previousJarvisHome;
  if (previousSessionDir === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  else process.env["PI_CODING_AGENT_SESSION_DIR"] = previousSessionDir;
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

describe("Jarvis HTTP and WebSocket API", () => {
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
});
