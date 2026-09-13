import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, resolveModelScopeWithDiagnostics, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { AppSettings, AuthLoginOperation, EnabledModelRef, EnabledModelsStatus, FetchedModel, ManagedCompat, ManagedMaxTokensField, ManagedModel, ManagedProvider, ManagedThinkingFormat, ProviderOverride, ProviderStatus } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";

interface StoredSettings { version: 1; assistantName: string; }
type ModelConfig = Record<string, unknown> & { providers: Record<string, Record<string, unknown>> };
interface LoginOperation {
  id: string;
  providerId: string;
  type: AuthType;
  controller: AbortController;
  state: AuthLoginOperation["state"];
  prompt?: AuthLoginOperation["prompt"];
  event?: AuthLoginOperation["event"];
  error?: string;
  resolvePrompt?: (value: string) => void;
}

const DEFAULT_ASSISTANT_NAME = "Jarvis";
const MAX_ASSISTANT_NAME_LENGTH = 64;
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const MODEL_ID = /^[^\r\n]{1,320}$/;
const CUSTOM_API_KEY_PLACEHOLDER = "jarvis-managed-provider-key";

/** Global Jarvis settings plus the Pi credentials/model configuration facade. */
export class SettingsService {
  private readonly settingsPath: string;
  private readonly modelsPath: string;
  private settings: StoredSettings = { version: 1, assistantName: DEFAULT_ASSISTANT_NAME };
  private readonly operations = new Map<string, LoginOperation>();

