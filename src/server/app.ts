import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { THINKING_LEVELS } from "../shared/protocol.js";
import type { ApiErrorBody, DirectoryListing, SessionRef, WorkspaceFile } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";
import { EventHub } from "./event-hub.js";
import { SessionService } from "./session-service.js";
import { WorkspaceStore } from "./workspace-store.js";
import { SettingsService } from "./settings-service.js";

const workspaceInput = z.object({ cwd: z.string().min(1), label: z.string().max(96).optional() }).strict();
const workspaceUpdateInput = z.object({ label: z.string().min(1).max(96) }).strict();
const workspaceOrderInput = z.object({ ids: z.array(z.string().uuid()).max(500) }).strict();
const directoryQuery = z.object({ path: z.string().min(1).optional(), roots: z.enum(["true"]).optional() }).strict();
const fileSearchQuery = z.object({ query: z.string().max(160).optional() }).strict();
const sessionNameInput = z.object({ name: z.string().min(1).max(120) }).strict();
const modelInput = z.object({ provider: z.string().min(1).max(160), modelId: z.string().min(1).max(320) }).strict();
const thinkingInput = z.object({ level: z.enum(THINKING_LEVELS) }).strict();
const imageInput = z.object({ mimeType: z.string().min(1).max(120), data: z.string().min(1) }).strict();
const promptInput = z.object({ text: z.string(), clientRequestId: z.string().uuid(), images: z.array(imageInput).max(8).optional(), behavior: z.enum(["steer", "followUp"]).optional() }).strict();
const messageActionInput = z.object({ messageId: z.string().min(1).max(200) }).strict();
const editAndResendInput = z.object({ messageId: z.string().min(1).max(200), text: z.string(), clientRequestId: z.string().uuid(), images: z.array(imageInput).max(8).optional() }).strict();
const compactInput = z.object({ customInstructions: z.string().max(40_000).optional(), clientRequestId: z.string().uuid().optional() }).strict();
const bashInput = z.object({ command: z.string().min(1).max(40_000), excludeFromContext: z.boolean().optional(), clientRequestId: z.string().uuid() }).strict();
const abortInput = z.object({ runId: z.string().uuid().optional() }).strict();
const settingsInput = z.object({ assistantName: z.string().min(1).max(64) }).strict();
const authLoginInput = z.object({ providerId: z.string().min(1).max(120), type: z.enum(["api_key", "oauth"]) }).strict();
const authResponseInput = z.object({ value: z.string().max(200_000) }).strict();
const managedModelInput = z.object({ id: z.string().min(1).max(320), name: z.string().max(160).optional(), reasoning: z.boolean(), vision: z.boolean(), contextWindow: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional() }).strict();
const managedProviderInput = z.object({ id: z.string().min(1).max(120), name: z.string().max(160).optional(), baseUrl: z.string().min(1).max(2_000), api: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]), authHeader: z.boolean(), models: z.array(managedModelInput).max(200) }).strict();
const extensionUiInput = z.object({
  id: z.string().uuid(),
  value: z.string().max(200_000).optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
}).strict();
const listQuery = z.object({ query: z.string().optional() });
const timelineQuery = z.object({ before: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().positive().max(500).optional() });
// /api/files：AI 通过 md 语法引用本地图片（相对路径以 cwd 为基准，绝对路径直接使用）。
// 只放行常见位图格式，防止该无鉴权接口被当作任意文件下载通道。
const fileQuery = z.object({ path: z.string().min(1).max(2000), cwd: z.string().min(1).max(2000).optional() }).strict();
const FILE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export interface JarvisServices {
  workspaces: WorkspaceStore;
  sessions: SessionService;
  events: EventHub;
}

