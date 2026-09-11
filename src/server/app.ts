import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { THINKING_LEVELS, TUNNEL_METHODS } from "../shared/protocol.js";
import type { ApiErrorBody, DirectoryListing, SessionRef, WorkspaceDirectoryListing, WorkspaceFile, WorkspaceFileContent } from "../shared/protocol.js";
import { AUTH_COOKIE_NAME, AuthService, SESSION_TTL_MS } from "./auth-service.js";
import { AppError, asMessage } from "./errors.js";
import { EventHub } from "./event-hub.js";
import { SessionService } from "./session-service.js";
import { registerSelfRestart } from "./self-restart.js";
import { WorkspaceStore } from "./workspace-store.js";
import { SettingsService } from "./settings-service.js";
import { TunnelService } from "./tunnel-service.js";

const workspaceInput = z.object({ cwd: z.string().min(1), label: z.string().max(96).optional() }).strict();
const workspaceUpdateInput = z.object({ label: z.string().min(1).max(96) }).strict();
const workspaceOrderInput = z.object({ ids: z.array(z.string().uuid()).max(500) }).strict();
const directoryQuery = z.object({ path: z.string().min(1).optional(), roots: z.enum(["true"]).optional() }).strict();
const fileSearchQuery = z.object({ query: z.string().max(160).optional() }).strict();
const workspacePathQuery = z.object({ path: z.string().max(2000).optional() }).strict();
const workspaceEntryQuery = z.object({ path: z.string().min(1).max(2000) }).strict();
const sessionNameInput = z.object({ name: z.string().min(1).max(120) }).strict();
const modelInput = z.object({ provider: z.string().min(1).max(160), modelId: z.string().min(1).max(320) }).strict();
const thinkingInput = z.object({ level: z.enum(THINKING_LEVELS) }).strict();
const imageInput = z.object({ mimeType: z.string().min(1).max(120), data: z.string().min(1) }).strict();
const promptInput = z.object({ text: z.string(), clientRequestId: z.string().uuid(), images: z.array(imageInput).max(8).optional(), behavior: z.enum(["steer", "followUp"]).optional() }).strict();
const messageActionInput = z.object({ messageId: z.string().min(1).max(200).optional() }).strict();
const editAndResendInput = z.object({ messageId: z.string().min(1).max(200), text: z.string(), clientRequestId: z.string().uuid(), images: z.array(imageInput).max(8).optional() }).strict();
const compactInput = z.object({ customInstructions: z.string().max(40_000).optional(), clientRequestId: z.string().uuid().optional() }).strict();
const bashInput = z.object({ command: z.string().min(1).max(40_000), excludeFromContext: z.boolean().optional(), clientRequestId: z.string().uuid() }).strict();
const abortInput = z.object({ runId: z.string().uuid().optional() }).strict();
const settingsInput = z.object({ assistantName: z.string().min(1).max(64) }).strict();
const authLoginInput = z.object({ providerId: z.string().min(1).max(120), type: z.enum(["api_key", "oauth"]) }).strict();
const loginInput = z.object({ password: z.string().min(1).max(200) }).strict();
const passwordInput = z.object({ currentPassword: z.string().max(200).optional(), newPassword: z.string().max(200).nullable() }).strict();
const authResponseInput = z.object({ value: z.string().max(200_000) }).strict();
const enabledModelRefInput = z.object({ provider: z.string().min(1).max(120), id: z.string().min(1).max(320) }).strict();
const enabledModelsInput = z.object({ models: z.array(enabledModelRefInput).max(5_000) }).strict();
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
// /api/files：通用本地文件接口。
// AI 通过 md 语法引用本地图片（相对路径以 cwd 为基准，绝对路径直接使用），
// 文件浏览器用它内联预览图片/PDF/音视频，并带 download=1 下载任意文件。
const fileQuery = z.object({ path: z.string().min(1).max(2000), cwd: z.string().min(1).max(2000).optional(), download: z.enum(["1", "true"]).optional(), text: z.enum(["1", "true", "check"]).optional() }).strict();
const FILE_MIME_TYPES: Record<string, string> = {
  // 图片
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  // 文档
  ".pdf": "application/pdf",
  // 文本
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/toml; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  // 音频
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  // 视频
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  // 字体
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  // 压缩包
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  // Office
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
};