  constructor(
    private readonly modelRuntime: () => Promise<ModelRuntime>,
    private readonly refreshSessions: () => Promise<void>,
    settingsPath = join(process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis"), "settings.json"),
  ) {
    this.settingsPath = settingsPath;
    this.modelsPath = join(getAgentDir(), "models.json");
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, "utf8")) as Partial<StoredSettings>;
      if (parsed.version !== 1 || typeof parsed.assistantName !== "string") throw new Error("Unsupported settings format");
      this.settings = {
        version: 1,
        assistantName: normalizeAssistantName(parsed.assistantName),
      };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.persistSettings();
    }
  }

  getSettings(): AppSettings { return { assistantName: this.settings.assistantName }; }

  async updateSettings(input: Partial<Pick<AppSettings, "assistantName">>): Promise<AppSettings> {
    if (input.assistantName !== undefined) this.settings.assistantName = normalizeAssistantName(input.assistantName);
    await this.persistSettings();
    return this.getSettings();
  }

  async providers(): Promise<ProviderStatus[]> {
    const [runtime, modelConfig] = await Promise.all([this.modelRuntime(), this.readModelsConfig()]);
    const credentials = await runtime.listCredentials();
    const credentialType = new Map(credentials.map((credential) => [credential.providerId, credential.type]));
    return runtime.getProviders().map((provider) => {
      const auth = runtime.getProviderAuthStatus(provider.id);
      const configured = record(modelConfig.providers[provider.id]) ? modelConfig.providers[provider.id] : undefined;
      const hasPlaceholder = configured?.["apiKey"] === CUSTOM_API_KEY_PLACEHOLDER && credentialType.has(provider.id) === false;
      const custom = isManagedCustomProvider(configured);
      const override = custom ? undefined : projectProviderOverride(configured);
      return {
        id: provider.id,
        name: provider.name,
        authConfigured: auth.configured && !hasPlaceholder,
        authSource: hasPlaceholder ? undefined : auth.label ?? auth.source,
        credentialType: credentialType.get(provider.id),
        supportsApiKey: provider.auth.apiKey !== undefined,
        supportsOAuth: provider.auth.oauth !== undefined,
        custom,
        ...(override === undefined ? {} : { override }),
        models: runtime.getModels(provider.id).map(projectModel),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  async customProviders(): Promise<ManagedProvider[]> {
    const config = await this.readModelsConfig();
    return Object.entries(config.providers)
      .map(([id, value]) => projectManagedProvider(id, value))
      .filter((provider): provider is ManagedProvider => provider !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async saveCustomProvider(input: ManagedProvider): Promise<ManagedProvider> {
    const provider = validateManagedProvider(input);
    const config = await this.readModelsConfig();
    const existingValue = config.providers[provider.id];
    const existing = record(existingValue) ? existingValue : {};
    const existingModels = Array.isArray(existing["models"]) ? existing["models"] : [];
    const existingModelsById = new Map(existingModels.flatMap((model) => (
      record(model) && typeof model["id"] === "string" ? [[model["id"], model] as const] : []
    )));
    const models = provider.models.map((model) => {
      const savedModel: Record<string, unknown> = record(existingModelsById.get(model.id))
        ? { ...existingModelsById.get(model.id) }
        : {};
      savedModel["id"] = model.id;
      if (model.name === undefined) delete savedModel["name"];
      else savedModel["name"] = model.name;
      savedModel["reasoning"] = model.reasoning;
      savedModel["input"] = model.vision ? ["text", "image"] : ["text"];
      if (model.contextWindow !== undefined) savedModel["contextWindow"] = model.contextWindow;
      if (model.maxTokens !== undefined) savedModel["maxTokens"] = model.maxTokens;
      return savedModel;
    });
    config.providers[provider.id] = {
      ...existing,
      ...(provider.name === undefined ? {} : { name: provider.name }),
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.authHeader ? { authHeader: true } : { authHeader: undefined }),
      models,
    };
    const saved = config.providers[provider.id]!;
    if (saved["apiKey"] === CUSTOM_API_KEY_PLACEHOLDER) delete saved["apiKey"];
    if (!provider.authHeader) delete saved["authHeader"];
    if (provider.name === undefined) delete saved["name"];
    applyManagedHeaders(saved, provider.headers);
    applyManagedCompat(saved, provider.compat);
    await this.writeModelsConfig(config);
    await this.refreshRuntime();
    return provider;
  }

  async saveProviderOverride(providerId: string, input: ProviderOverride): Promise<ProviderOverride | undefined> {
    assertProviderId(providerId);
    const runtime = await this.modelRuntime();
    if (runtime.getProvider(providerId) === undefined) throw new AppError("PROVIDER_NOT_FOUND", "Provider not found", 404);
    const config = await this.readModelsConfig();
    const existingValue = config.providers[providerId];
    if (isManagedCustomProvider(existingValue)) throw new AppError("PROVIDER_IS_CUSTOM", "Use the custom provider editor for this connection", 400);
    const existing: Record<string, unknown> = record(existingValue) ? { ...existingValue } : {};
    const override = validateProviderOverride(input);
    if (override.baseUrl === undefined) delete existing["baseUrl"];
    else existing["baseUrl"] = override.baseUrl;
    applyManagedHeaders(existing, override.headers);
    applyManagedCompat(existing, override.compat);
    delete existing["api"];
    delete existing["models"];
    if (isEmptyProviderRecord(existing)) delete config.providers[providerId];
    else config.providers[providerId] = existing;
    await this.writeModelsConfig(config);
    await this.refreshRuntime();
    return projectProviderOverride(config.providers[providerId]);
  }

  async removeProviderOverride(providerId: string): Promise<void> {
    assertProviderId(providerId);
    const config = await this.readModelsConfig();
    const existingValue = config.providers[providerId];
    if (existingValue === undefined) throw new AppError("PROVIDER_NOT_CONFIGURED", "Provider override not found", 404);
    if (isManagedCustomProvider(existingValue)) throw new AppError("PROVIDER_IS_CUSTOM", "Use the custom provider editor for this connection", 400);
    delete config.providers[providerId];
    await this.writeModelsConfig(config);
    await this.refreshRuntime();
  }

  async removeCustomProvider(providerId: string): Promise<void> {
    assertProviderId(providerId);
    const config = await this.readModelsConfig();
    if (!(providerId in config.providers)) throw new AppError("PROVIDER_NOT_CONFIGURED", "Custom provider configuration not found", 404);
    delete config.providers[providerId];
    await this.writeModelsConfig(config);
    await this.refreshRuntime();
  }

  /** 拉取供应商的模型列表（用于「添加模型」时自动填入，不写任何配置）。 */
  async fetchProviderModels(providerId: string): Promise<FetchedModel[]> {
    assertProviderId(providerId);
    const runtime = await this.modelRuntime();
    const [provider, auth, config] = await Promise.all([
      Promise.resolve(runtime.getProvider(providerId)),
      runtime.getAuth(providerId),
      this.readModelsConfig(),
    ]);
    if (provider === undefined) throw new AppError("PROVIDER_NOT_FOUND", "Provider not found", 404);
    const configured = record(config.providers[providerId]) ? config.providers[providerId] : {};
    const configuredUrl = typeof configured["baseUrl"] === "string" && configured["baseUrl"].trim() !== "" ? configured["baseUrl"].trim() : undefined;
    const providerUrl = typeof provider.baseUrl === "string" && provider.baseUrl !== "" ? provider.baseUrl : undefined;
    const authUrl = typeof auth?.auth.baseUrl === "string" && auth.auth.baseUrl !== "" ? auth.auth.baseUrl : undefined;
    const baseUrl = configuredUrl ?? providerUrl ?? authUrl;
    if (baseUrl === undefined) throw new AppError("PROVIDER_AUTH_MISSING", "Provider base URL is not configured", 400);
    const api = isApi(configured["api"]) ? configured["api"] : detectApiFromProvider(provider, configured);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const url = modelsEndpoint(baseUrl, api);
      const headers: Record<string, string> = {
        ...(projectHeaders(provider.headers) ?? {}),
        ...(projectHeaders(configured["headers"]) ?? {}),
        ...(projectHeaders(auth?.auth.headers) ?? {}),
      };
      if (auth?.auth.apiKey !== undefined) {
        if (api === "anthropic-messages") {
          headers["x-api-key"] = auth.auth.apiKey;
          headers["anthropic-version"] ??= "2023-06-01";
        } else {
          headers["authorization"] = `Bearer ${auth.auth.apiKey}`;
        }
      }
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) throw new AppError("PROVIDER_MODELS_FETCH_FAILED", `模型列表接口返回 ${String(response.status)}`, 400);
      const body: unknown = await response.json();
      return projectFetchedModels(body, api);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PROVIDER_MODELS_FETCH_FAILED", `无法获取模型列表：${asMessage(error)}`, 400);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 当前「启用模型」设置：patterns 与它们解析出的模型列表。 */
  async enabledModels(): Promise<EnabledModelsStatus> {
    const [runtime, patterns] = await Promise.all([this.modelRuntime(), this.readEnabledModelPatterns()]);
    return { patterns, resolved: patterns.length === 0 ? [] : await this.resolveEnabledModels(runtime, patterns) };
  }

  /** 用完整启用集合（空 = 不限制）替换「启用模型」设置并刷新所有会话。 */
  async updateEnabledModels(models: EnabledModelRef[]): Promise<EnabledModelsStatus> {
    const runtime = await this.modelRuntime();
    const unique = new Map<string, EnabledModelRef>();
    for (const ref of models) unique.set(`${ref.provider}\u0000${ref.id}`, ref);
    const selected = [...unique.values()];
    const known = runtime.getModels();
    const knownKeys = new Set(known.map((model) => `${model.provider}\u0000${model.id}`));
    const unknown = selected.find((ref) => !knownKeys.has(`${ref.provider}\u0000${ref.id}`));
    if (unknown !== undefined) throw new AppError("MODEL_NOT_FOUND", `Model "${unknown.provider}/${unknown.id}" is not available`, 400);
    const patterns = enabledModelPatterns(selected, known);
    const { diagnostics } = await resolveModelScopeWithDiagnostics(patterns, runtime);
    const noMatch = diagnostics.find((diagnostic) => diagnostic.code === "no-match");
    if (noMatch !== undefined) throw new AppError("MODEL_CONFIGURATION_INVALID", `Model pattern "${noMatch.pattern}" does not match any model`, 400);
    SettingsManager.create(process.cwd(), getAgentDir()).setEnabledModels(patterns.length === 0 ? undefined : patterns);
    await this.refreshSessions();
    return { patterns, resolved: patterns.length === 0 ? [] : await this.resolveEnabledModels(runtime, patterns) };
  }

  private readEnabledModelPatterns(): string[] {
    return SettingsManager.create(process.cwd(), getAgentDir()).getEnabledModels() ?? [];
  }

  private async resolveEnabledModels(runtime: ModelRuntime, patterns: string[]): Promise<EnabledModelRef[]> {
    const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, runtime);
    return scopedModels.map(({ model }) => ({ provider: model.provider, id: model.id }));
  }

  async startLogin(providerId: string, type: AuthType): Promise<AuthLoginOperation> {
    assertProviderId(providerId);
    const runtime = await this.modelRuntime();
    const provider = runtime.getProvider(providerId);
    if (provider === undefined) throw new AppError("PROVIDER_NOT_FOUND", "Provider not found", 404);
    if (type === "api_key" && provider.auth.apiKey === undefined) throw new AppError("AUTH_METHOD_UNAVAILABLE", "This provider does not support API key login", 400);
    if (type === "oauth" && provider.auth.oauth === undefined) throw new AppError("AUTH_METHOD_UNAVAILABLE", "This provider does not support account login", 400);

    const operation: LoginOperation = { id: randomUUID(), providerId, type, controller: new AbortController(), state: "running" };
    this.operations.set(operation.id, operation);
    void runtime.login(providerId, type, {
      signal: operation.controller.signal,
      prompt: (prompt) => this.requestPrompt(operation, prompt),
      notify: (event) => { operation.event = projectAuthEvent(event); },
    }).then(() => {
      operation.state = "completed";
      operation.prompt = undefined;
      operation.resolvePrompt = undefined;
      return this.refreshSessions().catch((error: unknown) => {
        // Credentials have already been committed by Pi. Preserve that outcome
        // even if updating one of Jarvis's open session pickers fails.
        operation.error = `登录已完成，但模型列表刷新失败：${asMessage(error)}`;
      });
    }).catch((error: unknown) => {
      operation.prompt = undefined;
      operation.resolvePrompt = undefined;
      operation.state = operation.controller.signal.aborted ? "cancelled" : "failed";
      if (operation.state === "failed") operation.error = asMessage(error);
    });
    return this.operationSnapshot(operation);
  }

  loginStatus(operationId: string): AuthLoginOperation {
    const operation = this.operations.get(operationId);
    if (operation === undefined) throw new AppError("AUTH_OPERATION_NOT_FOUND", "Login operation not found", 404);
    return this.operationSnapshot(operation);
  }

  respondToLogin(operationId: string, value: string): AuthLoginOperation {
    const operation = this.operations.get(operationId);
    if (operation === undefined) throw new AppError("AUTH_OPERATION_NOT_FOUND", "Login operation not found", 404);
    if (operation.state !== "running" || operation.resolvePrompt === undefined) throw new AppError("AUTH_PROMPT_NOT_PENDING", "This login operation is not waiting for input", 409);
    const resolvePrompt = operation.resolvePrompt;
    operation.resolvePrompt = undefined;
    operation.prompt = undefined;
    resolvePrompt(value);
    return this.operationSnapshot(operation);
  }

  cancelLogin(operationId: string): AuthLoginOperation {
    const operation = this.operations.get(operationId);
    if (operation === undefined) throw new AppError("AUTH_OPERATION_NOT_FOUND", "Login operation not found", 404);
    if (operation.state === "running") operation.controller.abort();
    return this.operationSnapshot(operation);
  }

  async logout(providerId: string): Promise<void> {
    assertProviderId(providerId);
    const runtime = await this.modelRuntime();
    await runtime.logout(providerId);
    await this.refreshSessions();
  }

  private requestPrompt(operation: LoginOperation, prompt: AuthPrompt): Promise<string> {
    if (operation.controller.signal.aborted) return Promise.reject(new DOMException("Login cancelled", "AbortError"));
    operation.prompt = projectAuthPrompt(prompt);
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        operation.controller.signal.removeEventListener("abort", abort);
        prompt.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        operation.resolvePrompt = undefined;
        operation.prompt = undefined;
        reject(new DOMException("Login cancelled", "AbortError"));
      };
      operation.resolvePrompt = (value) => {
        cleanup();
        resolve(value);
      };
      operation.controller.signal.addEventListener("abort", abort, { once: true });
      prompt.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private operationSnapshot(operation: LoginOperation): AuthLoginOperation {
    return {
      id: operation.id,
      providerId: operation.providerId,
      type: operation.type,
      state: operation.state,
      ...(operation.prompt === undefined ? {} : { prompt: operation.prompt }),
      ...(operation.event === undefined ? {} : { event: operation.event }),
      ...(operation.error === undefined ? {} : { error: operation.error }),
    };
  }

  private async refreshRuntime(): Promise<void> {
    const runtime = await this.modelRuntime();
    const result = await runtime.refresh({ allowNetwork: false });
    const firstError = result.errors.values().next().value as Error | undefined;
    if (firstError !== undefined) throw new AppError("MODEL_CONFIGURATION_INVALID", firstError.message, 400);
    await this.refreshSessions();
  }

  private async readModelsConfig(): Promise<ModelConfig> {
    try {
      const raw = await readFile(this.modelsPath, "utf8");
      const parsed = JSON.parse(parseJsonc(raw)) as unknown;
      if (!record(parsed)) throw new AppError("MODEL_CONFIGURATION_INVALID", "models.json must contain an object", 400);
      const providers = record(parsed["providers"]) ? parsed["providers"] : {};
      return Object.assign({}, parsed, { providers }) as ModelConfig;
    } catch (error) {
      if (isMissingFile(error)) return { providers: {} };
      if (error instanceof AppError) throw error;
      throw new AppError("MODEL_CONFIGURATION_INVALID", `Could not read models.json: ${asMessage(error)}`, 400);
    }
  }

  private async writeModelsConfig(config: ModelConfig): Promise<void> {
    await mkdir(dirname(this.modelsPath), { recursive: true });
    await atomicWrite(this.modelsPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  private async persistSettings(): Promise<void> {
    await atomicWrite(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`);
  }
}

function projectModel(model: { id: string; name: string; reasoning: boolean; input: readonly string[]; contextWindow?: number; maxTokens?: number }): ManagedModel {
  return { id: model.id, name: model.name === model.id ? undefined : model.name, reasoning: model.reasoning, vision: model.input.includes("image"), contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}

function projectManagedProvider(id: string, value: Record<string, unknown>): ManagedProvider | undefined {
  if (!isManagedCustomProvider(value) || typeof value["baseUrl"] !== "string" || !isApi(value["api"])) return undefined;
  const models = Array.isArray(value["models"]) ? value["models"].flatMap((model): ManagedModel[] => {
    if (!record(model) || typeof model["id"] !== "string") return [];
    const input = Array.isArray(model["input"]) ? model["input"] : [];
    return [{
      id: model["id"],
      ...(typeof model["name"] === "string" ? { name: model["name"] } : {}),
      reasoning: model["reasoning"] === true,
      vision: input.includes("image"),
      ...(typeof model["contextWindow"] === "number" ? { contextWindow: model["contextWindow"] } : {}),
      ...(typeof model["maxTokens"] === "number" ? { maxTokens: model["maxTokens"] } : {}),
    }];
  }) : [];
  const headers = projectHeaders(value["headers"]);
  const compat = projectManagedCompat(value["compat"]);
  return {
    id,
    ...(typeof value["name"] === "string" ? { name: value["name"] } : {}),
    baseUrl: value["baseUrl"],
    api: value["api"],
    authHeader: value["authHeader"] === true,
    ...(headers === undefined ? {} : { headers }),
    ...(compat === undefined ? {} : { compat }),
    models,
  };
}

function validateManagedProvider(value: ManagedProvider): ManagedProvider {
  assertProviderId(value.id);
  const baseUrl = value.baseUrl.trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch { throw new AppError("PROVIDER_URL_INVALID", "Provider base URL must be a valid HTTP or HTTPS URL", 400); }
  if (!isApi(value.api)) throw new AppError("PROVIDER_API_INVALID", "Unsupported provider API", 400);
  const modelIds = new Set<string>();
  const models = value.models.map((model) => {
    const id = model.id.trim();
    if (!MODEL_ID.test(id)) throw new AppError("MODEL_ID_INVALID", "Model ID is required", 400);
    if (modelIds.has(id)) throw new AppError("MODEL_ID_DUPLICATE", `Model ID "${id}" is duplicated`, 400);
    modelIds.add(id);
    if (model.name !== undefined && model.name.trim().length > 160) throw new AppError("MODEL_NAME_INVALID", "Model name must be at most 160 characters", 400);
    return {
      id, ...(model.name?.trim() ? { name: model.name.trim() } : {}), reasoning: model.reasoning === true, vision: model.vision === true,
      ...(validPositiveInt(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(validPositiveInt(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    };
  });
  // 模型统一在「模型管理」里配置，允许先保存供应商再添加模型。
  const headers = validateHeaders(value.headers);
  const compat = validateManagedCompat(value.compat);
  return {
    id: value.id,
    ...(value.name?.trim() ? { name: value.name.trim() } : {}),
    baseUrl,
    api: value.api,
    authHeader: value.authHeader === true,
    ...(headers === undefined ? {} : { headers }),
    ...(compat === undefined ? {} : { compat }),
    models,
  };
}

function projectAuthPrompt(prompt: AuthPrompt): NonNullable<AuthLoginOperation["prompt"]> {
  return {
    type: prompt.type,
    message: prompt.message,
    ...(typeof prompt === "object" && "placeholder" in prompt && prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.type === "select" ? { options: prompt.options.map((option) => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) } : {}),
  };
}

function projectAuthEvent(event: AuthEvent): NonNullable<AuthLoginOperation["event"]> {
  if (event.type === "auth_url") return { type: event.type, url: event.url, message: event.instructions ?? "" };
  if (event.type === "device_code") return { type: event.type, message: event.userCode, url: event.verificationUri, ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }) };
  return { type: event.type, message: event.message, ...(event.type === "info" && event.links?.[0] !== undefined ? { url: event.links[0].url } : {}) };
}

function normalizeAssistantName(value: string): string {
  const name = value.trim();
  if (name === "") throw new AppError("ASSISTANT_NAME_INVALID", "Assistant name is required", 400);
  if (name.length > MAX_ASSISTANT_NAME_LENGTH) throw new AppError("ASSISTANT_NAME_INVALID", `Assistant name must be at most ${String(MAX_ASSISTANT_NAME_LENGTH)} characters`, 400);
  return name;
}
function assertProviderId(providerId: string): void {
  if (!PROVIDER_ID.test(providerId)) throw new AppError("PROVIDER_ID_INVALID", "Provider ID must contain only letters, numbers, dots, hyphens, or underscores", 400);
}
function isApi(value: unknown): value is ManagedProvider["api"] {
  return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages" || value === "google-generative-ai";
}
function validPositiveInt(value: number | undefined): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 2_000;
const COMPAT_KEYS = ["supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "maxTokensField", "thinkingFormat", "supportsEagerToolInputStreaming", "allowEmptySignature"] as const;
const THINKING_FORMATS = new Set<ManagedThinkingFormat>(["openai", "openrouter", "deepseek", "together", "qwen", "qwen-chat-template"]);
const MAX_TOKENS_FIELDS = new Set<ManagedMaxTokensField>(["max_completion_tokens", "max_tokens"]);

function isManagedCustomProvider(value: unknown): boolean {
  return record(value) && isApi(value["api"]);
}

function isEmptyProviderRecord(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

function projectHeaders(value: unknown): Record<string, string> | undefined {
  if (!record(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string" && headerValue !== "") headers[name] = headerValue;
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function projectManagedCompat(value: unknown): ManagedCompat | undefined {
  if (!record(value)) return undefined;
  const compat: ManagedCompat = {};
  if (typeof value["supportsDeveloperRole"] === "boolean") compat.supportsDeveloperRole = value["supportsDeveloperRole"];
  if (typeof value["supportsReasoningEffort"] === "boolean") compat.supportsReasoningEffort = value["supportsReasoningEffort"];
  if (typeof value["supportsUsageInStreaming"] === "boolean") compat.supportsUsageInStreaming = value["supportsUsageInStreaming"];
  if (typeof value["maxTokensField"] === "string" && MAX_TOKENS_FIELDS.has(value["maxTokensField"] as ManagedMaxTokensField)) {
    compat.maxTokensField = value["maxTokensField"] as ManagedMaxTokensField;
  }
  if (typeof value["thinkingFormat"] === "string" && THINKING_FORMATS.has(value["thinkingFormat"] as ManagedThinkingFormat)) {
    compat.thinkingFormat = value["thinkingFormat"] as ManagedThinkingFormat;
  }
  if (typeof value["supportsEagerToolInputStreaming"] === "boolean") compat.supportsEagerToolInputStreaming = value["supportsEagerToolInputStreaming"];
  if (typeof value["allowEmptySignature"] === "boolean") compat.allowEmptySignature = value["allowEmptySignature"];
  return Object.keys(compat).length === 0 ? undefined : compat;
}

function projectProviderOverride(value: unknown): ProviderOverride | undefined {
  if (!record(value) || isManagedCustomProvider(value)) return undefined;
  const rawUrl = value["baseUrl"];
  const baseUrl = typeof rawUrl === "string" && rawUrl.trim() !== "" ? rawUrl : undefined;
  const headers = projectHeaders(value["headers"]);
  const compat = projectManagedCompat(value["compat"]);
  if (baseUrl === undefined && headers === undefined && compat === undefined) return undefined;
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    ...(compat === undefined ? {} : { compat }),
  };
}

function validateOptionalHttpUrl(value: string | undefined, emptyLabel: string): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch { throw new AppError("PROVIDER_URL_INVALID", `${emptyLabel} must be a valid HTTP or HTTPS URL`, 400); }
  return trimmed;
}

function validateHeaders(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const names = Object.keys(value);
  if (names.length > MAX_HEADERS) throw new AppError("PROVIDER_HEADERS_INVALID", `At most ${String(MAX_HEADERS)} headers are allowed`, 400);
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of names) {
    const key = name.trim();
    if (!HEADER_NAME.test(key)) throw new AppError("PROVIDER_HEADERS_INVALID", "Header names must be valid HTTP tokens", 400);
    const folded = key.toLowerCase();
    if (seen.has(folded)) throw new AppError("PROVIDER_HEADERS_INVALID", `Header "${key}" is duplicated`, 400);
    seen.add(folded);
    const headerValue = value[name] ?? "";
    if (headerValue === "") throw new AppError("PROVIDER_HEADERS_INVALID", `Header "${key}" needs a value`, 400);
    if (headerValue.length > MAX_HEADER_VALUE) throw new AppError("PROVIDER_HEADERS_INVALID", `Header "${key}" is too long`, 400);
    headers[key] = headerValue;
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function validateManagedCompat(value: ManagedCompat | undefined): ManagedCompat | undefined {
  if (value === undefined) return undefined;
  const compat: ManagedCompat = {};
  if (value.supportsDeveloperRole !== undefined) compat.supportsDeveloperRole = value.supportsDeveloperRole;
  if (value.supportsReasoningEffort !== undefined) compat.supportsReasoningEffort = value.supportsReasoningEffort;
  if (value.supportsUsageInStreaming !== undefined) compat.supportsUsageInStreaming = value.supportsUsageInStreaming;
  if (value.maxTokensField !== undefined) {
    if (!MAX_TOKENS_FIELDS.has(value.maxTokensField)) throw new AppError("PROVIDER_COMPAT_INVALID", "Unsupported max tokens field", 400);
    compat.maxTokensField = value.maxTokensField;
  }
  if (value.thinkingFormat !== undefined) {
    if (!THINKING_FORMATS.has(value.thinkingFormat)) throw new AppError("PROVIDER_COMPAT_INVALID", "Unsupported thinking format", 400);
    compat.thinkingFormat = value.thinkingFormat;
  }
  if (value.supportsEagerToolInputStreaming !== undefined) compat.supportsEagerToolInputStreaming = value.supportsEagerToolInputStreaming;
  if (value.allowEmptySignature !== undefined) compat.allowEmptySignature = value.allowEmptySignature;
  return Object.keys(compat).length === 0 ? undefined : compat;
}

function validateProviderOverride(value: ProviderOverride): ProviderOverride {
  const baseUrl = validateOptionalHttpUrl(value.baseUrl, "Provider base URL");
  const headers = validateHeaders(value.headers);
  const compat = validateManagedCompat(value.compat);
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    ...(compat === undefined ? {} : { compat }),
  };
}

function applyManagedHeaders(target: Record<string, unknown>, headers: Record<string, string> | undefined): void {
  if (headers === undefined) delete target["headers"];
  else target["headers"] = headers;
}

function applyManagedCompat(target: Record<string, unknown>, compat: ManagedCompat | undefined): void {
  const existing = record(target["compat"]) ? { ...target["compat"] } : {};
  for (const key of COMPAT_KEYS) delete existing[key];
  if (compat !== undefined) Object.assign(existing, compat);
  if (Object.keys(existing).length === 0) delete target["compat"];
  else target["compat"] = existing;
}

/** 按 API 类型拼模型列表端点（baseUrl 已含版本路径，如 .../v1）。 */
function modelsEndpoint(baseUrl: string, api: ManagedProvider["api"]): string {
  const base = baseUrl.replace(/\/$/u, "");
  return api === "google-generative-ai" ? `${base}/models?pageSize=1000` : `${base}/models`;
}

/** 解析各 API 的模型列表响应为统一结构（id + 可选显示名）。 */
function projectFetchedModels(body: unknown, api: ManagedProvider["api"]): FetchedModel[] {
  const names: Record<string, string | undefined> = {};
  let rows: unknown[] = [];
  if (api === "google-generative-ai") {
    if (!record(body) || !Array.isArray(body["models"])) return [];
    rows = body["models"];
    for (const row of rows) {
      if (record(row) && typeof row["name"] === "string") {
        const id = row["name"].replace(/^models\//u, "");
        if (id !== "") names[id] = typeof row["displayName"] === "string" ? row["displayName"] : undefined;
      }
    }
  } else if (api === "anthropic-messages") {
    if (!record(body) || !Array.isArray(body["data"])) return [];
    rows = body["data"];
    for (const row of rows) {
      if (record(row) && typeof row["id"] === "string" && row["id"] !== "") {
        names[row["id"]] = typeof row["display_name"] === "string" ? row["display_name"] : undefined;
      }
    }
  } else {
    if (!record(body) || !Array.isArray(body["data"])) return [];
    rows = body["data"];
    for (const row of rows) {
      if (record(row) && typeof row["id"] === "string" && row["id"] !== "") names[row["id"]] = undefined;
    }
  }
  return Object.entries(names)
    .map(([id, name]) => ({ id, ...(name === undefined || name === id ? {} : { name }) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** 从 models.json 或已加载模型推断 API 类型（缺省按 OpenAI 兼容处理）。 */
function detectApiFromProvider(provider: { getModels(): readonly { api: string }[] }, configured: Record<string, unknown>): ManagedProvider["api"] {
  if (isApi(configured["api"])) return configured["api"];
  const modelApi = provider.getModels()[0]?.api;
  if (isApi(modelApi)) return modelApi;
  return "openai-completions";
}

/**
 * 把选中的模型集合转换为 Pi enabledModels patterns：
 * 供应商全选折叠为 `<provider>/**`，部分选择用精确 `<provider>/<modelId>`。
 */
function enabledModelPatterns(selected: EnabledModelRef[], known: readonly { provider: string; id: string }[]): string[] {
  const knownPerProvider = new Map<string, number>();
  for (const model of known) knownPerProvider.set(model.provider, (knownPerProvider.get(model.provider) ?? 0) + 1);
  const selectedPerProvider = new Map<string, EnabledModelRef[]>();
  for (const ref of selected) {
    const group = selectedPerProvider.get(ref.provider) ?? [];
    group.push(ref);
    selectedPerProvider.set(ref.provider, group);
  }
  const patterns: string[] = [];
  for (const [providerId, refs] of selectedPerProvider) {
    if (refs.length === knownPerProvider.get(providerId)) {
      patterns.push(`${providerId}/**`);
    } else {
      for (const ref of refs) patterns.push(`${ref.provider}/${ref.id}`);
    }
  }
  return patterns.sort();
}

function parseJsonc(value: string): string {
  let result = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (quote !== undefined) {
      result += character;
      if (character === "\\") { result += next ?? ""; index += 1; } else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; result += character; continue; }
    if (character === "/" && next === "/") { while (index < value.length && value[index] !== "\n") index += 1; result += "\n"; continue; }
    if (character === "/" && next === "*") { index += 2; while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1; index += 1; continue; }
    result += character;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}
async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
function isMissingFile(error: unknown): boolean { return record(error) && error["code"] === "ENOENT"; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