export async function buildApp(options: { serveStatic?: boolean; staticRoot?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" }, bodyLimit: 25 * 1024 * 1024 });
  const production = process.env["NODE_ENV"] === "production";
  const workspaces = new WorkspaceStore();
  await workspaces.initialize(process.cwd());
  const events = new EventHub();
  const sessions = new SessionService(workspaces, events);
  const settings = new SettingsService(() => sessions.globalModelRuntime(), () => sessions.refreshModelConfiguration());
  await settings.initialize();
  const services: JarvisServices = { workspaces, sessions, events };

  await app.register(cors, { origin: production ? [/^http:\/\/127\.0\.0\.1(?::\d+)?$/, /^http:\/\/localhost(?::\d+)?$/] : true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(websocket);

  app.decorate("jarvis", services);
  app.addHook("onClose", async () => { await sessions.dispose(); });

  app.get("/api/health", async () => ({ ok: true, version: 1 }));
  app.get("/api/settings", async () => ({ settings: settings.getSettings() }));
  app.patch("/api/settings", async (request) => ({ settings: await settings.updateSettings(settingsInput.parse(request.body)) }));
  app.get("/api/settings/providers", async () => ({ providers: await settings.providers() }));
  app.get("/api/settings/custom-providers", async () => ({ providers: await settings.customProviders() }));
  app.put("/api/settings/custom-providers/:providerId", async (request) => {
    const params = z.object({ providerId: z.string().min(1).max(120) }).parse(request.params);
    const body = managedProviderInput.omit({ id: true }).parse(request.body);
    const provider = managedProviderInput.parse({ ...body, id: params.providerId });
    return { provider: await settings.saveCustomProvider(provider) };
  });
  app.delete("/api/settings/custom-providers/:providerId", async (request) => {
    const params = z.object({ providerId: z.string().min(1).max(120) }).parse(request.params);
    await settings.removeCustomProvider(params.providerId);
    return { removed: true };
  });
  app.post("/api/settings/auth/login", async (request) => {
    const input = authLoginInput.parse(request.body);
    return { operation: await settings.startLogin(input.providerId, input.type) };
  });
  app.get("/api/settings/auth/:operationId", async (request) => ({ operation: settings.loginStatus(z.object({ operationId: z.string().uuid() }).parse(request.params).operationId) }));
  app.post("/api/settings/auth/:operationId/respond", async (request) => ({ operation: settings.respondToLogin(z.object({ operationId: z.string().uuid() }).parse(request.params).operationId, authResponseInput.parse(request.body).value) }));
  app.post("/api/settings/auth/:operationId/cancel", async (request) => ({ operation: settings.cancelLogin(z.object({ operationId: z.string().uuid() }).parse(request.params).operationId) }));
  app.post("/api/settings/auth/:providerId/logout", async (request) => { await settings.logout(z.object({ providerId: z.string().min(1).max(120) }).parse(request.params).providerId); return { loggedOut: true }; });

  app.get("/api/directories", async (request) => {
    const query = directoryQuery.parse(request.query);
    return { directory: query.roots === "true" ? await listRoots() : await listDirectory(query.path ?? process.cwd()) };
  });

  // 本地图片服务：AI 在回复里写 ![](path) 引用工作区内相对路径或机器绝对路径的图片，
  // 前端重写为 /api/files?path=...&cwd=...，这里读取文件并返回图片内容。
  app.get("/api/files", async (request, reply) => {
    const query = fileQuery.parse(request.query);
    const candidate = query.path.startsWith("/")
      ? query.path
      : resolve(query.cwd ?? process.cwd(), query.path);
    const ext = extname(candidate).toLowerCase();
    if (!(ext in FILE_MIME_TYPES)) throw new AppError("FILE_TYPE_UNSUPPORTED", "Only image files can be served", 400);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      throw new AppError("FILE_NOT_FOUND", "File not found", 404);
    }
    const metadata = await stat(resolved).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile()) throw new AppError("FILE_NOT_FOUND", "File not found", 404);
    const data = await readFile(resolved);
    return reply
      .type(FILE_MIME_TYPES[ext] ?? "application/octet-stream")
      .header("cache-control", "private, max-age=3600")
      .send(data);
  });

  app.get("/api/workspaces", async () => ({ workspaces: workspaces.list() }));
  app.post("/api/workspaces", async (request) => {
    const body = workspaceInput.parse(request.body);
    return { workspace: await workspaces.add(body.cwd, body.label) };
  });
  app.patch("/api/workspaces/:workspaceId", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = workspaceUpdateInput.parse(request.body);
    return { workspace: await workspaces.updateLabel(params.workspaceId, body.label) };
  });
  app.put("/api/workspaces/order", async (request) => ({ workspaces: await workspaces.reorder(workspaceOrderInput.parse(request.body).ids) }));
  app.post("/api/workspaces/:workspaceId/open", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    return { workspace: await workspaces.touch(params.workspaceId) };
  });
  app.delete("/api/workspaces/:workspaceId", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    if (sessions.hasActiveWorkspace(params.workspaceId)) throw new AppError("WORKSPACE_BUSY", "Stop running sessions before removing this workspace", 409);
    await sessions.disposeWorkspace(params.workspaceId);
    await workspaces.remove(params.workspaceId);
    return { removed: true };
  });

  app.get("/api/workspaces/:workspaceId/sessions", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const query = listQuery.parse(request.query);
    return { sessions: await sessions.list(params.workspaceId, query.query) };
  });
  app.post("/api/workspaces/:workspaceId/sessions", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    return { session: await sessions.create(params.workspaceId) };
  });
  app.patch("/api/workspaces/:workspaceId/sessions/:sessionId", async (request) => {
    const ref = sessionRef(request.params);
    const body = sessionNameInput.parse(request.body);
    return { session: await sessions.rename(ref, body.name) };
  });
  app.delete("/api/workspaces/:workspaceId/sessions/:sessionId", async (request) => {
    await sessions.remove(sessionRef(request.params));
    return { removed: true };
  });

  app.get("/api/workspaces/:workspaceId/session-files", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const query = fileSearchQuery.parse(request.query);
    return { sessions: await sessions.fileReferences(params.workspaceId, query.query ?? "") };
  });

  app.get("/api/workspaces/:workspaceId/files", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const query = fileSearchQuery.parse(request.query);
    const workspace = workspaces.get(params.workspaceId);
    return { files: await searchWorkspaceFiles(workspace.cwd, query.query ?? "") };
  });
  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/commands", async (request) => ({ commands: await sessions.commands(sessionRef(request.params)) }));

  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/timeline", async (request) => {
    const ref = sessionRef(request.params);
    const query = timelineQuery.parse(request.query);
    return sessions.timeline(ref, query.before, query.limit);
  });
  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/runtime", async (request) => sessions.runtime(sessionRef(request.params)));
  app.put("/api/workspaces/:workspaceId/sessions/:sessionId/model", async (request) => {
    const ref = sessionRef(request.params);
    const body = modelInput.parse(request.body);
    return { model: await sessions.setModel(ref, body.provider, body.modelId) };
  });
  app.put("/api/workspaces/:workspaceId/sessions/:sessionId/thinking", async (request) => {
    const ref = sessionRef(request.params);
    const body = thinkingInput.parse(request.body);
    return { thinking: await sessions.setThinkingLevel(ref, body.level) };
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/prompt", async (request) => {
    const ref = sessionRef(request.params);
    const body = promptInput.parse(request.body);
    return sessions.prompt(ref, body.text, body.clientRequestId, body.images, body.behavior);
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/queue/dequeue", async (request) => {
    const ref = sessionRef(request.params);
    return sessions.dequeueQueue(ref);
  });
  app.delete("/api/workspaces/:workspaceId/sessions/:sessionId/queue/:messageId", async (request) => {
    const ref = sessionRef(request.params);
    const params = z.object({ messageId: z.string().min(1).max(300) }).parse(request.params);
    const removed = await sessions.removeQueued(ref, params.messageId);
    return { removed };
  });
  const queuedKindInput = z.object({ kind: z.enum(["steer", "followUp"]) }).strict();
  app.patch("/api/workspaces/:workspaceId/sessions/:sessionId/queue/:messageId", async (request) => {
    const ref = sessionRef(request.params);
    const params = z.object({ messageId: z.string().min(1).max(300) }).parse(request.params);
    const body = queuedKindInput.parse(request.body);
    const updated = await sessions.setQueuedKind(ref, params.messageId, body.kind);
    return { updated };
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/fork", async (request) => {
    const ref = sessionRef(request.params);
    const body = messageActionInput.parse(request.body);
    return { session: await sessions.fork(ref, body.messageId) };
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/edit-and-resend", async (request) => {
    const ref = sessionRef(request.params);
    const body = editAndResendInput.parse(request.body);
    return sessions.editAndResend(ref, body.messageId, body.text, body.clientRequestId, body.images);
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/compact", async (request) => {
    const ref = sessionRef(request.params);
    const body = compactInput.parse(request.body);
    return sessions.compact(ref, body.customInstructions, body.clientRequestId);
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/bash", async (request) => {
    const ref = sessionRef(request.params);
    const body = bashInput.parse(request.body);
    return sessions.bash(ref, body.command, body.excludeFromContext === true, body.clientRequestId);
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/abort", async (request) => {
    const ref = sessionRef(request.params);
    const body = abortInput.parse(request.body);
    return sessions.abort(ref, body.runId);
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/extension-ui", async (request) => {
    const ref = sessionRef(request.params);
    const body = extensionUiInput.parse(request.body);
    await sessions.resolveExtensionUi(ref, body.id, body);
    return { resolved: true };
  });

  app.get("/api/workspaces/:workspaceId/events", { websocket: true }, (socket, request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return socket.close(1008, "Invalid workspace id");
    events.addWorkspace(params.data.workspaceId, socket);
  });
  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/events", { websocket: true }, (socket, request) => {
    const parsed = safeSessionRef(request.params);
    if (parsed === undefined) return socket.close(1008, "Invalid session ref");
    events.addSession(parsed, socket);
  });

  if (options.serveStatic === true) {
    const staticRoot = options.staticRoot ?? resolve(process.cwd(), "dist/client");
    // Keep sendFile rooted at the build directory for the SPA fallback.
    await app.register(fastifyStatic, { root: staticRoot, serve: false });
    // Vite puts hashed bundles in a nested assets directory. Serving this
    // prefix separately prevents those requests from falling through to HTML.
    await app.register(fastifyStatic, { root: join(staticRoot, "assets"), prefix: "/assets/", decorateReply: false });
    app.get("/*", async (request, reply) => {
      if (request.url === "/api" || request.url.startsWith("/api/")) {
        const response: ApiErrorBody = { error: { code: "NOT_FOUND", message: "Route not found", requestId: request.id } };
        return reply.status(404).send(response);
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof AppError ? error : undefined;
    const frameworkStatus = errorStatusCode(error);
    const statusCode = appError?.statusCode ?? (error instanceof z.ZodError ? 400 : frameworkStatus ?? 500);
    const isClientError = statusCode >= 400 && statusCode < 500;
    const message = appError?.message ?? (isClientError ? "Invalid request" : "Unexpected server error");
    const code = appError?.code ?? (isClientError ? "INVALID_REQUEST" : "INTERNAL_ERROR");
    if (statusCode >= 500) request.log.error(error);
    const response: ApiErrorBody = { error: { code, message, requestId: request.id } };
    reply.status(statusCode).send(response);
  });

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    jarvis: JarvisServices;
  }
}