export interface JarvisServices {
  workspaces: WorkspaceStore;
  sessions: SessionService;
  events: EventHub;
  tunnel: TunnelService;
  auth: AuthService;
}

export async function buildApp(options: { serveStatic?: boolean; staticRoot?: string; initialWorkspaceCwd?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" }, bodyLimit: 25 * 1024 * 1024 });
  const production = process.env["NODE_ENV"] === "production";
  const workspaces = new WorkspaceStore();
  await workspaces.initialize(options.initialWorkspaceCwd ?? process.cwd());
  const events = new EventHub();
  const sessions = new SessionService(workspaces, events);
  const settings = new SettingsService(() => sessions.globalModelRuntime(), () => sessions.refreshModelConfiguration());
  await settings.initialize();
  const auth = new AuthService();
  await auth.initialize();
  const services: JarvisServices = { workspaces, sessions, events, tunnel: new TunnelService((message) => app.log.info({ tunnel: message })), auth };

  await app.register(cors, { origin: production ? [/^http:\/\/127\.0\.0\.1(?::\d+)?$/, /^http:\/\/localhost(?::\d+)?$/] : true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(websocket);

  app.decorate("jarvis", services);
  app.addHook("onClose", async () => { await sessions.dispose(); await services.tunnel.dispose(); });

  // 登录认证（仅在设置了密码时生效）：
  // - 静态资源与 SPA 页面放行，否则登录页自身无法加载；
  // - /api/auth/status、/api/auth/login、/api/health 放行；
  // - WebSocket 由各自 handler 校验，才能用 close(4401) 通知客户端已登出；
  // - 一律不区分来源地址：穿透（frp/cloudflared/sish）都从 127.0.0.1 连入，
  //   对回环地址免登录等于给公网流量开后门。
  const publicApiPaths = new Set(["/api/auth/status", "/api/auth/login", "/api/health"]);
  app.addHook("onRequest", async (request, reply) => {
    if (!auth.enabled()) return;
    if (request.headers.upgrade?.toLowerCase() === "websocket") return;
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || publicApiPaths.has(path)) return;
    const state = auth.verifyToken(readAuthCookie(request.headers.cookie));
    if (state.state === "invalid") {
      const response: ApiErrorBody = { error: { code: "UNAUTHENTICATED", message: "请先登录", requestId: request.id } };
      await reply.status(401).send(response);
      return;
    }
    if (state.token !== undefined) applyAuthCookie(reply, state.token, request);
  });

  app.get("/api/health", async () => ({ ok: true, version: 1 }));

  app.get("/api/auth/status", async (request) => ({ auth: auth.status(readAuthCookie(request.headers.cookie)), assistantName: settings.getSettings().assistantName }));
  app.post("/api/auth/login", async (request, reply) => {
    const body = loginInput.parse(request.body);
    const outcome = await auth.login(body.password, request.ip);
    if (!outcome.ok) {
      if (outcome.reason === "locked") {
        const seconds = Math.ceil(outcome.retryAfterMs / 1_000);
        reply.header("retry-after", String(seconds));
        throw new AppError("AUTH_LOCKED", `密码错误次数过多，请 ${String(seconds)} 秒后重试`, 429);
      }
      throw new AppError("AUTH_INVALID_PASSWORD", "密码不正确", 401);
    }
    applyAuthCookie(reply, outcome.session.token, request);
    return { auth: { required: auth.enabled(), authenticated: true } };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    clearAuthCookie(reply);
    return { auth: auth.status(undefined) };
  });
  app.post("/api/auth/logout-all", async (request, reply) => {
    await auth.revokeAllSessions();
    clearAuthCookie(reply);
    return { auth: auth.status(undefined) };
  });
  app.put("/api/auth/password", async (request, reply) => {
    const body = passwordInput.parse(request.body);
    const result = await auth.setPassword(body.newPassword, body.currentPassword);
    if (result.token === undefined) clearAuthCookie(reply);
    else applyAuthCookie(reply, result.token, request);
    return { auth: auth.status(result.token) };
  });

  registerSelfRestart(app, events);

  const tunnelMethodInput = z.enum(TUNNEL_METHODS);
  const tunnelSishInput = z.object({ server: z.string().min(1).max(500), subdomain: z.string().max(200).optional(), sshPort: z.number().int().min(1).max(65535).optional() }).strict();
  const tunnelFrpInput = z.object({ server: z.string().min(1).max(500), token: z.string().max(2_000).optional(), remotePort: z.number().int().min(1).max(65535).optional(), domain: z.string().max(300).optional() }).strict();
  const tunnelEntryInput = z.object({
    name: z.string().max(60).optional(),
    method: tunnelMethodInput,
    enabled: z.boolean().optional(),
    sish: tunnelSishInput.optional(),
    frp: tunnelFrpInput.optional(),
  }).strict();
  // 内网穿透：多条目（cloudflared/sish/frp），各自独立启停，自动启动为条目级开关（默认关闭）。
  app.get("/api/tunnel", async () => ({ tunnels: services.tunnel.listTunnels() }));
  app.post("/api/tunnel", async (request) => ({ tunnel: await services.tunnel.addTunnel(tunnelEntryInput.parse(request.body)) }));
  app.put("/api/tunnel/:tunnelId", async (request) => {
    const { tunnelId } = z.object({ tunnelId: z.string().uuid() }).parse(request.params);
    return { tunnel: await services.tunnel.updateTunnel(tunnelId, tunnelEntryInput.parse(request.body)) };
  });
  app.post("/api/tunnel/:tunnelId/start", async (request) => {
    const { tunnelId } = z.object({ tunnelId: z.string().uuid() }).parse(request.params);
    return { tunnel: await services.tunnel.startTunnel(tunnelId) };
  });
  app.post("/api/tunnel/:tunnelId/stop", async (request) => {
    const { tunnelId } = z.object({ tunnelId: z.string().uuid() }).parse(request.params);
    return { tunnel: await services.tunnel.stopTunnel(tunnelId) };
  });
  app.delete("/api/tunnel/:tunnelId", async (request) => {
    const { tunnelId } = z.object({ tunnelId: z.string().uuid() }).parse(request.params);
    await services.tunnel.removeTunnel(tunnelId);
    return { removed: true };
  });
  app.get("/api/settings", async () => ({ settings: settings.getSettings() }));
  app.patch("/api/settings", async (request) => ({ settings: await settings.updateSettings(settingsInput.parse(request.body)) }));
  app.get("/api/settings/providers", async () => ({ providers: await settings.providers() }));
  app.get("/api/settings/enabled-models", async () => ({ enabledModels: await settings.enabledModels() }));
  app.put("/api/settings/enabled-models", async (request) => ({ enabledModels: await settings.updateEnabledModels(enabledModelsInput.parse(request.body).models) }));
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
  app.post("/api/settings/providers/:providerId/fetch-models", async (request) => {
    const providerId = z.object({ providerId: z.string().min(1).max(120) }).parse(request.params).providerId;
    return { models: await settings.fetchProviderModels(providerId) };
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

  // 通用文件服务：AI 在回复里写 ![](path) 引用本地图片（相对路径以 cwd 为基准），
  // 前端重写为 /api/files?path=...&cwd=...；文件浏览器也用它预览媒体与下载文件。
  app.get("/api/files", async (request, reply) => {
    const query = fileQuery.parse(request.query);
    const resolved = await resolveFileRequestPath(workspaces, query.path, query.cwd);
    const metadata = await stat(resolved).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile()) throw new AppError("FILE_NOT_FOUND", "File not found", 404);
    if (query.text !== undefined) return { file: await readTextFile(resolved, metadata, query.text !== "check") };
    const ext = extname(resolved).toLowerCase();
    if (query.download !== undefined) {
      const name = basename(resolved);
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      reply.header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    // 流式返回 + Range：视频/音频需要 206 才能拖进度，也避免大文件一次性读进内存。
    const size = metadata.size;
    reply
      .type(fileResponseMimeType(ext))
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=3600")
      .header("accept-ranges", "bytes");
    if (ext === ".svg") {
      reply.header("content-security-policy", "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const range = parseByteRange(request.headers.range, size);
    if (range === "unsatisfiable") {
      return reply.code(416).header("content-range", `bytes */${String(size)}`).send();
    }
    if (range === undefined) {
      return reply.header("content-length", String(size)).send(createReadStream(resolved));
    }
    return reply
      .code(206)
      .header("content-range", `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`)
      .header("content-length", String(range.end - range.start + 1))
      .send(createReadStream(resolved, { start: range.start, end: range.end }));
  });

  app.get("/api/workspaces", async () => ({ workspaces: workspaces.list() }));
  app.post("/api/workspaces", async (request) => {
    const body = workspaceInput.parse(request.body);
    // An unauthenticated request may organize a registered root into nested
    // workspaces, but cannot turn an arbitrary filesystem parent into a new
    // /api/files allowlist root. IP addresses are deliberately not trusted:
    // every tunnel forwards to this process from loopback.
    if (!auth.enabled() && !(await isInsideRegisteredWorkspaceRoot(workspaces, body.cwd))) {
      throw new AppError("WORKSPACE_AUTH_REQUIRED", "Set a password before adding a workspace outside the registered roots", 403);
    }
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
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/viewed", async (request) => ({ session: await sessions.markViewed(sessionRef(request.params)) }));
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
  app.get("/api/workspaces/:workspaceId/directory", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const query = workspacePathQuery.parse(request.query);
    const workspace = workspaces.get(params.workspaceId);
    return { directory: await listWorkspaceDirectory(workspace.cwd, query.path ?? "") };
  });
  app.get("/api/workspaces/:workspaceId/file", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const query = z.object({ path: z.string().min(1).max(2000) }).strict().parse(request.query);
    const workspace = workspaces.get(params.workspaceId);
    return { file: await readWorkspaceFile(workspace.cwd, query.path) };
  });
  app.delete("/api/workspaces/:workspaceId/entry", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const query = workspaceEntryQuery.parse(request.query);
    const workspace = workspaces.get(params.workspaceId);
    await removeWorkspaceEntry(workspace.cwd, query.path);
    return { removed: true };
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
    if (!authorizeSocket(auth, request, socket)) return;
    const params = z.object({ workspaceId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return socket.close(1008, "Invalid workspace id");
    events.addWorkspace(params.data.workspaceId, socket);
  });
  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/events", { websocket: true }, (socket, request) => {
    if (!authorizeSocket(auth, request, socket)) return;
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
    const message = appError?.message ?? (error instanceof z.ZodError ? formatValidationError(error) : isClientError ? "Invalid request" : "Unexpected server error");
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
const MAX_BROWSER_FILE_BYTES = 512 * 1024;
const MAX_TEXT_FILE_BYTES = MAX_BROWSER_FILE_BYTES * 8;

async function listWorkspaceDirectory(cwd: string, requestedPath: string): Promise<WorkspaceDirectoryListing> {
  const root = await realpath(cwd).catch(() => { throw new AppError("WORKSPACE_UNAVAILABLE", "Workspace is unavailable", 404); });
  const directory = await resolveWorkspacePath(root, requestedPath, "DIRECTORY_UNAVAILABLE");
  const metadata = await stat(directory).catch(() => undefined);
  if (metadata === undefined || !metadata.isDirectory()) throw new AppError("DIRECTORY_INVALID", "Path must be a directory", 400);
  const entries = await readdir(directory, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !(entry.isDirectory() && IGNORED_SEARCH_DIRECTORIES.has(entry.name)))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({ name: entry.name, path: relative(root, join(directory, entry.name)).replaceAll("\\", "/"), kind: entry.isDirectory() ? "directory" as const : "file" as const }))
    .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name));
  const relativePath = relative(root, directory).replaceAll("\\", "/");
  const parent = relativePath === "" ? undefined : relative(root, dirname(directory)).replaceAll("\\", "/");
  return { path: relativePath, name: basename(directory) || root, ...(parent === undefined ? {} : { parent }), entries: visible, isGitRepository: await pathExists(join(directory, ".git")) };
}

async function removeWorkspaceEntry(cwd: string, requestedPath: string): Promise<void> {
  const root = await realpath(cwd).catch(() => { throw new AppError("WORKSPACE_UNAVAILABLE", "Workspace is unavailable", 404); });
  const normalized = requestedPath.replaceAll("\\", "/");
  if (normalized === "" || normalized.startsWith("/") || isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) {
    throw new AppError("FILE_DELETE_INVALID", "Path is outside the workspace", 400);
  }
  const candidate = resolve(root, normalized);
  const parent = await realpath(dirname(candidate)).catch(() => { throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404); });
  if (!isPathInside(root, parent)) throw new AppError("FILE_DELETE_INVALID", "Path is outside the workspace", 400);
  const metadata = await lstat(candidate).catch(() => undefined);
  if (metadata === undefined) throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404);
  if (metadata.isSymbolicLink()) throw new AppError("FILE_DELETE_INVALID", "Symbolic links cannot be deleted from the file browser", 400);
  if (!metadata.isFile() && !metadata.isDirectory()) throw new AppError("FILE_DELETE_INVALID", "Only files and directories can be deleted", 400);
  const resolved = await realpath(candidate).catch(() => { throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404); });
  if (!isPathInside(root, resolved) || resolved === root) throw new AppError("FILE_DELETE_INVALID", "Path is outside the workspace", 400);
  try {
    await rm(candidate, { recursive: metadata.isDirectory(), force: false });
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404);
    throw new AppError("FILE_DELETE_FAILED", "Unable to delete file or directory", 500);
  }
}

/**
 * 解析单段 Range 头（`bytes=start-end` / `bytes=start-` / `bytes=-suffix`）。
 * 返回 undefined 表示按整档返回（无头、或浏览器极少发的多段 Range）；
 * 返回 "unsatisfiable" 表示范围超出文件，调用方应回 416。
 */
function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value?.trim() ?? "");
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (size === 0) return "unsatisfiable";
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (rawEnd === "" || suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== ".." && !relativePath.startsWith(`..${String.fromCharCode(47)}`) && !relativePath.startsWith(`..${String.fromCharCode(92)}`) && !isAbsolute(relativePath);
}

