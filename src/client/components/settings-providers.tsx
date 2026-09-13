import { useMemo, useState } from "react";
import { Boxes, Check, ExternalLink, KeyRound, LogOut, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { AuthLoginOperation, EnabledModelsStatus, FetchedModel, ManagedApi, ManagedCompat, ManagedMaxTokensField, ManagedModel, ManagedProvider, ManagedThinkingFormat, ProviderOverride, ProviderStatus } from "../../shared/protocol";
import { displayModelName } from "../model-display";
import { Button } from "./ui/button";
import { SettingsEmpty, SettingsForm, SettingsFormSection, SettingsFormSwitch, SettingsGroup, SettingsRow, SettingsSubpage, SettingsSwitch } from "./settings-ui";

export const EMPTY_PROVIDER: ManagedProvider = { id: "", baseUrl: "", api: "openai-completions", authHeader: true, models: [] };

const API_OPTIONS: Array<{ id: ManagedApi; label: string }> = [
  { id: "openai-completions", label: "OpenAI Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
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

type ProviderStage =
  | { kind: "pick" }
  | { kind: "known"; provider: ProviderStatus }
  | { kind: "custom-protocol" }
  | { kind: "custom-connection" };

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

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function apiLabel(api: string): string {
  return API_OPTIONS.find((option) => option.id === api)?.label ?? api;
}

function hostLabel(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === "") return undefined;
  return url.replace(/^https?:\/\//u, "");
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
  if (headerCount > 0) parts.push(`${String(headerCount)} 个头`);
  return parts.length === 0 ? "默认" : parts.join(" · ");
}

export function ProviderAvatar({ id, name }: { id: string; name?: string }) {
  return <span aria-hidden className="provider-avatar" style={providerAvatarStyle(id)}>{(name ?? id).slice(0, 1).toUpperCase()}</span>;
}

function ProviderStatusChip({ provider, custom }: { provider: ProviderStatus; custom?: ManagedProvider }) {
  return <span className={`provider-chip ${provider.authConfigured ? "ready" : "unset"}`}>
    {provider.authConfigured ? <><Check size={12} />{provider.authSource ?? "已配置"}</> : custom !== undefined ? "仅配置" : "未登录"}
  </span>;
}

interface ProvidersListPageProps {
  providers: ProviderStatus[];
  customProviders: ManagedProvider[];
  customById: Map<string, ManagedProvider>;
  enabledDraft: Set<string>;
  loading: boolean;
  showAll: boolean;
  unrestricted: boolean;
  onShowAllChange: (value: boolean) => void;
  onOpenScope: () => void;
  onOpenProvider: (providerId: string) => void;
  onEditCustom: (provider: ManagedProvider) => void;
  onAddProvider: () => void;
  onBack: () => void;
}

/** 供应商总览：范围控制 + 供应商分组行，详情进入子页。 */
export function ProvidersListPage({ providers, customProviders, customById, enabledDraft, loading, showAll, unrestricted, onShowAllChange, onOpenScope, onOpenProvider, onEditCustom, onAddProvider, onBack }: ProvidersListPageProps) {
  const visibleProviders = useMemo(() => {
    const enabled = providers.filter(isProviderUsable);
    return showAll ? providers : enabled;
  }, [providers, showAll]);
  const orphanedProviders = useMemo(() => customProviders.filter((provider) => !providers.some((status) => status.id === provider.id)), [customProviders, providers]);
  const providerEnabledCounts = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.models.filter((model) => enabledDraft.has(modelKey(provider.id, model.id))).length])), [providers, enabledDraft]);
  const empty = visibleProviders.length === 0 && orphanedProviders.length === 0;

  return <SettingsSubpage title="供应商与账号" onBack={onBack}>
    <div className="settings-stack">
      {loading ? <p className="settings-page-note">正在读取供应商…</p> : <>
        <SettingsGroup>
          <SettingsRow icon={Boxes} label="模型范围" value={unrestricted ? "全部可用" : `已启用 ${String(enabledDraft.size)}`} chevron onClick={onOpenScope} />
          <SettingsRow icon={Boxes} label="显示全部供应商" control={<SettingsSwitch checked={showAll} onChange={onShowAllChange} label="显示全部供应商" />} />
        </SettingsGroup>
        {empty ? <SettingsEmpty icon={KeyRound} title="还没有供应商" actionLabel="添加供应商" onAction={onAddProvider} /> : <SettingsGroup>
          {visibleProviders.map((provider) => <ProviderListRow key={provider.id} provider={provider} custom={customById.get(provider.id)} enabledCount={providerEnabledCounts.get(provider.id) ?? 0} onOpen={() => onOpenProvider(provider.id)} />)}
          {orphanedProviders.map((provider) => <button type="button" className="settings-row settings-provider-row" key={provider.id} onClick={() => onEditCustom(provider)}>
            <ProviderAvatar id={provider.id} name={provider.name} />
            <span className="settings-row-main"><strong>{provider.name ?? provider.id}</strong><small>{provider.models.length} 个模型 · 未加载</small></span>
            <span className="settings-row-value">编辑</span>
          </button>)}
          <SettingsRow icon={Plus} label="添加供应商" accent chevron onClick={onAddProvider} />
        </SettingsGroup>}
      </>}
    </div>
  </SettingsSubpage>;
}

