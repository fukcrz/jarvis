import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, Eye, EyeOff, KeyRound, LogOut, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { AuthLoginOperation, EnabledModelsStatus, FetchedModel, ManagedApi, ManagedCompat, ManagedMaxTokensField, ManagedModel, ManagedProvider, ManagedThinkingFormat, ProviderOverride, ProviderStatus } from "../../shared/protocol";
import { ApiError, api } from "../api";
import { useHistoryBackTrap } from "../lib/history-back-trap";
import { displayModelName } from "../model-display";
import { DirtyBar, SaveState, useDirtyRegistration, useSaveStatus, useSettingsToast } from "./settings-feedback";
import {
  SectionAction,
  Segmented,
  SettingRow,
  SettingsBanner,
  SettingsCard,
  SettingsEmptyLine,
  SettingsField,
  SettingsFormSwitch,
  SettingsLoading,
  SettingsPageHead,
  SettingsSection,
  SettingsSwitch,
  SettingsTag,
  StButton,
} from "./settings-ui";

export const EMPTY_PROVIDER: ManagedProvider = { id: "", baseUrl: "", api: "openai-completions", authHeader: true, models: [] };

const API_OPTIONS: Array<{ id: ManagedApi; label: string; description: string }> = [
  { id: "openai-completions", label: "OpenAI Completions", description: "最常见的兼容接口：/v1/chat/completions" },
  { id: "openai-responses", label: "OpenAI Responses", description: "OpenAI 新版 /v1/responses 接口" },
  { id: "anthropic-messages", label: "Anthropic Messages", description: "Claude 风格的 /v1/messages 接口" },
  { id: "google-generative-ai", label: "Google Generative AI", description: "Gemini 接口" },
];

const THINKING_FORMAT_OPTIONS: Array<{ id: ManagedThinkingFormat; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "together", label: "Together" },
  { id: "qwen", label: "通义" },
  { id: "qwen-chat-template", label: "通义模板" },
];

interface ConnectionPreset {
  id: string;
  label: string;
  compat?: ManagedCompat;
}

const CONNECTION_PRESETS: ConnectionPreset[] = [
  { id: "standard", label: "标准" },
  { id: "local", label: "本地", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } },
  { id: "openrouter", label: "OpenRouter", compat: { thinkingFormat: "openrouter" } },
  { id: "deepseek", label: "DeepSeek", compat: { thinkingFormat: "deepseek" } },
  { id: "qwen", label: "通义", compat: { thinkingFormat: "qwen" } },
];

interface HeaderRow {
  id: string;
  name: string;
  value: string;
}

export function modelKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
}

export function splitModelKey(key: string): { provider: string; id: string } {
  const separator = key.indexOf("\u0000");
  return { provider: key.slice(0, separator), id: key.slice(separator + 1) };
}

export function isProviderUsable(provider: ProviderStatus): boolean {
  return provider.authConfigured || provider.custom;
}

export function initializeDraft(providers: ProviderStatus[], enabled: EnabledModelsStatus): Set<string> {
  const usable = providers.filter(isProviderUsable);
  const usableKeys = usable.flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id)));
  if (enabled.patterns.length === 0) return new Set(usableKeys);
  const allowed = new Set(usableKeys);
  return new Set(enabled.resolved.map((ref) => modelKey(ref.provider, ref.id)).filter((key) => allowed.has(key)));
}

function providerAvatarStyle(id: string): { background: string } {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return { background: `linear-gradient(135deg, hsl(${String(hash)} 62% 46%), hsl(${String((hash + 40) % 360)} 58% 38%))` };
}

/** API Key 输入：默认打码，可临时显示；只保存在本机。 */
export function ApiKeyField({ value, onChange, readOnly = false, placeholder, hint }: { value: string; onChange: (value: string) => void; readOnly?: boolean; placeholder?: string; hint?: ReactNode }) {
  const [visible, setVisible] = useState(false);
  return <SettingsField id="api-key" label="API Key" hint={hint ?? "只保存在本机，不会写进日志"}>
    <span className="st-key-wrap">
      <input type={visible ? "text" : "password"} aria-label="API Key" value={value} readOnly={readOnly} placeholder={placeholder} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      <button type="button" aria-label={visible ? "隐藏 API Key" : "显示 API Key"} title={visible ? "隐藏" : "显示"} onClick={() => setVisible((current) => !current)}>{visible ? <EyeOff size={13} /> : <Eye size={13} />}<span>{visible ? "隐藏" : "显示"}</span></button>
    </span>
  </SettingsField>;
}

/** 已保存密钥的打码展示：只露后 4 位。 */
export function maskApiKey(key: string | undefined): string | undefined {
  if (key === undefined || key.trim() === "") return undefined;
  return `••••${key.trim().slice(-4)}`;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function urlWarning(value: string): string | undefined {
  return value.trim() === "" || isValidHttpUrl(value.trim()) ? undefined : "看起来不像 http(s) 地址，仍然可以保存";
}

function apiLabel(api: string): string {
  return API_OPTIONS.find((option) => option.id === api)?.label ?? api;
}

function hostLabel(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === "") return undefined;
  return url.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
}

