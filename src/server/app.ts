import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MANAGED_APIS, MANAGED_MAX_TOKENS_FIELDS, MANAGED_THINKING_FORMATS, THINKING_LEVELS, TUNNEL_METHODS } from "../shared/protocol.js";
import type { ApiErrorBody, SessionRef } from "../shared/protocol.js";
import { AuthService } from "./auth-service.js";
import { AppError, asMessage, errorStatusCode } from "./errors.js";
import { EventHub } from "./event-hub.js";
import { applyAuthCookie, authorizeSocket, clearAuthCookie, readAuthCookie } from "./http-auth.js";
import { SessionService } from "./session-service.js";
import { desktopEnabled } from "./desktop-bridge.js";
import { registerSelfRestart } from "./self-restart.js";
import { WorkspaceStore } from "./workspace-store.js";
import { SettingsService } from "./settings-service.js";
import { TunnelService } from "./tunnel-service.js";
import {
  fileResponseMimeType,
  listDirectory,
  listRoots,
  listWorkspaceDirectory,
  parseByteRange,
  readTextFile,
  readWorkspaceFile,
  removeWorkspaceEntry,
  resolveFileRequestPath,
  searchWorkspaceFiles,
} from "./workspace-fs.js";

const workspaceInput = z.object({ cwd: z.string().min(1), label: z.string().max(96).optional() }).strict();
const workspaceUpdateInput = z.object({ label: z.string().min(1).max(96) }).strict();
const workspaceOrderInput = z.object({ ids: z.array(z.string().uuid()).max(500) }).strict();
const directoryQuery = z.object({ path: z.string().min(1).optional(), roots: z.enum(["true"]).optional() }).strict();
const fileSearchQuery = z.object({ query: z.string().max(160).optional() }).strict();
const workspacePathQuery = z.object({ path: z.string().max(2000).optional() }).strict();
const workspaceEntryQuery = z.object({ path: z.string().min(1).max(2000) }).strict();
const sessionPatchInput = z.object({
  name: z.string().min(1).max(120).optional(),
  starred: z.boolean().optional(),
}).strict().refine((value) => value.name !== undefined || value.starred !== undefined, { message: "name or starred is required" });
const sessionCleanupInput = z.object({ keepSessionId: z.string().uuid().optional() }).strict();
const modelInput = z.object({ provider: z.string().min(1).max(160), modelId: z.string().min(1).max(320) }).strict();
const thinkingInput = z.object({ level: z.enum(THINKING_LEVELS) }).strict();
const imageInput = z.object({ mimeType: z.string().min(1).max(120), data: z.string().min(1) }).strict();
const promptInput = z.object({ text: z.string(), clientRequestId: z.string().uuid(), images: z.array(imageInput).optional(), behavior: z.enum(["steer", "followUp"]).optional() }).strict();
const messageActionInput = z.object({ messageId: z.string().min(1).max(200).optional() }).strict();
const editAndResendInput = z.object({ messageId: z.string().min(1).max(200), text: z.string(), clientRequestId: z.string().uuid(), images: z.array(imageInput).optional() }).strict();
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
const managedHeadersInput = z.record(z.string().min(1).max(64), z.string().min(1).max(2_000)).refine((value) => Object.keys(value).length <= 20, { message: "At most 20 headers are allowed" });
const managedCompatInput = z.object({
  supportsDeveloperRole: z.boolean().optional(),
  supportsReasoningEffort: z.boolean().optional(),
  supportsUsageInStreaming: z.boolean().optional(),
  maxTokensField: z.enum(MANAGED_MAX_TOKENS_FIELDS).optional(),
  thinkingFormat: z.enum(MANAGED_THINKING_FORMATS).optional(),
  supportsEagerToolInputStreaming: z.boolean().optional(),
  allowEmptySignature: z.boolean().optional(),
}).strict();
const managedProviderInput = z.object({
  id: z.string().min(1).max(120),
  name: z.string().max(160).optional(),
  baseUrl: z.string().min(1).max(2_000),
  api: z.enum(MANAGED_APIS),
  authHeader: z.boolean(),
  headers: managedHeadersInput.optional(),
  compat: managedCompatInput.optional(),
  models: z.array(managedModelInput).max(200),
}).strict();
const providerOverrideInput = z.object({
  baseUrl: z.string().max(2_000).optional(),
  headers: managedHeadersInput.optional(),
  compat: managedCompatInput.optional(),
}).strict();
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

export interface JarvisServices {
  workspaces: WorkspaceStore;
  sessions: SessionService;
  events: EventHub;
  tunnel: TunnelService;
  auth: AuthService;
}