async function registeredWorkspaceRoots(workspaces: WorkspaceStore): Promise<string[]> {
  const roots: string[] = [];
  for (const workspace of workspaces.list()) {
    const root = await realpath(workspace.cwd).catch(() => undefined);
    if (root !== undefined && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

async function isInsideRegisteredWorkspaceRoot(workspaces: WorkspaceStore, directory: string): Promise<boolean> {
  const candidate = await realpath(directory).catch(() => undefined);
  if (candidate === undefined) return true; // Let WorkspaceStore return its existing validation error.
  const roots = await registeredWorkspaceRoots(workspaces);
  return roots.some((root) => isPathInside(root, candidate));
}

async function resolveFileRequestPath(workspaces: WorkspaceStore, requestedPath: string, cwd: string | undefined): Promise<string> {
  const roots = await registeredWorkspaceRoots(workspaces);
  if (roots.length === 0) throw new AppError("FILE_ACCESS_DENIED", "File access is not available", 403);

  let candidate: string;
  if (isAbsoluteFilePath(requestedPath)) {
    candidate = requestedPath;
  } else {
    const base = await realpath(cwd ?? process.cwd()).catch(() => undefined);
    if (base === undefined) throw new AppError("FILE_NOT_FOUND", "File not found", 404);
    if (!roots.some((root) => isPathInside(root, base))) throw new AppError("FILE_ACCESS_DENIED", "File is outside a registered workspace", 403);
    candidate = resolve(base, requestedPath);
  }

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new AppError("FILE_NOT_FOUND", "File not found", 404);
  }
  if (!roots.some((root) => isPathInside(root, resolved))) throw new AppError("FILE_ACCESS_DENIED", "File is outside a registered workspace", 403);
  return resolved;
}

function fileResponseMimeType(ext: string): string {
  // Source files are always displayed as text, never interpreted as a document or script.
  if (new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".md", ".markdown", ".csv", ".tsv"]).has(ext)) return "text/plain; charset=utf-8";
  return FILE_MIME_TYPES[ext] ?? "application/octet-stream";
}