function ProviderListRow({ provider, custom, enabledCount, onOpen }: { provider: ProviderStatus; custom?: ManagedProvider; enabledCount: number; onOpen: () => void }) {
  const configuredCount = custom?.models.length ?? 0;
  const modelCount = configuredCount > 0 ? configuredCount : provider.models.length;
  const endpoint = hostLabel(custom?.baseUrl ?? provider.override?.baseUrl);
  const summary = modelCount === 0
    ? "未加载"
    : custom !== undefined
      ? `${String(modelCount)} 个模型`
      : enabledCount >= modelCount ? `全部 ${String(modelCount)} 个模型可用` : `${String(enabledCount)}/${String(modelCount)} 个模型已启用`;
  return <button type="button" className="settings-row settings-provider-row" onClick={onOpen}>
    <ProviderAvatar id={provider.id} name={custom?.name ?? provider.name} />
    <span className="settings-row-main"><strong>{custom?.name ?? provider.name}</strong><small>{summary}{endpoint === undefined ? "" : ` · ${endpoint}`}</small></span>
    <ProviderStatusChip provider={provider} custom={custom} />
  </button>;
}

interface ProviderDetailPageProps {
  provider: ProviderStatus;
  custom?: ManagedProvider;
  draft: Set<string>;
  busy?: string;
  onToggleModel: (providerId: string, modelId: string) => void;
  onEnableModels: (providerId: string, modelIds: string[]) => void;
  onCustomModels: (providerId: string, models: ManagedModel[]) => Promise<boolean>;
  onLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => void;
  onLogout: (provider: ProviderStatus) => void;
  onEdit: () => void;
  onFetch: (providerId: string) => Promise<FetchedModel[]>;
  onBack: () => void;
}