export function formatContextWindow(tokens: number | undefined): string | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return undefined;
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`;
  if (tokens >= 1000) return `${String(Math.round(tokens / 1000))}K`;
  return String(tokens);
}

function headersFromRecord(headers: Record<string, string> | undefined): HeaderRow[] {
  if (headers === undefined) return [];
  return Object.entries(headers).map(([name, value], index) => ({ id: `${name}-${String(index)}`, name, value }));
}

function recordFromHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "") continue;
    headers[name] = row.value;
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function compactCompat(value: ManagedCompat | undefined): ManagedCompat | undefined {
  if (value === undefined) return undefined;
  const next: ManagedCompat = {};
  if (value.supportsDeveloperRole !== undefined) next.supportsDeveloperRole = value.supportsDeveloperRole;
  if (value.supportsReasoningEffort !== undefined) next.supportsReasoningEffort = value.supportsReasoningEffort;
  if (value.supportsUsageInStreaming !== undefined) next.supportsUsageInStreaming = value.supportsUsageInStreaming;
  if (value.maxTokensField !== undefined) next.maxTokensField = value.maxTokensField;
  if (value.thinkingFormat !== undefined) next.thinkingFormat = value.thinkingFormat;
  if (value.supportsEagerToolInputStreaming !== undefined) next.supportsEagerToolInputStreaming = value.supportsEagerToolInputStreaming;
  if (value.allowEmptySignature !== undefined) next.allowEmptySignature = value.allowEmptySignature;
  return Object.keys(next).length === 0 ? undefined : next;
}

function sameCompat(left: ManagedCompat | undefined, right: ManagedCompat | undefined): boolean {
  return JSON.stringify(compactCompat(left) ?? {}) === JSON.stringify(compactCompat(right) ?? {});
}

function matchingPresetId(compat: ManagedCompat | undefined): string {
  const match = CONNECTION_PRESETS.find((preset) => sameCompat(preset.compat, compat));
  return match?.id ?? "custom";
}

function hasAdvancedConnection(headers: Record<string, string> | undefined, compat: ManagedCompat | undefined): boolean {
  return (headers !== undefined && Object.keys(headers).length > 0) || compactCompat(compat) !== undefined;
}

function connectionSummary(headers: Record<string, string> | undefined, compat: ManagedCompat | undefined): string {
  const preset = matchingPresetId(compat);
  const presetLabel = CONNECTION_PRESETS.find((item) => item.id === preset)?.label;
  const parts: string[] = [];
  if (presetLabel !== undefined && preset !== "standard") parts.push(presetLabel);
  else if (preset === "custom") parts.push("自定义");
  const headerCount = headers === undefined ? 0 : Object.keys(headers).length;
  if (headerCount > 0) parts.push(`${String(headerCount)} 个请求头`);
  return parts.length === 0 ? "默认" : parts.join(" · ");
}

export function ProviderAvatar({ id, name }: { id: string; name?: string }) {
  return <span aria-hidden className="provider-avatar" style={providerAvatarStyle(id)}>{(name ?? id).slice(0, 1).toUpperCase()}</span>;
}

/** 供应商状态的中文短词，不露 authSource 等内部值。 */
export function providerStatusLabel(provider: ProviderStatus, custom?: ManagedProvider): { label: string; tone: "ready" | "unset" } {
  if (provider.authConfigured) return { label: provider.credentialType === "oauth" ? "已登录" : "已连接", tone: "ready" };
  if (custom !== undefined || provider.custom) return { label: "已连接 · 无密钥", tone: "ready" };
  return { label: provider.supportsOAuth && !provider.supportsApiKey ? "未登录" : provider.supportsApiKey ? "未设置密钥" : "未登录", tone: "unset" };
}

/** 凭据来源的中文说明：stored / environment / runtime。 */
export function authSourceLabel(provider: ProviderStatus): string | undefined {
  if (!provider.authConfigured || provider.authSource === undefined) return undefined;
  if (provider.authSource === "stored") return provider.credentialType === "oauth" ? "账号授权" : "本机保存的密钥";
  if (provider.authSource === "runtime") return "运行时提供";
  if (provider.authSource === "environment") return "环境变量";
  return /^[A-Z0-9_]+$/u.test(provider.authSource) ? `环境变量 ${provider.authSource}` : provider.authSource;
}

function isEnvironmentAuth(provider: ProviderStatus): boolean {
  return provider.authSource === "environment" || (provider.authSource !== undefined && /^[A-Z0-9_]+$/u.test(provider.authSource));
}

/** 模型数统一口径：可用 N · 已启用 M（导航、列表行、详情共用）。 */
export function providerModelSummary(available: number, enabled: number): string {
  if (available === 0) return "还没有模型";
  return `可用 ${String(available)} · 已启用 ${String(enabled)}`;
}

function providerDisplayName(provider: ProviderStatus, custom?: ManagedProvider): string {
  return custom?.name ?? provider.name;
}

function modelDetail(model: ManagedModel, extra?: string): string {
  return [extra, model.id, model.reasoning ? "思考" : undefined, model.vision ? "图片" : undefined, formatContextWindow(model.contextWindow)].filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

/* ------------------------------------------------------------------ *
 * 数据层：供应商、自定义供应商、启用的模型；所有改动都在这里统一保存/回滚/撤销
 * ------------------------------------------------------------------ */

export interface ProviderSettings {
  providers: ProviderStatus[];
  /** 已排除「删除后等待撤销」的供应商。 */
  visibleProviders: ProviderStatus[];
  orphanedProviders: ManagedProvider[];
  customById: Map<string, ManagedProvider>;
  enabled: Set<string>;
  allModelKeys: Set<string>;
  unrestricted: boolean;
  loading: boolean;
  connectedCount: number;
  reload: (background?: boolean) => Promise<void>;
  toggleModel: (providerId: string, modelId: string) => void;
  enableModels: (providerId: string, modelIds: string[], key?: string) => void;
  enableAll: () => void;
  saveCustomModels: (providerId: string, models: ManagedModel[]) => Promise<void>;
  removeCustomModel: (providerId: string, modelId: string) => Promise<void>;
  saveCustomConnection: (provider: ManagedProvider, apiKey?: string) => Promise<ManagedProvider>;
  saveBuiltinConnection: (provider: ProviderStatus, override: ProviderOverride | undefined, apiKey?: string) => Promise<void>;
  saveKnownApiKey: (provider: ProviderStatus, apiKey: string) => Promise<void>;
  restoreOfficial: (provider: ProviderStatus) => Promise<void>;
  clearCredential: (provider: ProviderStatus) => Promise<void>;
  deleteProvider: (provider: ManagedProvider) => void;
  startLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => Promise<void>;
  overlay: ReactNode;
}

export function useProviderSettings(refreshKey: number): ProviderSettings {
  const saveStatus = useSaveStatus();
  const toast = useSettingsToast();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [customProviders, setCustomProviders] = useState<ManagedProvider[]>([]);
  const [enabled, setEnabledState] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [operation, setOperation] = useState<AuthLoginOperation | undefined>();
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const customRef = useRef(customProviders);
  customRef.current = customProviders;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const setEnabled = useCallback((next: Set<string>) => { enabledRef.current = next; setEnabledState(next); }, []);

  const reload = useCallback(async (background = false) => {
    const id = ++generation.current;
    if (!background) setLoading(true);
    try {
      const [available, custom, enabledStatus] = await Promise.all([api.providers(), api.customProviders(), api.enabledModels()]);
      if (id !== generation.current) return;
      setProviders(available);
      setCustomProviders(custom);
      setEnabled(initializeDraft(available, enabledStatus));
    } catch (error) {
      if (id === generation.current) toast.notify(error instanceof Error ? error.message : "无法读取供应商", "error");
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }, [setEnabled, toast]);
  useEffect(() => {
    void reload(refreshKey > 0);
    return () => { ++generation.current; };
  }, [reload, refreshKey]);

  useEffect(() => {
    if (operation === undefined || operation.state !== "running") return;
    const timer = window.setInterval(() => {
      void api.loginStatus(operation.id).then((next) => {
        setOperation(next);
        if (next.state === "completed") void reload(true);
      }).catch((error: unknown) => toast.notify(error instanceof Error ? error.message : "登录状态读取失败", "error"));
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation?.id, operation?.state, reload, toast]);

  const usableKeys = useCallback(() => new Set(providersRef.current.filter(isProviderUsable).flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id)))), []);
  /** 串行写入最新的启用列表；全部启用时写空列表（=不限制）。 */
  const persistEnabled = useCallback(() => {
    const run = queue.current.catch(() => undefined).then(async () => {
      const all = usableKeys();
      const scoped = [...enabledRef.current].filter((key) => all.has(key));
      const unrestricted = all.size > 0 && scoped.length === all.size;
      await api.updateEnabledModels(unrestricted ? [] : scoped.map((key) => splitModelKey(key)));
    });
    queue.current = run;
    return run;
  }, [usableKeys]);
  const wouldDisableAll = useCallback((next: Set<string>) => {
    const all = usableKeys();
    return all.size > 0 && ![...next].some((key) => all.has(key));
  }, [usableKeys]);

  const toggleModel = useCallback((providerId: string, modelId: string) => {
    const key = modelKey(providerId, modelId);
    const wasOn = enabledRef.current.has(key);
    const next = new Set(enabledRef.current);
    if (wasOn) next.delete(key); else next.add(key);
    if (wasOn && wouldDisableAll(next)) {
      // Pi 的 enabledModels 为空表示「不限制」，全关会变成全开，所以这里是唯一保留的拦截。
      toast.notify("至少保留一个模型：全部关掉会被当成「不限制」，反而全部启用", "error");
      return;
    }
    setEnabled(next);
    void saveStatus.run(`model:${key}`, persistEnabled, {
      rollback: () => {
        const restored = new Set(enabledRef.current);
        if (wasOn) restored.add(key); else restored.delete(key);
        setEnabled(restored);
      },
    });
  }, [persistEnabled, saveStatus, setEnabled, toast, wouldDisableAll]);

  const enableModels = useCallback((providerId: string, modelIds: string[], key = `models:${providerId}`) => {
    const added = modelIds.map((id) => modelKey(providerId, id)).filter((item) => !enabledRef.current.has(item));
    if (added.length === 0) return;
    setEnabled(new Set([...enabledRef.current, ...added]));
    void saveStatus.run(key, persistEnabled, {
      rollback: () => setEnabled(new Set([...enabledRef.current].filter((item) => !added.includes(item)))),
    });
  }, [persistEnabled, saveStatus, setEnabled]);

  const enableAll = useCallback(() => {
    const previous = enabledRef.current;
    setEnabled(usableKeys());
    void saveStatus.run("enabled-models", persistEnabled, { rollback: () => setEnabled(previous) });
  }, [persistEnabled, saveStatus, setEnabled, usableKeys]);

  const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
    try {
      await api.setProviderApiKey(providerId, apiKey);
    } catch (error) {
      if (error instanceof ApiError && error.code === "AUTH_LOGIN_INTERACTIVE") {
        setOperation(await api.startLogin(providerId, "api_key"));
        return;
      }
      throw error;
    }
  }, []);

  const saveCustomModels = useCallback(async (providerId: string, models: ManagedModel[]) => {
    const current = customRef.current.find((provider) => provider.id === providerId);
    if (current === undefined) throw new Error("找不到这个供应商");
    const saved = await api.saveCustomProvider({ ...current, models });
    setCustomProviders((items) => items.map((item) => item.id === saved.id ? saved : item));
    customRef.current = customRef.current.map((item) => item.id === saved.id ? saved : item);
    await reload(true);
  }, [reload]);

  const removeCustomModel = useCallback(async (providerId: string, modelId: string) => {
    const current = customRef.current.find((provider) => provider.id === providerId);
    if (current === undefined) return;
    const model = current.models.find((item) => item.id === modelId);
    const wasEnabled = enabledRef.current.has(modelKey(providerId, modelId));
    const previous = current.models;
    try {
      await saveCustomModels(providerId, previous.filter((item) => item.id !== modelId));
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "模型删除失败", "error");
      return;
    }
    toast.showUndo({
      message: `已删除模型 ${displayModelName(model?.name ?? modelId)}`,
      undo: async () => {
        try {
          await saveCustomModels(providerId, previous);
          if (wasEnabled) enableModels(providerId, [modelId]);
        } catch (error) {
          toast.notify(error instanceof Error ? error.message : "撤销失败", "error");
        }
      },
    });
  }, [enableModels, saveCustomModels, toast]);

  const saveCustomConnection = useCallback(async (provider: ManagedProvider, apiKey?: string) => {
    const saved = await api.saveCustomProvider(provider);
    setCustomProviders((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((left, right) => left.id.localeCompare(right.id)));
    if (apiKey !== undefined) await saveApiKey(saved.id, apiKey);
    await reload(true);
    return saved;
  }, [reload, saveApiKey]);

  const saveBuiltinConnection = useCallback(async (provider: ProviderStatus, override: ProviderOverride | undefined, apiKey?: string) => {
    if (override !== undefined) await api.saveProviderOverride(provider.id, override);
    if (apiKey !== undefined) await saveApiKey(provider.id, apiKey);
    await reload(true);
  }, [reload, saveApiKey]);

  const saveKnownApiKey = useCallback(async (provider: ProviderStatus, apiKey: string) => {
    await saveApiKey(provider.id, apiKey);
    await reload(true);
  }, [reload, saveApiKey]);

  const restoreOfficial = useCallback(async (provider: ProviderStatus) => {
    const previous = provider.override;
    try {
      await api.removeProviderOverride(provider.id);
      await reload(true);
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "恢复官方连接失败", "error");
      return;
    }
    toast.showUndo({
      message: `${provider.name} 已恢复官方连接`,
      undo: async () => {
        if (previous === undefined) return;
        try {
          await api.saveProviderOverride(provider.id, previous);
          await reload(true);
        } catch (error) {
          toast.notify(error instanceof Error ? error.message : "撤销失败", "error");
        }
      },
    });
  }, [reload, toast]);

  const clearCredential = useCallback(async (provider: ProviderStatus) => {
    const previousKey = provider.credentialType === "oauth" ? undefined : provider.apiKey;
    try {
      await api.logoutProvider(provider.id);
      await reload(true);
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "操作失败", "error");
      return;
    }
    if (previousKey === undefined || previousKey === "") {
      toast.notify(provider.credentialType === "oauth" ? `已退出 ${provider.name} 的账号` : `已清除 ${provider.name} 的密钥`);
      return;
    }
    toast.showUndo({
      message: `已清除 ${provider.name} 的密钥`,
      undo: async () => {
        try {
          await api.setProviderApiKey(provider.id, previousKey);
          await reload(true);
        } catch (error) {
          toast.notify(error instanceof Error ? error.message : "撤销失败", "error");
        }
      },
    });
  }, [reload, toast]);

  const deleteProvider = useCallback((provider: ManagedProvider) => {
    const unhide = () => setHidden((current) => { const next = new Set(current); next.delete(provider.id); return next; });
    setHidden((current) => new Set([...current, provider.id]));
    toast.showUndo({
      message: `已删除供应商 ${provider.name ?? provider.id}`,
      undo: unhide,
      commit: async () => {
        await api.removeCustomProvider(provider.id);
        await reload(true);
        unhide();
      },
      onCommitError: (error) => {
        unhide();
        toast.notify(error instanceof Error ? error.message : "供应商删除失败", "error");
      },
    });
  }, [reload, toast]);

  const startLogin = useCallback(async (provider: ProviderStatus, type: "api_key" | "oauth") => {
    try {
      setOperation(await api.startLogin(provider.id, type));
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "登录启动失败", "error");
    }
  }, [toast]);

  const customById = useMemo(() => new Map(customProviders.filter((provider) => !hidden.has(provider.id)).map((provider) => [provider.id, provider])), [customProviders, hidden]);
  const visibleProviders = useMemo(() => providers.filter((provider) => isProviderUsable(provider) && !hidden.has(provider.id)), [hidden, providers]);
  const orphanedProviders = useMemo(() => customProviders.filter((provider) => !hidden.has(provider.id) && !providers.some((status) => status.id === provider.id)), [customProviders, hidden, providers]);
  const allModelKeys = useMemo(() => new Set(providers.filter(isProviderUsable).flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id)))), [providers]);
  const unrestricted = allModelKeys.size > 0 && [...allModelKeys].every((key) => enabled.has(key));

  const overlay = operation === undefined ? null : <AuthOperation operation={operation} prompt={operation.prompt} event={operation.event}
    onRespond={(value) => { void api.respondLogin(operation.id, value).then(setOperation); }}
    onCancel={() => { void api.cancelLogin(operation.id).then(setOperation); }}
    onClose={() => setOperation(undefined)} />;

  return {
    providers, visibleProviders, orphanedProviders, customById, enabled, allModelKeys, unrestricted, loading,
    connectedCount: visibleProviders.length,
    reload, toggleModel, enableModels, enableAll, saveCustomModels, removeCustomModel, saveCustomConnection, saveBuiltinConnection,
    saveKnownApiKey, restoreOfficial, clearCredential, deleteProvider, startLogin, overlay,
  };
}

/* ------------------------------------------------------------------ *
 * 模型与供应商（分类页）
 * ------------------------------------------------------------------ */

export function ModelsPage({ ps, onOpenProvider, onAddProvider }: { ps: ProviderSettings; onOpenProvider: (providerId: string) => void; onAddProvider: () => void }) {
  const [search, setSearch] = useState("");
  const enabledCount = [...ps.enabled].filter((key) => ps.allModelKeys.has(key)).length;
  const models = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return ps.visibleProviders.flatMap((provider) => provider.models.map((model) => ({ provider, model })))
      .filter(({ provider, model }) => needle === "" || `${model.name ?? ""}\n${model.id}\n${provider.name}\n${provider.id}`.toLocaleLowerCase().includes(needle));
  }, [ps.visibleProviders, search]);
  const enabledIn = (provider: ProviderStatus) => provider.models.filter((model) => ps.enabled.has(modelKey(provider.id, model.id))).length;
  const empty = ps.visibleProviders.length === 0 && ps.orphanedProviders.length === 0;

  return <>
    <SettingsPageHead title="模型与供应商" description={ps.loading ? "正在读取…" : `已连接 ${String(ps.connectedCount)} 个供应商，启用 ${String(enabledCount)} 个模型。开关立即生效，新开会话可用。`} />
    <SettingsSection id="providers" title="供应商" action={<SectionAction label="添加供应商" onClick={onAddProvider} />}>
      {ps.loading ? <SettingsLoading /> : <SettingsCard>
        {empty ? <SettingsEmptyLine>还没有供应商。添加一个供应商，填上 API Key 就能开始用。</SettingsEmptyLine> : null}
        {ps.visibleProviders.map((provider) => {
          const custom = ps.customById.get(provider.id);
          const status = providerStatusLabel(provider, custom);
          const key = maskApiKey(provider.apiKey);
          const parts = [hostLabel(custom?.baseUrl ?? provider.override?.baseUrl) ?? (custom === undefined ? "官方接口" : undefined), key === undefined ? undefined : `API Key ${key}`, providerModelSummary(provider.models.length, enabledIn(provider))].filter((part): part is string => part !== undefined);
          return <SettingRow key={provider.id} id={`provider-${provider.id}`} leading={<ProviderAvatar id={provider.id} name={providerDisplayName(provider, custom)} />} title={providerDisplayName(provider, custom)} description={parts.join(" · ")}
            control={<SettingsTag tone={status.tone === "ready" ? "ok" : "warn"}>{status.tone === "ready" ? <Check size={11} /> : null}{status.label}</SettingsTag>} onClick={() => onOpenProvider(provider.id)} />;
        })}
        {ps.orphanedProviders.map((provider) => <SettingRow key={provider.id} id={`provider-${provider.id}`} leading={<ProviderAvatar id={provider.id} name={provider.name} />} title={provider.name ?? provider.id}
          description={`${String(provider.models.length)} 个模型 · 还没加载出来，检查连接设置`} control={<SettingsTag tone="warn">未加载</SettingsTag>} onClick={() => onOpenProvider(provider.id)} />)}
      </SettingsCard>}
    </SettingsSection>
    {ps.loading || ps.allModelKeys.size === 0 ? null : <SettingsSection id="enabled-models" title="启用的模型" hint={ps.unrestricted ? "全部可用" : `${String(enabledCount)} / ${String(ps.allModelKeys.size)}`}
      action={<span className="st-inline"><SaveState k="enabled-models" />{ps.unrestricted ? null : <SectionAction label="全部启用" icon={null} onClick={ps.enableAll} />}</span>}>
      <SettingsCard>
        <div className="st-search-row"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="筛选模型或供应商" aria-label="筛选模型" /></div>
        {models.length === 0 ? <SettingsEmptyLine>没有匹配的模型</SettingsEmptyLine> : models.map(({ provider, model }) => {
          const key = modelKey(provider.id, model.id);
          return <SettingRow key={key} id={`model-${provider.id}-${model.id}`} title={displayModelName(model.name ?? model.id)} mono description={modelDetail(model, providerDisplayName(provider, ps.customById.get(provider.id)))}
            control={<><SaveState k={`model:${key}`} /><SettingsSwitch checked={ps.enabled.has(key)} onChange={() => ps.toggleModel(provider.id, model.id)} label={`启用 ${model.id}`} /></>} />;
        })}
      </SettingsCard>
    </SettingsSection>}
    {ps.overlay}
  </>;
}

/* ------------------------------------------------------------------ *
 * 单个供应商：账号 / 连接 / 模型 / 危险操作
 * ------------------------------------------------------------------ */

interface ConnectionDraft {
  name: string;
  baseUrl: string;
  api: ManagedApi;
  authHeader: boolean;
  headers?: Record<string, string>;
  compat?: ManagedCompat;
}

function connectionDraftOf(provider: ProviderStatus | undefined, custom: ManagedProvider | undefined): ConnectionDraft {
  if (custom !== undefined) return { name: custom.name ?? "", baseUrl: custom.baseUrl, api: custom.api, authHeader: custom.authHeader, headers: custom.headers, compat: compactCompat(custom.compat) };
  return { name: "", baseUrl: provider?.override?.baseUrl ?? "", api: "openai-completions", authHeader: true, headers: provider?.override?.headers, compat: compactCompat(provider?.override?.compat) };
}

type ProviderView = { kind: "main" } | { kind: "add" } | { kind: "edit"; model: ManagedModel };

export function ProviderPage({ ps, providerId, onBack }: { ps: ProviderSettings; providerId: string; onBack: () => void }) {
  const provider = ps.providers.find((item) => item.id === providerId);
  const custom = ps.customById.get(providerId);
  const [view, setView] = useState<ProviderView>({ kind: "main" });
  useHistoryBackTrap(view.kind !== "main", () => setView({ kind: "main" }));
  const crumb = { label: "模型与供应商", onClick: onBack };
  if (ps.loading && provider === undefined && custom === undefined) return <><SettingsPageHead crumb={crumb} title="供应商" /><SettingsLoading /></>;
  if (provider === undefined && custom === undefined) return <><SettingsPageHead crumb={crumb} title="供应商" /><SettingsEmptyLine>找不到这个供应商，可能已被删除。</SettingsEmptyLine></>;
  const name = provider === undefined ? (custom?.name ?? providerId) : providerDisplayName(provider, custom);
  const toMain = () => setView({ kind: "main" });
  if (view.kind === "add" && custom !== undefined) return <AddModelsView ps={ps} providerName={name} custom={custom} onDone={toMain} />;
  if (view.kind === "edit" && custom !== undefined) return <EditModelView ps={ps} providerName={name} custom={custom} model={view.model} onDone={toMain} />;

  const status = provider === undefined ? { label: "未加载", tone: "unset" as const } : providerStatusLabel(provider, custom);
  const merged = new Map((provider?.models ?? []).map((model) => [model.id, model]));
  for (const model of custom?.models ?? []) if (!merged.has(model.id)) merged.set(model.id, model);
  const models = [...merged.values()].sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
  const enabledCount = models.filter((model) => ps.enabled.has(modelKey(providerId, model.id))).length;
  const source = provider === undefined ? undefined : authSourceLabel(provider);
  const canClear = provider !== undefined && provider.authConfigured && !isEnvironmentAuth(provider);
  const usable = provider !== undefined && isProviderUsable(provider);

  return <>
    <SettingsPageHead crumb={crumb} title={name}
      extra={<SettingsTag tone={status.tone === "ready" ? "ok" : "warn"}>{status.label}</SettingsTag>}
      description={[custom === undefined ? "内置供应商" : `自定义 · ${apiLabel(custom.api)}`, source].filter(Boolean).join(" · ")} />
    {provider !== undefined && (provider.apiKeyLogin === "login" || (!provider.authConfigured && provider.supportsOAuth)) ? <SettingsSection id="account" title="账号">
      <SettingsCard>
        {provider.apiKeyLogin === "login" ? <SettingRow title={provider.authConfigured ? "重新登录" : "登录"} description="按提示填写账号信息，完成后自动列出可用模型" control={<StButton onClick={() => { void ps.startLogin(provider, "api_key"); }}><KeyRound size={13} />登录</StButton>} /> : null}
        {!provider.authConfigured && provider.supportsOAuth ? <SettingRow title="账号授权登录" description="在浏览器里完成授权，不需要 API Key" control={<StButton variant="primary" onClick={() => { void ps.startLogin(provider, "oauth"); }}><ExternalLink size={13} />去授权</StButton>} /> : null}
      </SettingsCard>
    </SettingsSection> : null}
    <ConnectionSection ps={ps} provider={provider} custom={custom} />
    <SettingsSection id="provider-models" title="模型" hint={providerModelSummary(models.length, enabledCount)} action={custom === undefined ? undefined : <SectionAction label="添加模型" onClick={() => setView({ kind: "add" })} />}>
      <SettingsCard>
        {models.length === 0 ? <SettingsEmptyLine>{usable ? "还没有模型" : "登录或填上 API Key 后会自动列出可用模型"}</SettingsEmptyLine> : models.map((model) => {
          const key = modelKey(providerId, model.id);
          const configured = custom?.models.find((item) => item.id === model.id);
          return <SettingRow key={model.id} id={`model-${providerId}-${model.id}`} title={displayModelName(model.name ?? model.id)} mono description={modelDetail(model)}
            control={<>
              <SaveState k={`model:${key}`} />
              {configured === undefined ? null : <StButton variant="ghost" icon aria-label={`编辑 ${model.id}`} title="编辑模型" onClick={() => setView({ kind: "edit", model: configured })}><Pencil size={14} /></StButton>}
              {configured === undefined ? null : <StButton variant="ghost" icon aria-label={`删除 ${model.id}`} title="删除模型" onClick={() => { void ps.removeCustomModel(providerId, model.id); }}><Trash2 size={14} /></StButton>}
              <SettingsSwitch checked={ps.enabled.has(key)} disabled={!usable} onChange={() => ps.toggleModel(providerId, model.id)} label={`启用 ${model.id}`} />
            </>} />;
        })}
      </SettingsCard>
    </SettingsSection>
    {canClear || custom !== undefined || provider?.override !== undefined ? <SettingsSection id="provider-danger" title="危险操作">
      <SettingsCard>
        {canClear ? <SettingRow danger title={provider.credentialType === "oauth" ? "退出账号" : "清除密钥"} description={provider.credentialType === "oauth" ? "退出后需要重新授权才能使用" : "清除后可以在提示条里撤销"}
          control={<StButton variant="danger" onClick={() => { void ps.clearCredential(provider); }}><LogOut size={13} />{provider.credentialType === "oauth" ? "退出" : "清除"}</StButton>} /> : null}
        {custom === undefined && provider?.override !== undefined ? <SettingRow danger title="恢复官方连接" description="去掉自定义的接口地址和请求头，可以撤销"
          control={<StButton variant="danger" onClick={() => { void ps.restoreOfficial(provider); }}>恢复</StButton>} /> : null}
        {custom !== undefined ? <SettingRow danger title="删除供应商" description="连同它的模型一起删除，8 秒内可以撤销"
          control={<StButton variant="danger" onClick={() => { ps.deleteProvider(custom); onBack(); }}><Trash2 size={13} />删除</StButton>} /> : null}
      </SettingsCard>
    </SettingsSection> : null}
    {ps.overlay}
  </>;
}

/** 连接区块：多字段表单，底部「放弃 / 保存」。 */
function ConnectionSection({ ps, provider, custom }: { ps: ProviderSettings; provider?: ProviderStatus; custom?: ManagedProvider }) {
  const toast = useSettingsToast();
  const initial = useMemo(() => connectionDraftOf(provider, custom), [provider, custom]);
  const initialJson = JSON.stringify(initial);
  const keyEditable = custom !== undefined || (provider?.supportsApiKey === true && provider.apiKeyLogin !== "login" && !isEnvironmentAuth(provider) && provider.authSource !== "runtime");
  const initialKey = provider?.apiKey ?? "";
  const [draft, setDraft] = useState(initial);
  const [apiKey, setApiKey] = useState(initialKey);
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<{ running: boolean; result?: { ok: boolean; text: string } }>({ running: false });
  const dirty = JSON.stringify(draft) !== initialJson || (keyEditable && apiKey !== initialKey);
  const forceSync = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    // 外部刷新时：没在改就跟着刷新；刚保存完也强制同步。
    if (!dirtyRef.current || forceSync.current) {
      forceSync.current = false;
      setDraft(JSON.parse(initialJson) as ConnectionDraft);
      setApiKey(initialKey);
    }
  }, [initialJson, initialKey]);
  const id = custom?.id ?? provider?.id ?? "";
  useDirtyRegistration(`connection:${id}`, dirty);

  const save = async () => {
    setSaving(true);
    try {
      const keyChanged = keyEditable && apiKey !== initialKey ? apiKey.trim() : undefined;
      if (custom !== undefined) {
        await ps.saveCustomConnection({ ...custom, name: draft.name.trim() === "" ? undefined : draft.name.trim(), baseUrl: draft.baseUrl.trim(), api: draft.api, authHeader: draft.authHeader, headers: draft.headers, compat: draft.compat }, keyChanged);
      } else if (provider !== undefined) {
        const overrideChanged = JSON.stringify([draft.baseUrl, draft.headers, draft.compat]) !== JSON.stringify([initial.baseUrl, initial.headers, initial.compat]);
        await ps.saveBuiltinConnection(provider, overrideChanged ? { ...(draft.baseUrl.trim() === "" ? {} : { baseUrl: draft.baseUrl.trim() }), headers: draft.headers, compat: draft.compat } : undefined, keyChanged);
      }
      forceSync.current = true;
      toast.notify("连接已保存");
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "连接保存失败", "error");
    } finally {
      setSaving(false);
    }
  };
  const runCheck = () => {
    setCheck({ running: true });
    void api.fetchProviderModels(id).then((models) => setCheck({ running: false, result: { ok: true, text: `连接正常，接口返回 ${String(models.length)} 个模型` } }))
      .catch((error: unknown) => setCheck({ running: false, result: { ok: false, text: error instanceof Error ? error.message : "连接失败" } }));
  };
  const environmentKey = provider !== undefined && provider.authConfigured && isEnvironmentAuth(provider);

  return <SettingsSection id="connection" title="连接" hint={dirty ? "未保存" : undefined}
    action={<StButton variant="ghost" disabled={check.running || id === ""} title={dirty ? "测试的是已保存的连接" : undefined} onClick={runCheck}>{check.running ? "测试中…" : "测试连接"}</StButton>}>
    <SettingsCard className="st-form">
      {custom === undefined ? null : <SettingsField label="显示名称"><input value={draft.name} placeholder={custom.id} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></SettingsField>}
      <SettingsField id="base-url" label="Base URL（接口地址）" warn={urlWarning(draft.baseUrl)} hint={custom === undefined ? "留空就用官方地址" : undefined}>
        <input value={draft.baseUrl} placeholder={custom === undefined ? "官方默认" : "https://api.example.com/v1"} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} spellCheck={false} />
      </SettingsField>
      {keyEditable ? <ApiKeyField value={apiKey} onChange={setApiKey} placeholder={custom === undefined ? "sk-…" : "没有可以留空"} /> : null}
      {environmentKey ? <SettingsField label="API Key" hint="这里改不了：改环境变量后重启服务"><input value={`来自${authSourceLabel(provider) ?? "环境变量"}`} readOnly /></SettingsField> : null}
      {!keyEditable && !environmentKey && provider?.apiKeyLogin === "login" && (provider.apiKey ?? "") !== "" ? <SettingsField label="API Key" hint="通过上面的「登录」修改"><input value={maskApiKey(provider.apiKey) ?? ""} readOnly /></SettingsField> : null}
      {custom === undefined ? null : <>
        <SettingsField label="接口协议"><select value={draft.api} onChange={(event) => setDraft({ ...draft, api: event.target.value as ManagedApi })}>{API_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></SettingsField>
        <SettingsFormSwitch label="Bearer 认证头" description="用 Authorization: Bearer 发送密钥，大多数接口都需要" checked={draft.authHeader} onChange={(checked) => setDraft({ ...draft, authHeader: checked })} />
      </>}
      <ConnectionExtras api={custom === undefined ? undefined : draft.api} headers={draft.headers} compat={draft.compat} onChange={({ headers, compat }) => setDraft({ ...draft, headers, compat })} />
      {check.result === undefined ? null : <p className={`st-check ${check.result.ok ? "ok" : "err"}`}>{check.result.ok ? <Check size={13} /> : <X size={13} />}{check.result.text}</p>}
    </SettingsCard>
    <DirtyBar show={dirty} saving={saving} message="连接设置有未保存的修改" onDiscard={() => { setDraft(initial); setApiKey(initialKey); }} onSave={() => { void save(); }} />
  </SettingsSection>;
}

function ConnectionExtras({ api: protocol, headers, compat, onChange }: { api?: ManagedApi; headers?: Record<string, string>; compat?: ManagedCompat; onChange: (next: { headers?: Record<string, string>; compat?: ManagedCompat }) => void }) {
  const configured = hasAdvancedConnection(headers, compat);
  const [customMode, setCustomMode] = useState(() => matchingPresetId(compat) === "custom");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => headersFromRecord(headers));
  const headersJson = JSON.stringify(headers ?? {});
  useEffect(() => {
    // 放弃修改 / 外部刷新后把请求头列表同步回来（正在编辑的空行不受影响）。
    setHeaderRows((current) => JSON.stringify(recordFromHeaders(current) ?? {}) === headersJson ? current : headersFromRecord(JSON.parse(headersJson) as Record<string, string>));
  }, [headersJson]);
  const presetId = matchingPresetId(compat);
  const showCustom = customMode || presetId === "custom";
  const commitHeaders = (rows: HeaderRow[]) => {
    setHeaderRows(rows);
    onChange({ compat, headers: recordFromHeaders(rows) });
  };
  const openaiLike = protocol !== "anthropic-messages" && protocol !== "google-generative-ai";
  const anthropicLike = protocol === "anthropic-messages";
  const setCompatField = (patch: ManagedCompat) => {
    const next = { ...compat };
    for (const [key, value] of Object.entries(patch) as Array<[keyof ManagedCompat, ManagedCompat[keyof ManagedCompat]]>) {
      if (value === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    onChange({ headers, compat: compactCompat(next) });
  };
  return <details className="st-advanced" open={configured || undefined}>
    <summary>高级<small>{connectionSummary(headers, compat)}</small></summary>
    <div className="st-advanced-body">
      {protocol === "google-generative-ai" ? null : <SettingsField label="兼容模式" hint="接口不完全兼容时选最接近的一个；拿不准就用「标准」">
        <Segmented label="兼容模式" value={showCustom ? "custom" : presetId} options={[...CONNECTION_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })), { value: "custom", label: "自定义" }]}
          onChange={(value) => {
            if (value === "custom") { setCustomMode(true); return; }
            setCustomMode(false);
            onChange({ headers, compat: CONNECTION_PRESETS.find((preset) => preset.id === value)?.compat });
          }} />
      </SettingsField>}
      {showCustom && openaiLike ? <>
        <SettingsFormSwitch label="开发者角色" description="支持 developer 角色的系统提示" checked={compat?.supportsDeveloperRole !== false} onChange={(checked) => setCompatField({ supportsDeveloperRole: checked ? undefined : false })} />
        <SettingsFormSwitch label="推理力度" description="支持 reasoning_effort 参数" checked={compat?.supportsReasoningEffort !== false} onChange={(checked) => setCompatField({ supportsReasoningEffort: checked ? undefined : false })} />
        <SettingsField label="输出上限字段"><select value={compat?.maxTokensField ?? ""} onChange={(event) => setCompatField({ maxTokensField: event.target.value === "" ? undefined : event.target.value as ManagedMaxTokensField })}><option value="">默认</option><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens</option></select></SettingsField>
        <SettingsField label="思考协议"><select value={compat?.thinkingFormat ?? ""} onChange={(event) => setCompatField({ thinkingFormat: event.target.value === "" ? undefined : event.target.value as ManagedThinkingFormat })}><option value="">默认</option>{THINKING_FORMAT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></SettingsField>
      </> : null}
      {showCustom && anthropicLike ? <>
        <SettingsFormSwitch label="工具流式输出" checked={compat?.supportsEagerToolInputStreaming !== false} onChange={(checked) => setCompatField({ supportsEagerToolInputStreaming: checked ? undefined : false })} />
        <SettingsFormSwitch label="允许空签名" checked={compat?.allowEmptySignature === true} onChange={(checked) => setCompatField({ allowEmptySignature: checked ? true : undefined })} />
      </> : null}
      <SettingsField label="额外请求头" hint={headerRows.length === 0 ? "需要额外的认证或路由头时再加" : undefined}>
        <div className="st-headers">
          {headerRows.map((row) => <div className="st-header-row" key={row.id}>
            <input value={row.name} placeholder="名称" aria-label="请求头名称" onChange={(event) => commitHeaders(headerRows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} />
            <input value={row.value} placeholder="值" aria-label="请求头的值" onChange={(event) => commitHeaders(headerRows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} />
            <StButton variant="ghost" icon aria-label={`删除 ${row.name || "请求头"}`} title="删除" onClick={() => commitHeaders(headerRows.filter((item) => item.id !== row.id))}><Trash2 size={14} /></StButton>
          </div>)}
          {headerRows.length >= 20 ? null : <StButton variant="ghost" className="st-add-line" onClick={() => commitHeaders([...headerRows, { id: `new-${String(Date.now())}`, name: "", value: "" }])}><Plus size={13} />添加请求头</StButton>}
        </div>
      </SettingsField>
    </div>
  </details>;
}

/** 自定义供应商：从接口获取或手动添加模型。 */
function AddModelsView({ ps, providerName, custom, onDone }: { ps: ProviderSettings; providerName: string; custom: ManagedProvider; onDone: () => void }) {
  const toast = useSettingsToast();
  const [fetched, setFetched] = useState<FetchedModel[] | undefined>();
  const [fetchError, setFetchError] = useState<string>();
  const [fetching, setFetching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [reasoning, setReasoning] = useState(false);
  const [vision, setVision] = useState(false);
  const [saving, setSaving] = useState(false);
  const existing = new Set(custom.models.map((model) => model.id));
  const candidates = fetched?.filter((model) => !existing.has(model.id)) ?? [];
  const runFetch = () => {
    setFetching(true);
    setFetchError(undefined);
    void api.fetchProviderModels(custom.id).then((models) => {
      setFetched(models);
      setSelected(new Set(models.filter((model) => !existing.has(model.id)).map((model) => model.id)));
    }).catch((error: unknown) => setFetchError(error instanceof Error ? error.message : "获取失败")).finally(() => setFetching(false));
  };
  const add = async (models: ManagedModel[]) => {
    if (models.length === 0) return;
    setSaving(true);
    try {
      await ps.saveCustomModels(custom.id, [...custom.models, ...models.filter((model) => !existing.has(model.id))]);
      ps.enableModels(custom.id, models.map((model) => model.id));
      toast.notify(`已添加 ${String(models.length)} 个模型`);
      onDone();
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "模型添加失败", "error");
    } finally {
      setSaving(false);
    }
  };
  const manualDuplicate = manualId.trim() !== "" && existing.has(manualId.trim());
  return <>
    <SettingsPageHead crumb={{ label: providerName, onClick: onDone }} title="添加模型" description="从接口读取模型列表，或者手动填写模型 ID。添加后自动启用。" />
    <SettingsSection title="从接口获取" action={<StButton variant="ghost" disabled={fetching} onClick={runFetch}>{fetching ? "获取中…" : fetched === undefined ? "获取模型列表" : "重新获取"}</StButton>}>
      <SettingsCard>
        {fetchError === undefined ? null : <SettingsEmptyLine><span className="st-err-text">{fetchError}</span></SettingsEmptyLine>}
        {fetched === undefined ? (fetchError === undefined ? <SettingsEmptyLine>点「获取模型列表」读取接口上可用的模型。</SettingsEmptyLine> : null)
          : candidates.length === 0 ? <SettingsEmptyLine>获取到的模型都已经添加过了</SettingsEmptyLine>
            : candidates.map((model) => <label className="st-row st-check-row" key={model.id}>
              <input type="checkbox" checked={selected.has(model.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(model.id)) next.delete(model.id); else next.add(model.id); return next; })} />
              <span className="st-row-text"><b>{displayModelName(model.name ?? model.id)}</b>{model.name === undefined || model.name === model.id ? null : <small className="mono">{model.id}</small>}</span>
            </label>)}
      </SettingsCard>
      {candidates.length === 0 ? null : <div className="st-form-actions">
        <SettingsFormSwitch label="支持思考" checked={reasoning} onChange={setReasoning} />
        <SettingsFormSwitch label="支持图片" checked={vision} onChange={setVision} />
        <StButton variant="primary" disabled={selected.size === 0 || saving} onClick={() => { void add(candidates.filter((model) => selected.has(model.id)).map((model) => ({ id: model.id, name: model.name, reasoning, vision }))); }}>添加所选（{String(selected.size)}）</StButton>
      </div>}
    </SettingsSection>
    <SettingsSection title="手动添加">
      <SettingsCard className="st-form">
        <SettingsField label="模型 ID" error={manualDuplicate ? "这个模型已经在列表里了" : undefined}><input value={manualId} onChange={(event) => setManualId(event.target.value)} spellCheck={false} placeholder="例如 gpt-4o-mini" /></SettingsField>
        <SettingsField label="显示名称" hint="可选"><input value={manualName} onChange={(event) => setManualName(event.target.value)} /></SettingsField>
        <SettingsFormSwitch label="支持思考" checked={reasoning} onChange={setReasoning} />
        <SettingsFormSwitch label="支持图片" checked={vision} onChange={setVision} />
        <div className="st-form-actions end"><StButton variant="primary" disabled={manualId.trim() === "" || manualDuplicate || saving} onClick={() => { void add([{ id: manualId.trim(), ...(manualName.trim() === "" ? {} : { name: manualName.trim() }), reasoning, vision }]); }}>添加</StButton></div>
      </SettingsCard>
    </SettingsSection>
  </>;
}

function EditModelView({ ps, providerName, custom, model, onDone }: { ps: ProviderSettings; providerName: string; custom: ManagedProvider; model: ManagedModel; onDone: () => void }) {
  const toast = useSettingsToast();
  const [draft, setDraft] = useState<ManagedModel>({ ...model });
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(model);
  useDirtyRegistration(`model-edit:${custom.id}:${model.id}`, dirty);
  const save = async () => {
    setSaving(true);
    try {
      await ps.saveCustomModels(custom.id, custom.models.map((item) => item.id === model.id ? draft : item));
      toast.notify("模型已保存");
      onDone();
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "模型保存失败", "error");
    } finally {
      setSaving(false);
    }
  };
  const numberOf = (value: string) => value.trim() === "" || !Number.isFinite(Number(value)) ? undefined : Number(value);
  return <>
    <SettingsPageHead crumb={{ label: providerName, onClick: onDone }} title={displayModelName(model.name ?? model.id)} description={<span className="mono">{model.id}</span>} />
    <SettingsSection>
      <SettingsCard className="st-form">
        <SettingsField label="显示名称"><input value={draft.name ?? ""} placeholder={model.id} onChange={(event) => setDraft({ ...draft, name: event.target.value === "" ? undefined : event.target.value })} /></SettingsField>
        <SettingsField label="上下文窗口" hint="单位 token，留空自动"><input inputMode="numeric" value={draft.contextWindow ?? ""} placeholder="自动" onChange={(event) => setDraft({ ...draft, contextWindow: numberOf(event.target.value) })} /></SettingsField>
        <SettingsField label="最大输出" hint="单位 token，留空自动"><input inputMode="numeric" value={draft.maxTokens ?? ""} placeholder="自动" onChange={(event) => setDraft({ ...draft, maxTokens: numberOf(event.target.value) })} /></SettingsField>
        <SettingsFormSwitch label="支持思考" checked={draft.reasoning} onChange={(checked) => setDraft({ ...draft, reasoning: checked })} />
        <SettingsFormSwitch label="支持图片" checked={draft.vision} onChange={(checked) => setDraft({ ...draft, vision: checked })} />
      </SettingsCard>
    </SettingsSection>
    <DirtyBar show={dirty} saving={saving} onDiscard={() => setDraft({ ...model })} onSave={() => { void save(); }} />
  </>;
}

/* ------------------------------------------------------------------ *
 * 添加供应商向导
 * ------------------------------------------------------------------ */

type ProviderStage =
  | { kind: "pick" }
  | { kind: "known"; providerId: string }
  | { kind: "custom-protocol" }
  | { kind: "custom-connection" };

export function ProviderNewPage({ ps, onBack, onCreated }: { ps: ProviderSettings; onBack: () => void; onCreated: (providerId: string) => void }) {
  const toast = useSettingsToast();
  const [stage, setStage] = useState<ProviderStage>({ kind: "pick" });
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<ManagedProvider>({ ...EMPTY_PROVIDER, models: [] });
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const stepBack = () => setStage(stage.kind === "custom-connection" ? { kind: "custom-protocol" } : { kind: "pick" });
  useHistoryBackTrap(stage.kind !== "pick", stepBack);
  const formDirty = stage.kind === "custom-connection" && (provider.id !== "" || provider.baseUrl !== "" || apiKey !== "");
  useDirtyRegistration("provider-new", formDirty);
  const pickerProviders = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return ps.providers.filter((item) => !item.custom && (needle === "" || `${item.name}\n${item.id}`.toLocaleLowerCase().includes(needle)));
  }, [ps.providers, search]);
  const known = stage.kind === "known" ? ps.providers.find((item) => item.id === stage.providerId) : undefined;
  const trimmedId = provider.id.trim();
  // 重复 ID 会覆盖别的供应商，这是少数必须拦下的情况。
  const idTaken = trimmedId !== "" && (ps.providers.some((item) => item.id === trimmedId) || ps.customById.has(trimmedId));
  const crumb = { label: "模型与供应商", onClick: onBack };

  const createCustom = async () => {
    setSaving(true);
    try {
      const name = provider.name?.trim();
      const saved = await ps.saveCustomConnection({ ...provider, id: trimmedId, baseUrl: provider.baseUrl.trim(), name: name === undefined || name === "" ? undefined : name }, apiKey.trim() === "" ? undefined : apiKey.trim());
      toast.notify("供应商已添加，接着选择要用的模型");
      setProvider({ ...EMPTY_PROVIDER, models: [] });
      setApiKey("");
      onCreated(saved.id);
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "供应商保存失败", "error");
    } finally {
      setSaving(false);
    }
  };
  const saveKnown = async (target: ProviderStatus) => {
    setSaving(true);
    try {
      await ps.saveKnownApiKey(target, apiKey.trim());
      toast.notify(`${target.name} 已连接`);
      onCreated(target.id);
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "API Key 保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  if (stage.kind === "known" && known !== undefined) return <>
    <SettingsPageHead crumb={crumb} title={`连接 ${known.name}`} description={`${known.id} · ${String(known.models.length)} 个模型${known.authConfigured ? " · 已配置" : ""}`} />
    {known.supportsApiKey && known.apiKeyLogin !== "login" ? <SettingsSection>
      <SettingsCard className="st-form">
        <ApiKeyField value={apiKey} onChange={setApiKey} placeholder="粘贴 API Key" />
        <div className="st-form-actions end"><StButton variant="ghost" onClick={stepBack}>上一步</StButton><StButton variant="primary" disabled={saving || apiKey.trim() === ""} onClick={() => { void saveKnown(known); }}>{saving ? "保存中…" : "保存并连接"}</StButton></div>
      </SettingsCard>
    </SettingsSection> : null}
    {known.apiKeyLogin === "login" || known.supportsOAuth ? <SettingsSection title="登录">
      <SettingsCard>
        {known.apiKeyLogin === "login" ? <SettingRow title="填写账号信息登录" control={<StButton onClick={() => { void ps.startLogin(known, "api_key"); }}><KeyRound size={13} />登录</StButton>} /> : null}
        {known.supportsOAuth ? <SettingRow title="账号授权" description="在浏览器里完成授权，不需要 API Key" control={<StButton variant="primary" onClick={() => { void ps.startLogin(known, "oauth"); }}><ExternalLink size={13} />去授权</StButton>} /> : null}
      </SettingsCard>
    </SettingsSection> : null}
    {ps.overlay}
  </>;

  if (stage.kind === "custom-protocol") return <>
    <SettingsPageHead crumb={crumb} title="自定义供应商" description="第 1 步：选择接口协议。不确定就选 OpenAI Completions，大多数兼容服务都支持。" />
    <SettingsSection>
      <SettingsCard>
        {API_OPTIONS.map((option) => <SettingRow key={option.id} title={option.label} description={option.description} onClick={() => { setProvider({ ...provider, api: option.id }); setStage({ kind: "custom-connection" }); }}
          control={provider.api === option.id ? <SettingsTag tone="acc"><Check size={11} />当前</SettingsTag> : undefined} />)}
      </SettingsCard>
    </SettingsSection>
  </>;

  if (stage.kind === "custom-connection") return <>
    <SettingsPageHead crumb={crumb} title="自定义供应商" description={`第 2 步：连接信息 · ${apiLabel(provider.api)}`} />
    <SettingsSection>
      <SettingsCard className="st-form">
        <SettingsField label="ID" hint="内部标识，创建后不能修改" error={idTaken ? "这个 ID 已经被别的供应商用了" : undefined}><input value={provider.id} autoFocus spellCheck={false} placeholder="例如 my-proxy" onChange={(event) => setProvider({ ...provider, id: event.target.value })} /></SettingsField>
        <SettingsField label="显示名称" hint="可选"><input value={provider.name ?? ""} onChange={(event) => setProvider({ ...provider, name: event.target.value })} /></SettingsField>
        <SettingsField label="Base URL（接口地址）" warn={urlWarning(provider.baseUrl)}><input value={provider.baseUrl} spellCheck={false} placeholder="https://api.example.com/v1" onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} /></SettingsField>
        <ApiKeyField value={apiKey} onChange={setApiKey} placeholder="没有可以留空" />
        <SettingsFormSwitch label="Bearer 认证头" description="用 Authorization: Bearer 发送密钥，大多数接口都需要" checked={provider.authHeader} onChange={(checked) => setProvider({ ...provider, authHeader: checked })} />
        <ConnectionExtras api={provider.api} headers={provider.headers} compat={provider.compat} onChange={({ headers, compat }) => setProvider({ ...provider, headers, compat })} />
        <div className="st-form-actions end">
          <StButton variant="ghost" onClick={stepBack}>上一步</StButton>
          <StButton variant="primary" disabled={saving || trimmedId === "" || idTaken} onClick={() => { void createCustom(); }}>{saving ? "保存中…" : "添加供应商"}</StButton>
        </div>
      </SettingsCard>
    </SettingsSection>
  </>;

  return <>
    <SettingsPageHead crumb={crumb} title="添加供应商" description="选一个内置供应商填上 API Key，或者接入任何兼容 OpenAI / Anthropic 协议的服务。" />
    <SettingsSection>
      <SettingsCard>
        <div className="st-search-row"><Search size={14} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索供应商" aria-label="搜索供应商" /></div>
        <SettingRow className="accent" leading={<span className="st-row-icon acc"><Plus size={15} /></span>} title="自定义供应商" description="自建代理、本地模型（Ollama / LM Studio）或其他兼容服务" onClick={() => { setApiKey(""); setStage({ kind: "custom-protocol" }); }} />
        {pickerProviders.map((item) => <SettingRow key={item.id} leading={<ProviderAvatar id={item.id} name={item.name} />} title={item.name} description={`${item.id} · ${String(item.models.length)} 个模型`}
          control={item.authConfigured ? <SettingsTag tone="ok"><Check size={11} />已配置</SettingsTag> : undefined}
          onClick={() => { setApiKey(item.apiKey ?? ""); setStage({ kind: "known", providerId: item.id }); }} />)}
        {pickerProviders.length === 0 ? <SettingsEmptyLine>没有匹配的供应商，可以用「自定义供应商」接入</SettingsEmptyLine> : null}
      </SettingsCard>
    </SettingsSection>
    {ps.overlay}
  </>;
}

/** OAuth/API Key 登录过程必须覆盖在当前页之上。 */
export function AuthOperation({ operation, prompt, event, onRespond, onCancel, onClose }: { operation: AuthLoginOperation; prompt: AuthLoginOperation["prompt"]; event: AuthLoginOperation["event"]; onRespond: (value: string) => void; onCancel: () => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const options = useMemo(() => prompt?.options ?? [], [prompt?.options]);
  return <div className="auth-operation-overlay"><div className="auth-operation">
    <div className="st-sec-head"><h2>{operation.state === "completed" ? "登录完成" : operation.state === "failed" ? "登录失败" : operation.state === "cancelled" ? "登录已取消" : "正在登录"}</h2><StButton variant="ghost" icon aria-label="取消登录" title="取消登录" onClick={operation.state === "running" ? onCancel : onClose}><X size={15} /></StButton></div>
    {event?.message ? <p className="auth-event">{event.message}</p> : null}
    {event?.url ? <a className="auth-link" href={event.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开授权页面</a> : null}
    {operation.error ? <SettingsBanner>{operation.error}</SettingsBanner> : null}
    {operation.state === "running" && prompt ? <form className="auth-prompt" onSubmit={(submitEvent) => {
      submitEvent.preventDefault();
      if (value.trim() !== "") {
        onRespond(value);
        setValue("");
      }
    }}>{prompt.type === "select" ? <div className="auth-options">{options.map((option) => <button type="button" key={option.id} onClick={() => onRespond(option.id)}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</div> : <><label>{prompt.message}<input autoFocus type={prompt.type === "secret" ? "password" : "text"} placeholder={prompt.placeholder} value={value} onChange={(inputEvent) => setValue(inputEvent.target.value)} /></label><StButton type="submit" variant="primary" disabled={value.trim() === ""}>提交</StButton></>}</form> : null}
    {operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" ? <StButton variant="primary" onClick={onClose}>关闭</StButton> : null}
  </div></div>;
}