async function readWorkspaceFile(cwd: string, requestedPath: string): Promise<WorkspaceFileContent> {
  const root = await realpath(cwd).catch(() => { throw new AppError("WORKSPACE_UNAVAILABLE", "Workspace is unavailable", 404); });
  const filePath = await resolveWorkspacePath(root, requestedPath, "FILE_NOT_FOUND");
  const metadata = await stat(filePath).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) throw new AppError("FILE_NOT_FOUND", "File not found", 404);
  const content = await readTextFile(filePath, metadata);
  return { ...content, path: relative(root, filePath).replaceAll("\\", "/") };
}

async function readTextFile(filePath: string, metadata: { size: number }, includeContent = true): Promise<WorkspaceFileContent> {
  if (metadata.size > MAX_TEXT_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "File is too large to preview", 413);
  const ext = extname(filePath).toLowerCase();
  const mime = FILE_MIME_TYPES[ext];
  const textLike = mime === undefined || mime.startsWith("text/") || mime === "application/json" || mime === "application/x-ndjson" || mime === "application/xml";
  if (!textLike) throw new AppError("FILE_NOT_TEXT", "Only text files can be previewed", 415);

  // Stream the bounded file so a qualification check does not allocate the whole source.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const previewBuffer = includeContent ? Buffer.allocUnsafe(MAX_BROWSER_FILE_BYTES) : undefined;
  let previewBytes = 0;
  let size = 0;
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      size += chunk.byteLength;
      if (size > MAX_TEXT_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "File is too large to preview", 413);
      if (chunk.includes(0)) throw new AppError("FILE_BINARY", "Binary files cannot be previewed", 415);
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        throw new AppError("FILE_BINARY", "Binary files cannot be previewed", 415);
      }
      if (previewBuffer !== undefined && previewBytes < MAX_BROWSER_FILE_BYTES) {
        const length = Math.min(chunk.byteLength, MAX_BROWSER_FILE_BYTES - previewBytes);
        chunk.copy(previewBuffer, previewBytes, 0, length);
        previewBytes += length;
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw error;
  }
  try {
    decoder.decode();
  } catch {
    throw new AppError("FILE_BINARY", "Binary files cannot be previewed", 415);
  }
  let content = "";
  if (previewBuffer !== undefined && previewBytes > 0) {
    let end = previewBytes;
    const previewDecoder = new TextDecoder("utf-8", { fatal: true });
    while (end > 0) {
      try {
        content = previewDecoder.decode(previewBuffer.subarray(0, end));
        break;
      } catch {
        end -= 1;
      }
    }
  }
  return {
    path: filePath,
    name: basename(filePath),
    content,
    size,
    truncated: size > MAX_BROWSER_FILE_BYTES,
  };
}