/** 单个供应商子页，模型添加/编辑在本页的次级视图内完成。 */
export function ProviderDetailPage({ provider, custom, draft, busy, onToggleModel, onEnableModels, onCustomModels, onLogin, onLogout, onEdit, onFetch, onBack }: ProviderDetailPageProps) {
  const [view, setView] = useState<"list" | "add" | "edit">("list");
  const [editModel, setEditModel] = useState<ManagedModel | undefined>();
  const [addSearch, setAddSearch] = useState("");
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());
  const [fetched, setFetched] = useState<FetchedModel[] | undefined>();
  const [fetching, setFetching] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualIdError, setManualIdError] = useState<string | undefined>();
  const [addReasoning, setAddReasoning] = useState(false);
  const [addVision, setAddVision] = useState(false);
  const modelBusy = busy === "model-manager";
  const accountBusy = busy === provider.id;

  const addedModels = useMemo(() => (custom?.models ?? provider.models)
    .filter((model) => custom !== undefined || draft.has(modelKey(provider.id, model.id)))
    .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id)), [provider, custom, draft]);
  const addCandidates = useMemo(() => {
    if (custom !== undefined) {
      if (fetched === undefined) return [];
      const configuredIds = new Set(custom.models.map((model) => model.id));
      return fetched.filter((model) => !configuredIds.has(model.id));
    }
    const needle = addSearch.trim().toLocaleLowerCase();
    return provider.models
      .filter((model) => !draft.has(modelKey(provider.id, model.id)))
      .filter((model) => needle === "" || `${model.name ?? ""}\n${model.id}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
  }, [provider, custom, fetched, draft, addSearch]);
  const customModelById = useMemo(() => new Map(custom?.models.map((model) => [model.id, model]) ?? []), [custom]);

  const openAddModels = () => {
    setAddSelected(new Set());
    setFetched(undefined);
    setAddSearch("");
    setView("add");
  };
  const applyFetched = (models: FetchedModel[]) => {
    setFetched(models);
    const configuredIds = new Set(custom?.models.map((model) => model.id) ?? []);
    setAddSelected(new Set(models.filter((model) => !configuredIds.has(model.id)).map((model) => modelKey(provider.id, model.id))));
  };
  const addSelectedModels = () => {
    const additions = fetched?.filter((model) => addSelected.has(modelKey(provider.id, model.id))) ?? [];
    const apply = async (): Promise<boolean> => {
      if (custom !== undefined && additions.length > 0) {
        const existing = new Set(custom.models.map((model) => model.id));
        const merged = [...custom.models, ...additions.filter((model) => !existing.has(model.id)).map((model) => ({ id: model.id, name: model.name, reasoning: addReasoning, vision: addVision }))];
        return onCustomModels(provider.id, merged);
      }
      return true;
    };
    void apply().then((ok) => {
      if (!ok) return;
      onEnableModels(provider.id, additions.map((model) => model.id));
      setView("list");
      setAddSelected(new Set());
      setFetched(undefined);
      setAddSearch("");
    });
  };
  const addManualModel = () => {
    const id = manualId.trim();
    if (id === "" || custom === undefined) return;
    if (custom.models.some((model) => model.id === id)) {
      setManualIdError(`模型 "${id}" 已存在`);
      return;
    }
    void onCustomModels(provider.id, [...custom.models, { id, ...(manualName.trim() ? { name: manualName.trim() } : {}), reasoning: addReasoning, vision: addVision }]).then((ok) => {
      if (!ok) return;
      onEnableModels(provider.id, [id]);
      setManualId("");
      setManualName("");
    });
  };
  const removeModel = (modelId: string) => {
    if (custom !== undefined) void onCustomModels(provider.id, custom.models.filter((model) => model.id !== modelId));
    else onToggleModel(provider.id, modelId);
  };
  const saveEdit = () => {
    if (custom === undefined || editModel === undefined) return;
    void onCustomModels(provider.id, custom.models.map((model) => model.id === editModel.id ? editModel : model)).then((ok) => {
      if (ok) {
        setEditModel(undefined);
        setView("list");
      }
    });
  };

  const title = view === "add" ? "添加模型" : view === "edit" ? "编辑模型" : custom?.name ?? provider.name;
  const handleBack = view === "list" ? onBack : () => { setEditModel(undefined); setView("list"); };
  const modelTitle = custom === undefined
    ? `模型 · 已启用 ${String(addedModels.length)}/${String(provider.models.length)}`
    : `模型 · 已配置 ${String(addedModels.length)}`;

  return <SettingsSubpage title={title} onBack={handleBack} action={view === "edit" && editModel !== undefined ? <button type="button" className="settings-topbar-action" disabled={modelBusy} onClick={saveEdit}>保存</button> : undefined}>
    {view === "list" ? <div className="settings-stack">
      <SettingsGroup>
        <div className="settings-account">
          <ProviderAvatar id={provider.id} name={custom?.name ?? provider.name} />
          <div className="settings-account-main"><strong>{custom?.name ?? provider.name}</strong><small>{custom?.baseUrl === undefined ? (provider.override?.baseUrl === undefined ? provider.id : `${provider.override.baseUrl}`) : `${custom.baseUrl} · ${apiLabel(custom.api)}`}</small></div>
          <ProviderStatusChip provider={provider} custom={custom} />
        </div>
      </SettingsGroup>
      <SettingsGroup>
        {provider.authConfigured ? <SettingsRow icon={LogOut} label="退出登录" danger disabled={accountBusy} onClick={() => onLogout(provider)} /> : <>
          {provider.supportsApiKey ? <SettingsRow icon={KeyRound} label="使用 API Key 登录" disabled={accountBusy} onClick={() => onLogin(provider, "api_key")} /> : null}
          {provider.supportsOAuth ? <SettingsRow icon={ExternalLink} label="账号授权登录" disabled={accountBusy} onClick={() => onLogin(provider, "oauth")} /> : null}
        </>}
        <SettingsRow icon={Pencil} label="编辑连接" chevron onClick={onEdit} />
      </SettingsGroup>
      <SettingsGroup title={modelTitle}>
        {addedModels.length === 0 ? <div className="settings-model-empty">尚未添加模型</div> : addedModels.map((model) => {
          const configured = customModelById.get(model.id);
          const detail = `${model.id}${model.reasoning ? " · 思考" : ""}${model.vision ? " · 图片" : ""}`;
          return custom === undefined ? <div className="settings-row settings-model-row" key={model.id}>
            <span className="settings-row-main"><strong>{displayModelName(model.name ?? model.id)}</strong><small>{detail}</small></span>
            <SettingsSwitch checked={draft.has(modelKey(provider.id, model.id))} disabled={modelBusy} onChange={() => onToggleModel(provider.id, model.id)} label={`启用 ${model.id}`} />
          </div> : <div className="settings-row settings-model-row" key={model.id}>
            <button type="button" className="settings-row-main settings-row-main-button" onClick={() => { setEditModel(configured ?? { ...model }); setView("edit"); }}>
              <strong>{displayModelName(model.name ?? model.id)}</strong><small>{detail}</small>
            </button>
            <Button variant="ghost" size="icon" aria-label={`移除 ${model.id}`} title="移除模型" disabled={modelBusy} onClick={() => removeModel(model.id)}><Trash2 size={15} /></Button>
          </div>;
        })}
        <SettingsRow icon={Plus} label="添加模型" accent disabled={modelBusy || (custom === undefined && provider.models.length === 0)} onClick={openAddModels} />
      </SettingsGroup>
    </div> : null}
    {view === "add" && custom === undefined ? <SettingsForm>
      <label className="provider-picker-search"><Search size={14} /><input autoFocus value={addSearch} onChange={(event) => setAddSearch(event.target.value)} placeholder="搜索模型" /></label>
      {addCandidates.length === 0 ? <div className="model-empty">没有可添加的模型</div> : <SettingsFormSection>
        {addCandidates.map((model) => {
          const key = modelKey(provider.id, model.id);
          const selected = addSelected.has(key);
          return <label className="settings-checkbox pick-model-item" key={key}><input type="checkbox" checked={selected} onChange={() => setAddSelected((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })} /><span><strong>{displayModelName(model.name ?? model.id)}</strong>{model.name === undefined || model.name === model.id ? null : <small>{model.id}</small>}</span></label>;
        })}
      </SettingsFormSection>}
      {addSelected.size === 0 ? null : <button type="button" className="settings-form-link" disabled={modelBusy} onClick={() => {
        onEnableModels(provider.id, [...addSelected].map((key) => splitModelKey(key).id));
        setView("list");
      }}>启用所选（{String(addSelected.size)}）</button>}
    </SettingsForm> : null}
    {view === "add" && custom !== undefined ? <SettingsForm>
      <button type="button" className="settings-form-link" disabled={fetching || modelBusy} onClick={() => {
        setFetching(true);
        void onFetch(provider.id).then(applyFetched).catch(() => { setFetched(undefined); }).finally(() => setFetching(false));
      }}>{fetching ? "获取中…" : fetched === undefined ? "从接口获取模型" : `已获取 ${String(fetched.length)}`}</button>
      {fetched === undefined ? null : <SettingsFormSection title={addCandidates.length === 0 ? "获取到的模型都已添加" : undefined}>
        {addCandidates.length === 0 ? null : addCandidates.map((model) => {
          const key = modelKey(provider.id, model.id);
          const selected = addSelected.has(key);
          return <label className="settings-checkbox pick-model-item" key={key}><input type="checkbox" checked={selected} onChange={() => setAddSelected((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })} /><span><strong>{displayModelName(model.name ?? model.id)}</strong>{model.name === undefined || model.name === model.id ? null : <small>{model.id}</small>}</span></label>;
        })}
      </SettingsFormSection>}
      {fetched === undefined || addSelected.size === 0 ? null : <SettingsFormSection>
        <SettingsFormSwitch label="思考" checked={addReasoning} onChange={setAddReasoning} />
        <SettingsFormSwitch label="图片" checked={addVision} onChange={setAddVision} />
        <button type="button" className="settings-form-link" disabled={modelBusy} onClick={addSelectedModels}>添加所选（{String(addSelected.size)}）</button>
      </SettingsFormSection>}
      <SettingsFormSection title="手动添加">
        <label className="settings-form-field"><span>模型 ID</span><input value={manualId} aria-invalid={manualIdError !== undefined} onChange={(event) => { setManualId(event.target.value); setManualIdError(undefined); }} />{manualIdError === undefined ? null : <small className="field-error">{manualIdError}</small>}</label>
        <label className="settings-form-field"><span>显示名称</span><input value={manualName} onChange={(event) => setManualName(event.target.value)} /></label>
        <SettingsFormSwitch label="思考" checked={addReasoning} onChange={setAddReasoning} />
        <SettingsFormSwitch label="图片" checked={addVision} onChange={setAddVision} />
        <button type="button" className="settings-form-link" disabled={manualId.trim() === "" || modelBusy} onClick={addManualModel}>添加</button>
      </SettingsFormSection>
    </SettingsForm> : null}
    {view === "edit" && editModel !== undefined ? <SettingsForm>
      <SettingsFormSection>
        <label className="settings-form-field"><span>模型 ID</span><input value={editModel.id} disabled /></label>
        <label className="settings-form-field"><span>显示名称</span><input value={editModel.name ?? ""} onChange={(event) => setEditModel({ ...editModel, name: event.target.value || undefined })} /></label>
        <label className="settings-form-field"><span>上下文窗口</span><input type="number" min={1} value={editModel.contextWindow ?? ""} onChange={(event) => setEditModel({ ...editModel, contextWindow: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label>
        <label className="settings-form-field"><span>最大输出</span><input type="number" min={1} value={editModel.maxTokens ?? ""} onChange={(event) => setEditModel({ ...editModel, maxTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label>
        <SettingsFormSwitch label="思考" checked={editModel.reasoning} onChange={(checked) => setEditModel({ ...editModel, reasoning: checked })} />
        <SettingsFormSwitch label="图片" checked={editModel.vision} onChange={(checked) => setEditModel({ ...editModel, vision: checked })} />
      </SettingsFormSection>
    </SettingsForm> : null}
  </SettingsSubpage>;
}

interface ModelScopePageProps {
  providers: ProviderStatus[];
  customById: Map<string, ManagedProvider>;
  draft: Set<string>;
  busy: boolean;
  onToggleModel: (providerId: string, modelId: string) => void;
  onBack: () => void;
}

/** 跨供应商模型白名单页；所有切换即时保存。 */
export function ModelScopePage({ providers, customById, draft, busy, onToggleModel, onBack }: ModelScopePageProps) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => providers.filter(isProviderUsable).map((provider) => ({
    provider,
    models: provider.models.filter((model) => search.trim() === "" || `${model.name ?? ""}\n${model.id}\n${provider.name}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),
  })).filter((group) => group.models.length > 0), [providers, search]);

  return <SettingsSubpage title="模型范围" onBack={onBack}>
    <div className="settings-stack">
      <label className="provider-picker-search"><Search size={14} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索供应商或模型" /></label>
      {groups.length === 0 ? <div className="model-empty">没有匹配的模型</div> : groups.map((group) => <SettingsGroup key={group.provider.id} title={customById.get(group.provider.id)?.name ?? group.provider.name}>
        {group.models.map((model) => <div className="settings-row settings-model-row" key={model.id}>
          <span className="settings-row-main"><strong>{displayModelName(model.name ?? model.id)}</strong>{model.name === undefined || model.name === model.id ? null : <small>{model.id}</small>}</span>
          <SettingsSwitch checked={draft.has(modelKey(group.provider.id, model.id))} disabled={busy} onChange={() => onToggleModel(group.provider.id, model.id)} label={`启用 ${model.id}`} />
        </div>)}
      </SettingsGroup>)}
    </div>
  </SettingsSubpage>;
}