export async function buildApp(options: { serveStatic?: boolean; staticRoot?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" }, bodyLimit: 25 * 1024 * 1024 });
  const production = process.env["NODE_ENV"] === "production";
  const workspaces = new WorkspaceStore();
  await workspaces.initialize(getAgentDir(), "pi agent");
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

  app.get("/api/health", async () => desktopEnabled()
    ? { ok: true, version: 1, desktop: true, running: sessions.runningCount() }
    : { ok: true, version: 1 });

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
  app.put("/api/settings/providers/:providerId/override", async (request) => {
    const params = z.object({ providerId: z.string().min(1).max(120) }).parse(request.params);
    const override = await settings.saveProviderOverride(params.providerId, providerOverrideInput.parse(request.body));
    return { override: override ?? null };
  });
  app.delete("/api/settings/providers/:providerId/override", async (request) => {
    const params = z.object({ providerId: z.string().min(1).max(120) }).parse(request.params);
    await settings.removeProviderOverride(params.providerId);
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
    const resolved = await resolveFileRequestPath(query.path, query.cwd);
    const metadata = await stat(resolved).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile()) throw new AppError("FILE_NOT_FOUND", "File not found", 404);
    if (query.text !== undefined) return { file: await readTextFile(resolved, metadata, { includeContent: query.text !== "check" }) };
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
  app.post("/api/workspaces/:workspaceId/sessions/cleanup", async (request) => {
    const params = z.object({ workspaceId: z.string().uuid() }).parse(request.params);
    const body = sessionCleanupInput.parse(request.body ?? {});
    return sessions.cleanup(params.workspaceId, body.keepSessionId);
  });
  app.patch("/api/workspaces/:workspaceId/sessions/:sessionId", async (request) => {
    const ref = sessionRef(request.params);
    const body = sessionPatchInput.parse(request.body);
    return { session: await sessions.patch(ref, body) };
  });
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/viewed", async (request) => ({ session: await sessions.markViewed(sessionRef(request.params)) }));
  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/side-chat", async (request) => ({ session: await sessions.peekSideChat(sessionRef(request.params)) }));
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/side-chat", async (request) => ({ session: await sessions.ensureSideChat(sessionRef(request.params)) }));
  app.post("/api/workspaces/:workspaceId/sessions/:sessionId/side-chat/reset", async (request) => ({ session: await sessions.resetSideChat(sessionRef(request.params)) }));
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
  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/user-messages", async (request) => sessions.userMessages(sessionRef(request.params)));
  app.get("/api/workspaces/:workspaceId/sessions/:sessionId/media/:itemId/:index", async (request, reply) => {
    const ref = sessionRef(request.params);
    const params = z.object({ itemId: z.string().min(1).max(500), index: z.coerce.number().int().nonnegative().max(64) }).parse(request.params);
    const image = sessions.toolImage(ref, params.itemId, params.index);
    return reply
      .type(image.mimeType)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=3600")
      .header("content-length", String(image.bytes.length))
      .send(image.bytes);
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
    return sessions.prompt(ref, body.text, body.clientRequestId, body.images, { behavior: body.behavior });
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
      const path = request.url.split("?")[0] ?? "";
      if (path === "/api" || path.startsWith("/api/")) {
        const response: ApiErrorBody = { error: { code: "NOT_FOUND", message: "Route not found", requestId: request.id } };
        return reply.status(404).send(response);
      }
      const rootFile = rootStaticFileName(staticRoot, path);
      if (rootFile !== undefined) {
        try {
          if ((await stat(join(staticRoot, rootFile))).isFile()) return reply.sendFile(rootFile);
        } catch {
          // Fall through to the SPA shell for unknown root paths.
        }
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

function sessionRef(value: unknown): SessionRef {
  const parsed = z.object({ workspaceId: z.string().uuid(), sessionId: z.string().uuid() }).parse(value);
  return parsed;
}

/** Root-level files copied from Vite public/ (favicon, apple-touch-icon). Nested paths stay on the SPA fallback. */
function rootStaticFileName(staticRoot: string, requestPath: string): string | undefined {
  const name = requestPath.startsWith("/") ? requestPath.slice(1) : requestPath;
  if (name === "" || name === "." || name === "..") return undefined;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return undefined;
  if (dirname(resolve(staticRoot, name)) !== resolve(staticRoot)) return undefined;
  return name;
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

export function errorBody(error: unknown): ApiErrorBody {
  const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", asMessage(error), 500);
  return { error: { code: appError.code, message: appError.message } };
}