async function listRoots(): Promise<DirectoryListing> {
  if (platform() !== "win32") return listDirectory("/");
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const entries = (await Promise.all(candidates.map(async (path) => {
    try {
      const metadata = await stat(path);
      return metadata.isDirectory() ? { name: path, path } : undefined;
    } catch {
      return undefined;
    }
  }))).filter((entry): entry is { name: string; path: string } => entry !== undefined);
  return { path: "", name: "Drives", entries, isGitRepository: false, isRootPicker: true };
}

async function listDirectory(value: string): Promise<DirectoryListing> {
  try {
    const path = await realpath(value);
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new AppError("DIRECTORY_INVALID", "Path must be a directory", 400);
    const entries = await readdir(path, { withFileTypes: true });
    const directoryEntries = entries
      .filter((entry) => entry.isDirectory() && entry.name !== "." && entry.name !== "..")
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parentPath = dirname(path);
    return {
      path,
      name: basename(path) || path,
      parent: parentPath === path ? undefined : parentPath,
      entries: directoryEntries,
      isGitRepository: await pathExists(join(path, ".git")),
      isRootPicker: false,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("DIRECTORY_UNAVAILABLE", `Directory is unavailable: ${value}`, 400);
  }
}

const IGNORED_SEARCH_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".next"]);
const MAX_FILE_SEARCH_RESULTS = 80;
const MAX_FILE_SEARCH_DEPTH = 14;