interface ProviderWizardPageProps {
  providers: ProviderStatus[];
  editing?: ManagedProvider;
  busy: boolean;
  onSave: (provider: ManagedProvider, openModelsAfterSave: boolean) => Promise<void>;
  onDelete?: (provider: ManagedProvider) => void;
  onLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => void;
  onFetch?: (providerId: string) => Promise<FetchedModel[]>;
  onBack: () => void;
}

/** 添加/编辑供应商：保留原有步骤，但不再使用对话框。 */
export function ProviderWizardPage({ providers, editing, busy, onSave, onDelete, onLogin, onFetch, onBack }: ProviderWizardPageProps) {
  const [provider, setProvider] = useState<ManagedProvider>(() => editing === undefined
    ? { ...EMPTY_PROVIDER, models: [] }
    : { ...editing, models: editing.models.map((model) => ({ ...model })) });
  const [stage, setStage] = useState<ProviderStage>(() => editing === undefined ? { kind: "pick" } : { kind: "custom-connection" });
  const [search, setSearch] = useState("");
  const detailsValid = provider.id.trim() !== "" && isValidHttpUrl(provider.baseUrl);
  const idAvailable = editing !== undefined || !providers.some((item) => item.id === provider.id.trim());
  const pickerProviders = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return providers.filter((item) => needle === "" || `${item.name}\n${item.id}`.toLocaleLowerCase().includes(needle));
  }, [providers, search]);
  const title = editing !== undefined ? "编辑供应商" : stage.kind === "pick" ? "添加供应商" : stage.kind === "known" ? "登录供应商" : stage.kind === "custom-protocol" ? "选择接口" : "连接信息";
  const goBack = () => {
    if (editing !== undefined || stage.kind === "pick") {
      onBack();
      return;
    }
    if (stage.kind === "known" || stage.kind === "custom-protocol") setStage({ kind: "pick" });
    else setStage({ kind: "custom-protocol" });
  };

  const check = useConnectionCheck(editing?.id, onFetch);
  return <SettingsSubpage title={title} onBack={goBack} action={stage.kind === "custom-connection" ? <>
    {check.available ? <button type="button" className="settings-topbar-action muted" disabled={busy || check.checking} onClick={check.run}>{check.checking ? "检查中…" : check.result?.ok === true ? check.result.text : "检查连接"}</button> : null}
    <button type="button" className="settings-topbar-action" disabled={busy || !detailsValid || !idAvailable} onClick={() => { void onSave(provider, editing === undefined); }}>{busy ? "保存中…" : "保存"}</button>
  </> : undefined}>
    {stage.kind === "pick" ? <div className="settings-stack">
      <label className="provider-picker-search"><Search size={14} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索供应商" /></label>
      <div className="api-choice-list provider-picker-list">
        <button type="button" className="api-choice provider-picker-custom" onClick={() => setStage({ kind: "custom-protocol" })}><span><strong>自定义供应商</strong></span><Plus size={16} /></button>
        {pickerProviders.map((item) => {
          const configured = item.authConfigured || item.custom;
          return <button type="button" key={item.id} className={`api-choice ${configured ? "provider-picker-configured" : ""}`} onClick={() => setStage({ kind: "known", provider: item })}>
            <span><strong>{item.name}</strong><small>{item.id} · {String(item.models.length)} 个模型{configured ? " · 已配置" : ""}</small></span>
            {configured ? <span className="status-ready"><Check size={13} />已配置</span> : null}
          </button>;
        })}
      </div>
    </div> : null}
    {stage.kind === "known" ? <div className="settings-stack">
      <div className="api-choice provider-known-head"><span><strong>{stage.provider.name}</strong><small>{stage.provider.id} · {String(stage.provider.models.length)} 个模型</small></span></div>
      <div className="dialog-actions">
        {stage.provider.supportsApiKey ? <Button disabled={busy} onClick={() => { onLogin(stage.provider, "api_key"); onBack(); }}><KeyRound size={14} />API Key</Button> : null}
        {stage.provider.supportsOAuth ? <Button disabled={busy} onClick={() => { onLogin(stage.provider, "oauth"); onBack(); }}><ExternalLink size={14} />登录</Button> : null}
      </div>
    </div> : null}
    {stage.kind === "custom-protocol" ? <div className="settings-stack">
      <div className="api-choice-list">{API_OPTIONS.map((option) => <button type="button" key={option.id} className={`api-choice ${provider.api === option.id ? "selected" : ""}`} onClick={() => setProvider({ ...provider, api: option.id })}>
        <span><strong>{option.label}</strong></span>{provider.api === option.id ? <Check size={16} /> : null}
      </button>)}</div>
      <div className="dialog-actions"><Button onClick={() => setStage({ kind: "custom-connection" })}>下一步</Button></div>
    </div> : null}
    {stage.kind === "custom-connection" ? <SettingsForm>
      <SettingsFormSection>
        <label className="settings-form-field"><span>ID</span><input value={provider.id} disabled={editing !== undefined} autoFocus={editing === undefined} onChange={(event) => setProvider({ ...provider, id: event.target.value })} aria-invalid={!idAvailable} />{idAvailable ? null : <small className="field-error">该 ID 已被使用</small>}</label>
        <label className="settings-form-field"><span>显示名称</span><input value={provider.name ?? ""} onChange={(event) => setProvider({ ...provider, name: event.target.value || undefined })} /></label>
        <label className="settings-form-field"><span>Base URL</span><input value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" aria-invalid={provider.baseUrl.trim() !== "" && !isValidHttpUrl(provider.baseUrl)} />{provider.baseUrl.trim() === "" || isValidHttpUrl(provider.baseUrl) ? null : <small className="field-error">需要合法的 http(s) 地址</small>}</label>
        <label className="settings-form-field"><span>接口协议</span><select value={provider.api} onChange={(event) => setProvider({ ...provider, api: event.target.value as ManagedApi })}>{API_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <SettingsFormSwitch label="Bearer Authorization" checked={provider.authHeader} onChange={(checked) => setProvider({ ...provider, authHeader: checked })} />
      </SettingsFormSection>
      <ConnectionExtras api={provider.api} headers={provider.headers} compat={provider.compat} onChange={({ headers, compat }) => setProvider({ ...provider, headers, compat })} />
      {check.result === undefined || check.result.ok ? null : <p className="field-error">{check.result.text}</p>}
      {editing === undefined || onDelete === undefined ? null : <button type="button" className="settings-form-link danger" onClick={() => onDelete(editing)}>删除供应商</button>}
    </SettingsForm> : null}
  </SettingsSubpage>;
}