async function resolveWorkspacePath(root: string, requestedPath: string, errorCode: string): Promise<string> {
  const normalized = requestedPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) throw new AppError(errorCode, "Path is outside the workspace", 400);
  const candidate = join(root, normalized);
  const resolved = await realpath(candidate).catch(() => { throw new AppError(errorCode, "Path not found", 404); });
  const relativePath = relative(root, resolved);
  if (relativePath === ".." || relativePath.startsWith(`..${String.fromCharCode(47)}`) || isAbsolute(relativePath)) throw new AppError(errorCode, "Path is outside the workspace", 400);
  return resolved;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sessionRef(value: unknown): SessionRef {
  const parsed = z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid() }).parse(value);
  return parsed;
}

function formatValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "请求参数无效";
  const path = issue.path.join(".");
  const labels: Record<string, string> = {
    "sish.server": "sish 服务器地址",
    "sish.sshPort": "sish SSH 端口",
    "sish.subdomain": "sish 子域名",
    "frp.server": "frps 服务器地址",
    "frp.remotePort": "frp 远程端口",
    "frp.token": "frp token",
    "frp.domain": "frp 域名",
    port: "目标端口",
  };
  const label = labels[path];
  if (issue.code === "too_small" && label !== undefined) return `${label}不能为空`;
  if (issue.code === "invalid_type" && label !== undefined) return `请填写有效的${label}`;
  if (issue.code === "invalid_type") return "请求参数类型无效";
  return "Invalid request";
}

function safeSessionRef(value: unknown): SessionRef | undefined {
  const parsed = z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid() }).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readAuthCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== AUTH_COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/** 下发/续期会话 Cookie；仅当连接本身是 HTTPS 时加 Secure（frp tcp 与局域网都是 HTTP）。 */
function applyAuthCookie(reply: FastifyReply, token: string, request: FastifyRequest): void {
  const secure = request.protocol === "https" ? "; Secure" : "";
  reply.header("set-cookie", `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(SESSION_TTL_MS / 1_000)}${secure}`);
}

function clearAuthCookie(reply: FastifyReply): void {
  reply.header("set-cookie", `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

interface CloseableSocket { close(code?: number, reason?: string): void }

/** WebSocket 握手鉴权：失败用 4401 关闭，客户端据此回到登录页而不是无限重连。 */
function authorizeSocket(auth: AuthService, request: FastifyRequest, socket: CloseableSocket): boolean {
  if (auth.status(readAuthCookie(request.headers.cookie)).authenticated) return true;
  socket.close(4401, "Unauthorized");
  return false;
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
