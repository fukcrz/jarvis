import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import type { AppSettings, AuthLoginOperation, ManagedModel, ManagedProvider, ProviderStatus } from "../shared/protocol.js";
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
      this.settings = { version: 1, assistantName: normalizeAssistantName(parsed.assistantName) };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.persistSettings();
    }
  }

  getSettings(): AppSettings { return { assistantName: this.settings.assistantName }; }

  async updateSettings(input: { assistantName: string }): Promise<AppSettings> {
    this.settings.assistantName = normalizeAssistantName(input.assistantName);
    await this.persistSettings();
    return this.getSettings();
  }

  async providers(): Promise<ProviderStatus[]> {
    const [runtime, modelConfig] = await Promise.all([this.modelRuntime(), this.readModelsConfig()]);
    const credentials = await runtime.listCredentials();
    const credentialType = new Map(credentials.map((credential) => [credential.providerId, credential.type]));
    return runtime.getProviders().map((provider) => {
      const auth = runtime.getProviderAuthStatus(provider.id);
      const configured = modelConfig.providers[provider.id];
      const hasPlaceholder = configured?.["apiKey"] === CUSTOM_API_KEY_PLACEHOLDER && credentialType.has(provider.id) === false;
      return {
        id: provider.id,
        name: provider.name,
        authConfigured: auth.configured && !hasPlaceholder,
        authSource: hasPlaceholder ? undefined : auth.label ?? auth.source,
        credentialType: credentialType.get(provider.id),
        supportsApiKey: provider.auth.apiKey !== undefined,
        supportsOAuth: provider.auth.oauth !== undefined,
        custom: modelConfig.providers[provider.id] !== undefined,
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
    await this.writeModelsConfig(config);
    await this.refreshRuntime();
    return provider;
  }

  async removeCustomProvider(providerId: string): Promise<void> {
    assertProviderId(providerId);
    const config = await this.readModelsConfig();
    if (!(providerId in config.providers)) throw new AppError("PROVIDER_NOT_CONFIGURED", "Custom provider configuration not found", 404);
    delete config.providers[providerId];
    await this.writeModelsConfig(config);
    await this.refreshRuntime();
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
  if (typeof value["baseUrl"] !== "string" || typeof value["api"] !== "string" || !isApi(value["api"])) return undefined;
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
  return { id, ...(typeof value["name"] === "string" ? { name: value["name"] } : {}), baseUrl: value["baseUrl"], api: value["api"], authHeader: value["authHeader"] === true, models };
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
  if (models.length === 0) throw new AppError("PROVIDER_MODELS_REQUIRED", "At least one model is required", 400);
  return { id: value.id, ...(value.name?.trim() ? { name: value.name.trim() } : {}), baseUrl, api: value.api, authHeader: value.authHeader === true, models };
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
function isApi(value: string): value is ManagedProvider["api"] {
  return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages" || value === "google-generative-ai";
}
function validPositiveInt(value: number | undefined): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }

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