interface BuiltinOverridePageProps {
  provider: ProviderStatus;
  busy: boolean;
  onSave: (override: ProviderOverride) => Promise<void>;
  onClear: () => Promise<void>;
  onFetch?: (providerId: string) => Promise<FetchedModel[]>;
  onBack: () => void;
}

/** 内置供应商连接覆盖：只改 URL / 头 / compat，不碰官方模型目录。 */
export function BuiltinOverridePage({ provider, busy, onSave, onClear, onFetch, onBack }: BuiltinOverridePageProps) {
  const [baseUrl, setBaseUrl] = useState(provider.override?.baseUrl ?? "");
  const [headers, setHeaders] = useState<Record<string, string> | undefined>(provider.override?.headers);
  const [compat, setCompat] = useState<ManagedCompat | undefined>(provider.override?.compat);
  const urlValid = baseUrl.trim() === "" || isValidHttpUrl(baseUrl);
  const hasOverride = provider.override !== undefined;
  const check = useConnectionCheck(provider.id, onFetch);
  return <SettingsSubpage title="编辑连接" onBack={onBack} action={<>
    {check.available ? <button type="button" className="settings-topbar-action muted" disabled={busy || check.checking} onClick={check.run}>{check.checking ? "检查中…" : check.result?.ok === true ? check.result.text : "检查连接"}</button> : null}
    <button type="button" className="settings-topbar-action" disabled={busy || !urlValid} onClick={() => { void onSave({ ...(baseUrl.trim() === "" ? {} : { baseUrl: baseUrl.trim() }), headers, compat }); }}>{busy ? "保存中…" : "保存"}</button>
  </>}>
    <SettingsForm>
      <SettingsFormSection>
        <label className="settings-form-field"><span>Base URL</span><input value={baseUrl} autoFocus onChange={(event) => setBaseUrl(event.target.value)} placeholder="官方默认" aria-invalid={!urlValid} />{urlValid ? null : <small className="field-error">需要合法的 http(s) 地址</small>}</label>
      </SettingsFormSection>
      <ConnectionExtras headers={headers} compat={compat} onChange={({ headers: nextHeaders, compat: nextCompat }) => { setHeaders(nextHeaders); setCompat(nextCompat); }} />
      {check.result === undefined || check.result.ok ? null : <p className="field-error">{check.result.text}</p>}
      {hasOverride ? <button type="button" className="settings-form-link danger" disabled={busy} onClick={() => { void onClear(); }}>恢复官方连接</button> : null}
    </SettingsForm>
  </SettingsSubpage>;
}