async function searchWorkspaceFiles(cwd: string, query: string): Promise<WorkspaceFile[]> {
  const normalizedQuery = query.trim().replaceAll("\\", "/").toLocaleLowerCase();
  const matches: Array<{ path: string; score: number }> = [];

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (matches.length >= MAX_FILE_SEARCH_RESULTS || depth > MAX_FILE_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_FILE_SEARCH_RESULTS) return;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SEARCH_DIRECTORIES.has(entry.name)) await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(cwd, absolutePath).replaceAll("\\", "/");
      const score = fileMatchScore(path.toLocaleLowerCase(), normalizedQuery);
      if (score !== undefined) matches.push({ path, score });
    }
  };

  await visit(cwd, 0);
  return matches.sort((left, right) => left.score - right.score || left.path.localeCompare(right.path)).map(({ path }) => ({ path }));
}

function fileMatchScore(path: string, query: string): number | undefined {
  if (query === "") return path.split("/").length * 100 + path.length;
  const basenameIndex = path.lastIndexOf("/") + 1;
  const fileName = path.slice(basenameIndex);
  if (fileName.startsWith(query)) return path.length;
  const pathIndex = path.indexOf(query);
  if (pathIndex >= 0) return 1_000 + pathIndex * 10 + path.length;
  let queryIndex = 0;
  for (const character of path) if (character === query[queryIndex]) queryIndex += 1;
  return queryIndex === query.length ? 10_000 + path.length : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sessionRef(value: unknown): SessionRef {
  const parsed = z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid() }).parse(value);
  return parsed;
}

function safeSessionRef(value: unknown): SessionRef | undefined {
  const parsed = z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid() }).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)["statusCode"];
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

export function errorBody(error: unknown): ApiErrorBody {
  const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", asMessage(error), 500);
  return { error: { code: appError.code, message: appError.message } };
}