function useConnectionCheck(providerId: string | undefined, onFetch?: (providerId: string) => Promise<FetchedModel[]>) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | undefined>();
  const available = providerId !== undefined && onFetch !== undefined;
  const run = () => {
    if (providerId === undefined || onFetch === undefined) return;
    setChecking(true);
    void onFetch(providerId).then((models) => {
      setResult({ ok: true, text: `已获取 ${String(models.length)}` });
    }).catch((error: unknown) => {
      setResult({ ok: false, text: error instanceof Error ? error.message : "连接失败" });
    }).finally(() => setChecking(false));
  };
  return { available, checking, result, run };
}

function ConnectionExtras({ api, headers, compat, onChange }: { api?: ManagedApi; headers?: Record<string, string>; compat?: ManagedCompat; onChange: (next: { headers?: Record<string, string>; compat?: ManagedCompat }) => void }) {
  const configured = hasAdvancedConnection(headers, compat);
  const [open, setOpen] = useState(configured);
  const [customMode, setCustomMode] = useState(() => matchingPresetId(compat) === "custom");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => headersFromRecord(headers));
  const presetId = matchingPresetId(compat);
  const showCustom = customMode || presetId === "custom";
  const commitHeaders = (rows: HeaderRow[]) => {
    setHeaderRows(rows);
    onChange({ compat, headers: recordFromHeaders(rows) });
  };
  const openaiLike = api !== "anthropic-messages" && api !== "google-generative-ai";
  const anthropicLike = api === "anthropic-messages";
  const setCompatField = (patch: ManagedCompat) => {
    const next = { ...compat };
    for (const [key, value] of Object.entries(patch) as Array<[keyof ManagedCompat, ManagedCompat[keyof ManagedCompat]]>) {
      if (value === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    onChange({ headers, compat: compactCompat(next) });
  };
  return <SettingsFormSection title="高级" extra={connectionSummary(headers, compat)} onTitleClick={() => setOpen((current) => !current)}>
    {open ? <>
      {api === "google-generative-ai" ? null : <div className="connection-preset-list">{CONNECTION_PRESETS.map((preset) => <button type="button" key={preset.id} className={`connection-preset ${!showCustom && presetId === preset.id ? "selected" : ""}`} onClick={() => { setCustomMode(false); onChange({ headers, compat: preset.compat }); }}>{preset.label}</button>)}<button type="button" className={`connection-preset ${showCustom ? "selected" : ""}`} onClick={() => setCustomMode(true)}>自定义</button></div>}
      {showCustom && openaiLike ? <>
        <SettingsFormSwitch label="开发者角色" checked={compat?.supportsDeveloperRole !== false} onChange={(checked) => setCompatField({ supportsDeveloperRole: checked ? undefined : false })} />
        <SettingsFormSwitch label="推理力度" checked={compat?.supportsReasoningEffort !== false} onChange={(checked) => setCompatField({ supportsReasoningEffort: checked ? undefined : false })} />
        <label className="settings-form-field"><span>输出上限字段</span><select value={compat?.maxTokensField ?? ""} onChange={(event) => setCompatField({ maxTokensField: event.target.value === "" ? undefined : event.target.value as ManagedMaxTokensField })}><option value="">默认</option><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens</option></select></label>
        <label className="settings-form-field"><span>思考协议</span><select value={compat?.thinkingFormat ?? ""} onChange={(event) => setCompatField({ thinkingFormat: event.target.value === "" ? undefined : event.target.value as ManagedThinkingFormat })}><option value="">默认</option>{THINKING_FORMAT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      </> : null}
      {showCustom && anthropicLike ? <>
        <SettingsFormSwitch label="工具流式输出" checked={compat?.supportsEagerToolInputStreaming !== false} onChange={(checked) => setCompatField({ supportsEagerToolInputStreaming: checked ? undefined : false })} />
        <SettingsFormSwitch label="允许空签名" checked={compat?.allowEmptySignature === true} onChange={(checked) => setCompatField({ allowEmptySignature: checked ? true : undefined })} />
      </> : null}
      {headerRows.map((row) => <div className="connection-header-row" key={row.id}>
        <div className="connection-header-name">
          <input value={row.name} placeholder="请求头" onChange={(event) => commitHeaders(headerRows.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} />
          <Button variant="ghost" size="icon" aria-label={`删除 ${row.name || "请求头"}`} title="删除" onClick={() => commitHeaders(headerRows.filter((item) => item.id !== row.id))}><Trash2 size={14} /></Button>
        </div>
        <input value={row.value} placeholder="值" onChange={(event) => commitHeaders(headerRows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))} />
      </div>)}
      {headerRows.length >= 20 ? null : <button type="button" className="settings-form-link" onClick={() => commitHeaders([...headerRows, { id: `new-${String(Date.now())}`, name: "", value: "" }])}>请求头</button>}
    </> : null}
  </SettingsFormSection>;
}

/** OAuth/API Key 登录过程必须覆盖在当前页之上。 */
export function AuthOperation({ operation, prompt, event, onRespond, onCancel, onClose }: { operation: AuthLoginOperation; prompt: AuthLoginOperation["prompt"]; event: AuthLoginOperation["event"]; onRespond: (value: string) => void; onCancel: () => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const options = useMemo(() => prompt?.options ?? [], [prompt?.options]);
  return <div className="auth-operation-overlay"><div className="auth-operation">
    <div className="settings-section-heading"><h2>{operation.state === "completed" ? "登录完成" : operation.state === "failed" ? "登录失败" : operation.state === "cancelled" ? "登录已取消" : "正在登录"}</h2><Button variant="ghost" size="icon" aria-label="取消登录" title="取消登录" onClick={operation.state === "running" ? onCancel : onClose}><X size={15} /></Button></div>
    {event?.message ? <p className="auth-event">{event.message}</p> : null}
    {event?.url ? <a className="auth-link" href={event.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开授权页面</a> : null}
    {operation.error ? <p className="settings-error">{operation.error}</p> : null}
    {operation.state === "running" && prompt ? <form className="auth-prompt" onSubmit={(submitEvent) => {
      submitEvent.preventDefault();
      if (value.trim() !== "") {
        onRespond(value);
        setValue("");
      }
    }}>{prompt.type === "select" ? <div className="auth-options">{options.map((option) => <button type="button" key={option.id} onClick={() => onRespond(option.id)}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</div> : <><label>{prompt.message}<input autoFocus type={prompt.type === "secret" ? "password" : "text"} placeholder={prompt.placeholder} value={value} onChange={(inputEvent) => setValue(inputEvent.target.value)} /></label><Button type="submit" disabled={value.trim() === ""}>提交</Button></>}</form> : null}
    {operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" ? <Button onClick={onClose}>关闭</Button> : null}
  </div></div>;
}
