import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Boxes, Check, ChevronRight, CircleAlert, CheckCircle2, ExternalLink, FolderPlus, Globe, KeyRound, LogOut, LucideIcon, Pencil, Plus, RotateCw, Save, Search, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import type { AppSettings, AuthLoginOperation, AuthStatus, EnabledModelsStatus, FetchedModel, ManagedModel, ManagedProvider, ProviderStatus, Workspace } from "../../shared/protocol";
import { api, notifyUnauthorized } from "../api";
import { isNotificationEnabled, requestNotificationPermission, setNotificationEnabled } from "../notifications";
import { displayModelName } from "../model-display";
import { Button } from "./ui/button";
import { WorkspaceDialog } from "./workspace-dialog";
import { Dialog, DialogContent } from "./ui/dialog";
import { TunnelPanel } from "./tunnel-panel";

interface SettingsPageProps {
  assistantName: string;
  onAssistantNameChange: (name: string) => void;
  workspaces: Workspace[];
  onWorkspacesChange: (workspaces: Workspace[]) => void;
  onAddWorkspace: (path: string, label?: string) => Promise<void>;
  onRemoveWorkspace: (workspace: Workspace) => Promise<void>;
  onBack: () => void;
}

type SettingsTab = "general" | "providers" | "workspaces" | "tunnel" | "security";
type SettingsMessageTone = "success" | "error";
/** 添加供应商向导的阶段：选择已知供应商 / 已知供应商登录 / 自定义协议 / 自定义连接信息。 */
type ProviderStage =
  | { kind: "pick" }
  | { kind: "known"; provider: ProviderStatus }
  | { kind: "custom-protocol" }
  | { kind: "custom-connection" };
const EMPTY_PROVIDER: ManagedProvider = { id: "", baseUrl: "", api: "openai-completions", authHeader: true, models: [] };
const API_OPTIONS: Array<{ id: ManagedProvider["api"]; label: string; description: string }> = [
  { id: "openai-completions", label: "OpenAI Completions", description: "兼容 OpenAI Chat Completions 接口" },
  { id: "openai-responses", label: "OpenAI Responses", description: "使用 OpenAI Responses 接口" },
  { id: "anthropic-messages", label: "Anthropic Messages", description: "兼容 Anthropic Messages 接口" },
  { id: "google-generative-ai", label: "Google Generative AI", description: "使用 Google Generative AI 接口" },
];

function modelKey(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
}
function splitModelKey(key: string): { provider: string; id: string } {
  const separator = key.indexOf("\u0000");
  return { provider: key.slice(0, separator), id: key.slice(separator + 1) };
}
/** 品牌头像底色：由供应商 ID 稳定生成色相。 */
function providerAvatarStyle(id: string): { background: string } {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 360;
  return { background: `linear-gradient(135deg, hsl(${String(hash)} 62% 46%), hsl(${String((hash + 40) % 360)} 58% 38%))` };
}
function isValidHttpUrl(value: string): boolean {
  try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; }
  catch { return false; }
}
function apiLabel(api: string): string {
  return API_OPTIONS.find((option) => option.id === api)?.label ?? api;
}
/** 供应商账号状态胶囊（详情页/列表行共用样式语义）。 */
function statusChip(provider: ProviderStatus, custom: ManagedProvider | undefined) {
  return <span className={`provider-chip ${provider.authConfigured ? "ready" : "unset"}`}>{provider.authConfigured ? <><Check size={12} />{provider.authSource ?? "已配置"}</> : custom !== undefined ? "仅配置" : "未登录"}</span>;
}
/** 模型启用草稿：patterns 为空 = 不限制（全部启用），否则为选中集合。 */
function initializeDraft(providers: ProviderStatus[], enabled: EnabledModelsStatus): Set<string> {
  if (enabled.patterns.length === 0) return new Set(providers.flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id))));
  return new Set(enabled.resolved.map((ref) => modelKey(ref.provider, ref.id)));
}

export function SettingsPage({ assistantName, workspaces, onWorkspacesChange, onAddWorkspace, onRemoveWorkspace, onAssistantNameChange, onBack }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [name, setName] = useState(assistantName);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(() => isNotificationEnabled());
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [customProviders, setCustomProviders] = useState<ManagedProvider[]>([]);
  const [enabledDraft, setEnabledDraft] = useState<Set<string>>(new Set());
  const [providersShowAll, setProvidersShowAll] = useState(false);
  const [managerTarget, setManagerTarget] = useState<ProviderStatus | undefined>();
  const [provider, setProvider] = useState<ManagedProvider>({ ...EMPTY_PROVIDER });
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [providerStage, setProviderStage] = useState<ProviderStage>({ kind: "pick" });
  const [editingProvider, setEditingProvider] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [messageTone, setMessageTone] = useState<SettingsMessageTone>("success");
  const [operation, setOperation] = useState<AuthLoginOperation | undefined>();
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState<string | undefined>();
  const [workspaceRemoveTarget, setWorkspaceRemoveTarget] = useState<Workspace | undefined>();
  const [providerRemoveTarget, setProviderRemoveTarget] = useState<ManagedProvider | undefined>();
  /** 全局模型范围管理（总览条入口）。 */
  const [globalModelsOpen, setGlobalModelsOpen] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const showMessage = (nextMessage: string, tone: SettingsMessageTone = "success") => { setMessageTone(tone); setMessage(nextMessage); };
  useEffect(() => {
    if (message === undefined) return;
    const timer = window.setTimeout(() => setMessage(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const reload = async () => {
    setLoading(true);
    try {
      const [available, custom, enabled] = await Promise.all([api.providers(), api.customProviders(), api.enabledModels()]);
      setProviders(available);
      setCustomProviders(custom);
            setEnabledDraft(initializeDraft(available, enabled));
    } catch (error) { showMessage(error instanceof Error ? error.message : "无法加载设置", "error"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    if (operation === undefined || operation.state !== "running") return;
    const timer = window.setInterval(() => {
      void api.loginStatus(operation.id).then((next) => { setOperation(next); if (next.state === "completed") void reload(); }).catch((error: unknown) => showMessage(error instanceof Error ? error.message : "登录状态读取失败", "error"));
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation?.id, operation?.state]);

  const saveName = async () => {
    setBusy("name");
    try { const settings: AppSettings = await api.updateSettings({ assistantName: name }); onAssistantNameChange(settings.assistantName); setName(settings.assistantName); showMessage("已保存"); }
    catch (error) { showMessage(error instanceof Error ? error.message : "名称保存失败", "error"); }
    finally { setBusy(undefined); }
  };
  const restart = async () => {
    setRestartConfirmOpen(false); setRestarting(true);
    try { await api.selfRestart(); showMessage("正在重启，连接将短暂中断…"); }
    catch (error) { setRestarting(false); showMessage(error instanceof Error ? error.message : "重启请求失败", "error"); }
  };
  const startLogin = async (target: ProviderStatus, type: "api_key" | "oauth") => {
    setProviderDialogOpen(false);
    setBusy(target.id);
    try { setOperation(await api.startLogin(target.id, type)); }
    catch (error) { showMessage(error instanceof Error ? error.message : "登录启动失败", "error"); }
    finally { setBusy(undefined); }
  };
  const logout = async (target: ProviderStatus) => {
    setBusy(target.id);
    try { await api.logoutProvider(target.id); await reload(); showMessage(`已退出 ${target.name}`); }
    catch (error) { showMessage(error instanceof Error ? error.message : "退出登录失败", "error"); }
    finally { setBusy(undefined); }
  };
  const openNewProvider = () => {
    setProvider({ ...EMPTY_PROVIDER, models: [] }); setEditingProvider(false); setProviderStage({ kind: "pick" }); setProviderSearch(""); setProviderDialogOpen(true);
  };
  const openEditProvider = (target: ManagedProvider) => {
    setProvider({ ...target, models: target.models.map((model) => ({ ...model })) }); setEditingProvider(true); setProviderStage({ kind: "custom-connection" }); setProviderDialogOpen(true);
  };
  const saveProvider = async (options?: { openModelsAfterSave?: boolean }) => {
    setBusy("provider");
    try {
      const saved = await api.saveCustomProvider(provider);
      setCustomProviders((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.id.localeCompare(b.id)));
      setProviderDialogOpen(false);
      showMessage(saved.models.length === 0 ? "供应商已保存" : "供应商和模型配置已保存");
      await reload();
      // 新建供应商后直接进入模型管理，省去再找行内按钮的步骤。
      if (options?.openModelsAfterSave === true && saved.models.length === 0) {
        const refreshed = await api.providers();
        setProviders(refreshed);
        const target = refreshed.find((item) => item.id === saved.id);
        if (target !== undefined) setManagerTarget(target);
      }
    } catch (error) { showMessage(error instanceof Error ? error.message : "供应商保存失败", "error"); }
    finally { setBusy(undefined); }
  };
  const removeProvider = async () => {
    const target = providerRemoveTarget;
    if (target === undefined || busy !== undefined) return;
    setBusy(target.id);
    try {
      await api.removeCustomProvider(target.id);
      setCustomProviders((current) => current.filter((item) => item.id !== target.id));
      setProviderRemoveTarget(undefined);
      showMessage("供应商已删除");
      await reload();
    } catch (error) { showMessage(error instanceof Error ? error.message : "供应商删除失败", "error"); }
    finally { setBusy(undefined); }
  };
  /** 启用集合即时持久化：全选折叠为不限制；全部取消被阻止并提示。 */
  const persistEnabled = async (next: Set<string>): Promise<boolean> => {
    const allKeys = new Set(providers.flatMap((item) => item.models.map((model) => modelKey(item.id, model.id))));
    if (next.size === 0 && allKeys.size > 0) { showMessage("请至少启用一个模型", "error"); return false; }
    setBusy("model-manager");
    try {
      const unrestricted = allKeys.size > 0 && next.size === allKeys.size;
      const status = await api.updateEnabledModels(unrestricted ? [] : [...next].map((key) => splitModelKey(key)));
      setEnabledDraft(initializeDraft(providers, status));
      return true;
    } catch (error) { showMessage(error instanceof Error ? error.message : "模型保存失败", "error"); await reload(); return false; }
    finally { setBusy(undefined); }
  };
  /** 自定义供应商模型清单即时持久化；被移除的模型同步退出启用集合。 */
  const persistCustomModels = async (providerId: string, models: ManagedModel[]): Promise<boolean> => {
    const current = customProviders.find((item) => item.id === providerId);
    if (current === undefined) return false;
    setBusy("model-manager");
    try {
      const saved = await api.saveCustomProvider({ ...current, models });
      setCustomProviders((items) => items.map((item) => item.id === saved.id ? saved : item));
      const removedKeys = new Set(current.models.filter((model) => !models.some((candidate) => candidate.id === model.id)).map((model) => modelKey(providerId, model.id)));
      if (removedKeys.size > 0) {
        const next = new Set([...enabledDraft].filter((key) => !removedKeys.has(key)));
        setEnabledDraft(next);
        await persistEnabled(next);
      }
      return true;
    } catch (error) { showMessage(error instanceof Error ? error.message : "模型保存失败", "error"); return false; }
    finally { setBusy(undefined); }
  };
  const toggleModelInstant = (providerId: string, modelId: string) => {
    const key = modelKey(providerId, modelId);
    const next = new Set(enabledDraft);
    if (next.has(key)) next.delete(key); else next.add(key);
    setEnabledDraft(next);
    void persistEnabled(next);
  };
  /** 批量启用（从接口获取/手动添加后自动进入选择器）。 */
  const enableModelsInstant = (providerId: string, modelIds: string[]) => {
    if (modelIds.length === 0) return;
    const next = new Set(enabledDraft);
    for (const id of modelIds) next.add(modelKey(providerId, id));
    setEnabledDraft(next);
    void persistEnabled(next);
  };
  const moveWorkspace = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= workspaces.length || workspaceBusy !== undefined) return;
    const next = [...workspaces]; const [item] = next.splice(index, 1); if (item === undefined) return;
    next.splice(targetIndex, 0, item); setWorkspaceBusy("order");
    try { onWorkspacesChange(await api.reorderWorkspaces(next.map((workspace) => workspace.id))); showMessage("工作区顺序已保存"); }
    catch (error) { showMessage(error instanceof Error ? error.message : "工作区排序失败", "error"); }
    finally { setWorkspaceBusy(undefined); }
  };
  const removeWorkspace = async () => {
    const workspace = workspaceRemoveTarget;
    if (workspace === undefined || workspaceBusy !== undefined) return;
    setWorkspaceBusy(workspace.id);
    try { await onRemoveWorkspace(workspace); setWorkspaceRemoveTarget(undefined); showMessage("工作区已删除"); }
    catch (error) { showMessage(error instanceof Error ? error.message : "工作区删除失败", "error"); }
    finally { setWorkspaceBusy(undefined); }
  };
  const toggleNotifications = async (enabled: boolean) => {
    if (enabled) { const permission = await requestNotificationPermission(); if (permission !== "granted") return; setNotificationEnabled(true); setNotificationsEnabledState(true); return; }
    setNotificationEnabled(false); setNotificationsEnabledState(false);
  };

  const customById = useMemo(() => new Map(customProviders.map((item) => [item.id, item])), [customProviders]);
  // 供应商列表：默认只看已启用的（有凭据或有自定义配置）。
  const visibleProviders = useMemo(() => {
    const enabled = providers.filter((item) => item.authConfigured || item.custom);
    return providersShowAll ? providers : enabled;
  }, [providers, providersShowAll]);
  const hiddenProviderCount = providers.length - visibleProviders.length;
  // 每个供应商「已添加」模型数量（全局启用集合 ∩ 供应商模型）。
  const providerEnabledCounts = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.models.filter((model) => enabledDraft.has(modelKey(provider.id, model.id))).length])), [providers, enabledDraft]);
  const pickerProviders = useMemo(() => {
    const needle = providerSearch.trim().toLocaleLowerCase();
    return providers.filter((item) => needle === "" || `${item.name}\n${item.id}`.toLocaleLowerCase().includes(needle));
  }, [providers, providerSearch]);
  // 全局启用状态：patterns 为空 = 不限制。
  const allModelKeys = useMemo(() => new Set(providers.flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id)))), [providers]);
  const unrestricted = enabledDraft.size >= allModelKeys.size && [...allModelKeys].every((key) => enabledDraft.has(key));

  const openProviderDetail = (status: ProviderStatus) => setManagerTarget(status);

  const currentStage = providerStage.kind;
  const providerDialogTitle = editingProvider ? "编辑供应商" : currentStage === "pick" ? "添加供应商" : currentStage === "known" ? "登录供应商" : currentStage === "custom-protocol" ? "选择接口" : "连接信息";
  return <section className="settings-page">
    <header className="settings-header"><Button variant="ghost" size="icon" aria-label="返回会话" title="返回会话" onClick={onBack}><X size={18} /></Button><h1>设置</h1></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" className={tab === "general" ? "selected" : ""} onClick={() => setTab("general")}><Settings2 size={16} />常规</button>
        <button type="button" className={tab === "providers" ? "selected" : ""} onClick={() => setTab("providers")}><KeyRound size={16} />供应商与账号</button>
        <button type="button" className={tab === "workspaces" ? "selected" : ""} onClick={() => setTab("workspaces")}><FolderPlus size={16} />工作区</button>
        <button type="button" className={tab === "security" ? "selected" : ""} onClick={() => setTab("security")}><ShieldCheck size={16} />安全</button>
        <button type="button" className={tab === "tunnel" ? "selected" : ""} onClick={() => setTab("tunnel")}><Globe size={16} />内网穿透</button>
      </nav>
      <main className="settings-content">
        {message === undefined ? null : <div className={`settings-toast ${messageTone}`} role={messageTone === "error" ? "alert" : "status"}><span className="settings-toast-icon">{messageTone === "error" ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}</span><span>{message}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage(undefined)}><X size={14} /></button></div>}
        {tab === "general" ? <section className="settings-section"><h2>常规</h2><label className="settings-field"><span>助手名称</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveName(); }} /></label><Button onClick={() => { void saveName(); }} disabled={busy === "name" || name.trim() === ""}><Save size={15} />保存名称</Button><label className="settings-field settings-checkbox"><input type="checkbox" checked={notificationsEnabled} onChange={(event) => { void toggleNotifications(event.target.checked); }} /><span>会话运行结束时弹出通知（页面在后台时）</span></label><div className="settings-section-heading"><h2>服务</h2></div><p className="settings-muted">重启服务会短暂中断所有连接（自动重连恢复），仅加载现有构建，不会编译。</p><Button variant="danger" disabled={restarting} onClick={() => setRestartConfirmOpen(true)}><RotateCw size={15} />{restarting ? "正在重启…" : "重启服务"}</Button></section> : null}
        {tab === "providers" ? <section className="settings-section"><div className="settings-section-heading"><div><h2>供应商与账号</h2><p className="settings-muted">统一管理连接凭据、供应商接口和可用模型。</p></div><Button size="sm" onClick={openNewProvider}><Plus size={14} />添加供应商</Button></div>{loading ? <p className="settings-muted">正在读取供应商…</p> : <><button type="button" className="scope-strip" onClick={() => setGlobalModelsOpen(true)}><Boxes size={16} /><span className="scope-strip-main"><strong>{unrestricted ? "模型范围：全部可用" : `模型范围：已启用 ${String(enabledDraft.size)} 个模型`}</strong><small>{unrestricted ? "未设置白名单，所有供应商的模型都在选择器中 · 点击调整" : "按白名单显示 · 点击统一勾选"}</small></span><ChevronRight size={15} /></button><label className="settings-checkbox settings-show-all"><input type="checkbox" checked={providersShowAll} onChange={(event) => setProvidersShowAll(event.target.checked)} /><span>{providersShowAll ? "隐藏未启用的供应商" : `显示全部供应商（${String(hiddenProviderCount)} 个未启用）`}</span></label>{visibleProviders.length === 0 && customProviders.length === 0 ? <EmptyState icon={KeyRound} title="还没有供应商" hint="登录官方账号，或添加任意 OpenAI 兼容接口" actionLabel="添加供应商" onAction={openNewProvider} /> : <div className="provider-list">{visibleProviders.map((item) => <ProviderRow key={item.id} status={item} custom={customById.get(item.id)} enabledCount={providerEnabledCounts.get(item.id) ?? 0} busy={busy} onOpen={openProviderDetail} onEdit={openEditProvider} onRemove={setProviderRemoveTarget} />)}{customProviders.filter((item) => !providers.some((status) => status.id === item.id)).map((item) => <article className="provider-row" key={item.id}><span className="provider-avatar" style={providerAvatarStyle(item.id)}>{(item.name ?? item.id).slice(0, 1).toUpperCase()}</span><div className="provider-main"><strong>{item.name ?? item.id}</strong><small>{item.models.length} 个模型 · 未加载（运行时不可用）</small></div><div className="provider-status"><Button variant="secondary" size="sm" onClick={() => openEditProvider(item)}>编辑</Button><Button variant="ghost" size="icon" aria-label={`删除 ${item.id}`} title="删除供应商" disabled={busy === item.id} onClick={() => setProviderRemoveTarget(item)}><Trash2 size={15} /></Button></div></article>)}</div>}</>}</section> : null}
        {tab === "workspaces" ? <section className="settings-section"><div className="settings-section-heading"><h2>工作区</h2><Button size="sm" onClick={() => setWorkspaceDialogOpen(true)}><FolderPlus size={14} />添加工作区</Button></div>{workspaces.length === 0 ? <EmptyState icon={FolderPlus} title="还没有工作区" hint="添加本地目录，为每个项目维护独立会话" actionLabel="添加工作区" onAction={() => setWorkspaceDialogOpen(true)} /> : <div className="provider-list">{workspaces.map((workspace, index) => <article className="provider-row workspace-settings-row" key={workspace.id}><div className="provider-main"><strong>{workspace.label}</strong><small>{workspace.cwd}</small></div><div className="provider-status workspace-settings-actions"><Button variant="ghost" size="icon" aria-label="上移工作区" title="上移" disabled={index === 0 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, -1); }}><ArrowUp size={15} /></Button><Button variant="ghost" size="icon" aria-label="下移工作区" title="下移" disabled={index === workspaces.length - 1 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, 1); }}><ArrowDown size={15} /></Button><Button variant="ghost" size="icon" aria-label={`删除工作区 ${workspace.label}`} title="删除工作区" disabled={workspaceBusy !== undefined} onClick={() => setWorkspaceRemoveTarget(workspace)}><Trash2 size={15} /></Button></div></article>)}</div>}</section> : null}
        {tab === "tunnel" ? <TunnelPanel onMessage={(nextMessage, tone) => showMessage(nextMessage, tone)} /> : null}
        {tab === "security" ? <SecurityPanel onMessage={(nextMessage, tone) => showMessage(nextMessage, tone)} /> : null}
      </main>
    </div>
    <Dialog open={providerDialogOpen} onOpenChange={(open) => { if (!open && busy !== "provider") setProviderDialogOpen(false); }}><DialogContent className="provider-dialog" title={providerDialogTitle} description={providerDialogDescription(providerStage, editingProvider)}><ProviderWizard providers={pickerProviders} provider={provider} stage={providerStage} editing={editingProvider} busy={busy === "provider"} search={providerSearch} onSearchChange={setProviderSearch} onChange={setProvider} onStageChange={setProviderStage} onCancel={() => setProviderDialogOpen(false)} onLogin={startLogin} onSave={(openModels) => { void saveProvider(openModels === true ? { openModelsAfterSave: true } : undefined); }} /></DialogContent></Dialog>
    {managerTarget === undefined ? null : <ProviderDetailDialog provider={managerTarget} custom={customById.get(managerTarget.id)} draft={enabledDraft} busy={busy === "model-manager"} onToggleModel={toggleModelInstant} onEnableModels={enableModelsInstant} onCustomModels={persistCustomModels} onLogin={startLogin} onLogout={logout} onEdit={openEditProvider} onFetch={api.fetchProviderModels} onClose={() => setManagerTarget(undefined)} />}
    {globalModelsOpen ? <GlobalModelsDialog providers={providers} customById={customById} draft={enabledDraft} busy={busy === "model-manager"} onToggleModel={toggleModelInstant} onClose={() => setGlobalModelsOpen(false)} /> : null}
    {operation === undefined ? null : <AuthOperation operation={operation} prompt={operation.prompt} event={operation.event} onRespond={(value) => { void api.respondLogin(operation.id, value).then(setOperation); }} onCancel={() => { void api.cancelLogin(operation.id).then(setOperation); }} onClose={() => setOperation(undefined)} />}
    <WorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} onAdd={onAddWorkspace} />
    <Dialog open={providerRemoveTarget !== undefined} onOpenChange={(open) => { if (!open && busy === undefined) setProviderRemoveTarget(undefined); }}><DialogContent title="删除供应商"><p className="delete-session-message"><strong>{providerRemoveTarget?.name ?? providerRemoveTarget?.id ?? ""}</strong>的接口配置与 {providerRemoveTarget?.models.length ?? 0} 个模型将被删除，此操作不可撤销。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setProviderRemoveTarget(undefined)} disabled={busy !== undefined}>取消</Button><Button variant="danger" onClick={() => { void removeProvider(); }} disabled={busy !== undefined}>删除</Button></div></DialogContent></Dialog>
    <Dialog open={workspaceRemoveTarget !== undefined} onOpenChange={(open) => { if (!open && workspaceBusy === undefined) setWorkspaceRemoveTarget(undefined); }}><DialogContent title="删除工作区"><p className="delete-session-message"><strong>{workspaceRemoveTarget?.label ?? ""}</strong>及其会话历史将保留在磁盘上。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setWorkspaceRemoveTarget(undefined)} disabled={workspaceBusy !== undefined}>取消</Button><Button variant="danger" onClick={() => { void removeWorkspace(); }} disabled={workspaceBusy !== undefined}>删除</Button></div></DialogContent></Dialog>
    <Dialog open={restartConfirmOpen} onOpenChange={(open) => { if (!open && !restarting) setRestartConfirmOpen(false); }}><DialogContent title="重启服务"><p className="delete-session-message">所有会话将断开数秒，随后自动重连恢复。重启仅加载现有构建，不会编译。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setRestartConfirmOpen(false)} disabled={restarting}>取消</Button><Button variant="danger" onClick={() => { void restart(); }} disabled={restarting}>重启</Button></div></DialogContent></Dialog>
  </section>;
}

function providerDialogDescription(stage: ProviderStage, editing: boolean): string {
  if (editing) return "修改供应商的连接信息。";
  if (stage.kind === "pick") return "选择已有供应商直接登录，或自定义兼容接口。";
  if (stage.kind === "known") return "选择登录方式后按提示完成授权。";
  if (stage.kind === "custom-protocol") return "选择接口协议，然后填写连接信息。";
  return "模型随后在「模型管理」中配置。";
}

/** 品牌头像字母色（优先取自定义显示名/内置名首字母）。 */
function ProviderAvatar({ id, name }: { id: string; name?: string }) {
  return <span aria-hidden className="provider-avatar" style={providerAvatarStyle(id)}>{(name ?? id).slice(0, 1).toUpperCase()}</span>;
}

/** 精简供应商行：头像 + 名称/摘要 + 状态胶囊，点击进详情（登录/模型管理等都在详情里）。 */
function ProviderRow({ status, custom, enabledCount, busy, onOpen, onEdit, onRemove }: { status: ProviderStatus; custom?: ManagedProvider; enabledCount: number; busy?: string; onOpen: (provider: ProviderStatus) => void; onEdit: (provider: ManagedProvider) => void; onRemove: (provider: ManagedProvider) => void }) {
  const configuredCount = custom?.models.length ?? 0;
  const modelCount = configuredCount > 0 ? configuredCount : status.models.length;
  const summary = modelCount === 0 ? "未加载" : custom !== undefined ? `${String(modelCount)} 个模型` : enabledCount >= modelCount ? `全部 ${String(modelCount)} 个模型可用` : `${String(enabledCount)}/${String(modelCount)} 个模型已启用`;
  return <article className="provider-row provider-row-link" onClick={() => onOpen(status)}>
    <ProviderAvatar id={status.id} name={custom?.name ?? status.name} />
    <div className="provider-main"><strong>{custom?.name ?? status.name}</strong><small>{summary}{custom?.baseUrl === undefined ? "" : ` · ${custom.baseUrl.replace(/^https?:\/\//u, "")}`}</small></div>
    <span className={`provider-chip ${status.authConfigured ? "ready" : "unset"}`}>{status.authConfigured ? <><Check size={12} />{status.authSource ?? "已配置"}</> : custom !== undefined ? "仅配置" : "未登录"}</span>
    {custom === undefined ? null : <div className="provider-row-actions" onClick={(event) => event.stopPropagation()}>
      <Button variant="secondary" size="sm" onClick={() => onEdit(custom)}>编辑</Button>
      <Button variant="ghost" size="icon" aria-label={`删除 ${status.id}`} title="删除供应商配置" disabled={busy === status.id} onClick={() => onRemove(custom)}><Trash2 size={15} /></Button>
    </div>}
    <ChevronRight size={15} className="provider-row-chevron" />
  </article>;
}

function ProviderWizard({ providers, provider, stage, editing, busy, search, onSearchChange, onChange, onStageChange, onCancel, onLogin, onSave }: { providers: ProviderStatus[]; provider: ManagedProvider; stage: ProviderStage; editing: boolean; busy: boolean; search: string; onSearchChange: (value: string) => void; onChange: (provider: ManagedProvider) => void; onStageChange: (stage: ProviderStage) => void; onCancel: () => void; onLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => void; onSave: (openModelsAfterSave?: boolean) => void }) {
  const detailsValid = provider.id.trim() !== "" && isValidHttpUrl(provider.baseUrl);
  const idAvailable = editing || !providers.some((item) => item.id === provider.id.trim());
  if (stage.kind === "pick") {
    return <div className="provider-wizard"><div className="provider-picker"><label className="provider-picker-search"><Search size={14} /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索供应商，如 Anthropic、GitHub Copilot…" /></label><button type="button" className="api-choice provider-picker-custom" onClick={() => onStageChange({ kind: "custom-protocol" })}><span><strong>自定义供应商</strong><small>填写 Base URL 的任意兼容接口（中转、内网服务等）</small></span><Plus size={16} /></button><div className="api-choice-list provider-picker-list">{providers.map((item) => { const configured = item.authConfigured || item.custom; return <button type="button" key={item.id} className={`api-choice ${configured ? "provider-picker-configured" : ""}`} onClick={() => onStageChange({ kind: "known", provider: item })}><span><strong>{item.name}</strong><small>{item.id} · {item.models.length} 个模型{configured ? " · 已配置" : ""}</small></span>{configured ? <span className="status-ready"><Check size={13} />已配置</span> : null}</button>; })}</div></div><div className="dialog-actions"><Button variant="secondary" onClick={onCancel}>取消</Button></div></div>;
  }
  if (stage.kind === "known") {
    return <div className="provider-wizard"><div className="api-choice-list"><div className="api-choice selected provider-known-head"><span><strong>{stage.provider.name}</strong><small>{stage.provider.id} · {stage.provider.models.length} 个模型</small></span></div></div><div className="dialog-actions provider-login-actions"><Button variant="secondary" onClick={() => onStageChange({ kind: "pick" })}>返回</Button>{stage.provider.supportsApiKey ? <Button disabled={busy} onClick={() => onLogin(stage.provider, "api_key")}><KeyRound size={14} />API Key</Button> : null}{stage.provider.supportsOAuth ? <Button disabled={busy} onClick={() => onLogin(stage.provider, "oauth")}><ExternalLink size={14} />登录</Button> : null}</div></div>;
  }
  if (stage.kind === "custom-protocol") {
    return <div className="provider-wizard"><div className="api-choice-list">{API_OPTIONS.map((option) => <button type="button" key={option.id} className={`api-choice ${provider.api === option.id ? "selected" : ""}`} onClick={() => onChange({ ...provider, api: option.id })}><span><strong>{option.label}</strong><small>{option.description}</small></span>{provider.api === option.id ? <Check size={16} /> : null}</button>)}</div><div className="dialog-actions"><Button variant="secondary" onClick={() => onStageChange({ kind: "pick" })}>返回</Button><Button onClick={() => onStageChange({ kind: "custom-connection" })}>下一步</Button></div></div>;
  }
  return <div className="provider-wizard"><div className="provider-editor-grid"><label><span>ID</span><input value={provider.id} disabled={editing} autoFocus={!editing} onChange={(event) => onChange({ ...provider, id: event.target.value })} placeholder="例如 my-provider" aria-invalid={!idAvailable} />{idAvailable ? null : <small className="field-error">该 ID 已被使用</small>}</label><label><span>显示名称（可选）</span><input value={provider.name ?? ""} onChange={(event) => onChange({ ...provider, name: event.target.value || undefined })} placeholder="例如 我的模型服务" /></label><label className="provider-editor-wide"><span>Base URL</span><input value={provider.baseUrl} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" aria-invalid={provider.baseUrl.trim() !== "" && !isValidHttpUrl(provider.baseUrl)} />{provider.baseUrl.trim() === "" || isValidHttpUrl(provider.baseUrl) ? null : <small className="field-error">需要合法的 http(s) 地址</small>}</label><label className="provider-editor-wide"><span>接口协议</span><select value={provider.api} onChange={(event) => onChange({ ...provider, api: event.target.value as ManagedProvider["api"] })}>{API_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label className="settings-checkbox"><input type="checkbox" checked={provider.authHeader} onChange={(event) => onChange({ ...provider, authHeader: event.target.checked })} /><span>发送 Bearer Authorization</span></label></div><div className="dialog-actions"><Button variant="secondary" onClick={editing ? onCancel : () => onStageChange({ kind: "custom-protocol" })}>{editing ? "取消" : "上一步"}</Button><Button disabled={busy || !detailsValid || !idAvailable} onClick={() => onSave(!editing)}><Save size={14} />{busy ? "保存中…" : editing ? "保存" : "保存并添加模型"}</Button></div></div>;
}

/** 供应商详情：账号区 + 模型管理（添加/编辑/移除），全部即时保存。 */
function ProviderDetailDialog({ provider, custom, draft, busy, onToggleModel, onEnableModels, onCustomModels, onLogin, onLogout, onEdit, onFetch, onClose }: {
  provider: ProviderStatus;
  custom: ManagedProvider | undefined;
  draft: Set<string>;
  busy: boolean;
  onToggleModel: (providerId: string, modelId: string) => void;
  onEnableModels: (providerId: string, modelIds: string[]) => void;
  onCustomModels: (providerId: string, models: ManagedModel[]) => Promise<boolean>;
  onLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => void;
  onLogout: (provider: ProviderStatus) => void;
  onEdit: (provider: ManagedProvider) => void;
  onFetch: (providerId: string) => Promise<FetchedModel[]>;
  onClose: () => void;
}) {
  const [view, setView] = useState<"list" | "add" | "edit">("list");
  const [editModel, setEditModel] = useState<ManagedModel | undefined>();
  const [addSearch, setAddSearch] = useState("");
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());
  const [fetched, setFetched] = useState<FetchedModel[] | undefined>();
  const [fetching, setFetching] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualIdError, setManualIdError] = useState<string | undefined>();
  // 已添加列表：自定义供应商以 models.json 配置为准（即该供应商的模型清单）；
  // 内置供应商以全局启用集合为准（内置模型无需逐个配置）。
  const addedModels = useMemo(() => (custom?.models ?? provider.models)
    .filter((model) => custom !== undefined || draft.has(modelKey(provider.id, model.id)))
    .sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id)), [provider, custom, draft]);
  // 可添加：内置 = 该供应商尚未添加的全部模型；自定义 = 从接口获取到的模型。
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
        const merged = [...custom.models, ...additions.filter((model) => !existing.has(model.id)).map((model) => ({ id: model.id, name: model.name, reasoning: false, vision: false }))];
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
    if (custom.models.some((model) => model.id === id)) { setManualIdError(`模型 "${id}" 已存在`); return; }
    void onCustomModels(provider.id, [...custom.models, { id, ...(manualName.trim() ? { name: manualName.trim() } : {}), reasoning: false, vision: false }]).then((ok) => { if (ok) { onEnableModels(provider.id, [id]); setManualId(""); setManualName(""); } });
  };
  const removeModel = (modelId: string) => {
    if (custom !== undefined) void onCustomModels(provider.id, custom.models.filter((model) => model.id !== modelId));
    else onToggleModel(provider.id, modelId);
  };
  const editModels = custom?.models ?? [];
  const saveEdit = (next: ManagedModel) => {
    if (custom === undefined || editModel === undefined) return;
    void onCustomModels(provider.id, editModels.map((model) => model.id === editModel.id ? next : model)).then(() => {
      setEditModel(undefined);
      setView("list");
    });
  };
  const title = view === "add" ? `添加模型 · ${provider.name}` : view === "edit" ? `编辑模型 · ${provider.name}` : provider.name;
  const listDescription = custom === undefined
    ? `已启用 ${addedModels.length}/${provider.models.length} 个模型，点击勾选即时生效。`
    : `已配置 ${addedModels.length} 个模型，添加后自动出现在会话模型选择器。`;
  return <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}><DialogContent className="provider-dialog provider-detail-dialog" title={title} description={view === "list" ? listDescription : view === "add" ? custom === undefined ? "勾选要启用的模型，取消勾选即移出选择器。" : "从接口获取模型列表自动填入，或在下方手动添加。" : "编辑模型的显示信息。"}>
    {view === "list" ? <div className="provider-wizard">
      <div className="provider-detail-account">
        <ProviderAvatar id={provider.id} name={custom?.name ?? provider.name} />
        <div className="provider-detail-account-main"><strong>{custom?.name ?? provider.name}</strong><small>{custom?.baseUrl === undefined ? provider.id : custom.baseUrl}{custom === undefined ? "" : ` · ${apiLabel(custom.api)}`}</small></div>
        {statusChip(provider, custom)}
      </div>
      <div className="provider-detail-actions">
        {provider.authConfigured ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => onLogout(provider)}><LogOut size={13} />退出登录</Button>
          : <>{provider.supportsApiKey ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => onLogin(provider, "api_key")}><KeyRound size={13} />API Key</Button> : null}{provider.supportsOAuth ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => onLogin(provider, "oauth")}><ExternalLink size={13} />账号登录</Button> : null}{custom !== undefined ? <Button variant="secondary" size="sm" onClick={() => onEdit(custom)}><Pencil size={13} />编辑连接</Button> : null}</>}
        {custom !== undefined ? <Button variant="secondary" size="sm" onClick={() => onEdit(custom)}><Pencil size={13} />编辑连接</Button> : null}
      </div>
      <div className="model-manage-list">{addedModels.length === 0 ? <div className="model-empty">{custom === undefined && provider.models.length > 0 ? "尚未启用模型，点击「添加模型」勾选。" : "尚未添加模型，点击「添加模型」。"}</div> : addedModels.map((model) => { const configured = customModelById.get(model.id); return <div className="model-manage-row" key={model.id}><button type="button" className="model-manage-row-main" disabled={custom === undefined} onClick={() => { setEditModel(configured ?? { ...model }); setView("edit"); }}><span className="model-manage-copy"><strong>{displayModelName(model.name ?? model.id)}</strong><small>{model.id}{model.reasoning ? " · 思考" : ""}{model.vision ? " · 图片" : ""}</small></span></button>{custom === undefined ? <label className="model-row-toggle" aria-label={`启用 ${model.id}`} title={draft.has(modelKey(provider.id, model.id)) ? "点击停用" : "点击启用"}><input type="checkbox" checked={draft.has(modelKey(provider.id, model.id))} disabled={busy} onChange={() => onToggleModel(provider.id, model.id)} /></label> : <Button variant="ghost" size="icon" aria-label={`移除 ${model.id}`} title="移除模型" disabled={busy} onClick={() => removeModel(model.id)}><Trash2 size={14} /></Button>}</div>; })}</div>
      <div className="dialog-actions"><Button variant="secondary" size="sm" onClick={onClose}>关闭</Button><Button variant="secondary" disabled={busy || (custom === undefined && provider.models.length === 0)} onClick={() => { setAddSelected(new Set()); setFetched(undefined); setAddSearch(""); setView("add"); }}><Plus size={14} />添加模型</Button></div>
    </div> : null}
    {view === "add" ? <div className="provider-wizard">{custom === undefined ? (
      <div className="provider-picker">
        <label className="provider-picker-search"><Search size={14} /><input autoFocus value={addSearch} onChange={(event) => setAddSearch(event.target.value)} placeholder="搜索模型…" /></label>
        {addCandidates.length === 0 ? <div className="model-empty">没有可添加的模型（该供应商的模型都已添加）。</div> : (
          <div className="pick-model-list model-manage-addable">
            {addCandidates.map((model) => {
              const key = modelKey(provider.id, model.id);
              const selected = addSelected.has(key);
              return <label className="settings-checkbox pick-model-item" key={key}><input type="checkbox" checked={selected} onChange={() => setAddSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} /><span><strong>{displayModelName(model.name ?? model.id)}</strong>{model.name === undefined || model.name === model.id ? null : <small>{model.id}</small>}</span></label>;
            })}
          </div>
        )}
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => { setAddSelected(new Set()); setAddSearch(""); setView("list"); }}>返回</Button>
          {addSelected.size === 0 ? null : <Button disabled={busy} onClick={() => { onEnableModels(provider.id, [...addSelected].map((key) => splitModelKey(key).id)); setAddSelected(new Set()); setAddSearch(""); setView("list"); }}>启用所选（{addSelected.size}）</Button>}
        </div>
      </div>
    ) : (
      <div className="model-manage-custom-add">
        <div className="settings-section-heading">
          <p className="settings-muted">{fetched === undefined ? "可从接口获取模型列表自动填入，也可在下方手动添加。" : `已从接口获取 ${fetched.length} 个模型（已过滤已添加的），勾选后点「添加所选」，或在下方手动添加。`}</p>
          <Button variant="secondary" size="sm" disabled={fetching} onClick={() => { setFetching(true); void onFetch(provider.id).then(applyFetched).catch(() => { setFetched(undefined); }).finally(() => setFetching(false)); }}><RotateCw size={13} />{fetching ? "获取中…" : "从接口获取模型列表"}</Button>
        </div>
        {fetched === undefined ? null : (
          <div className="pick-model-list model-manage-addable">
            {addCandidates.length === 0 ? <div className="model-empty">获取到的模型都已添加。</div> : addCandidates.map((model) => {
              const key = modelKey(provider.id, model.id);
              const selected = addSelected.has(key);
              return <label className="settings-checkbox pick-model-item" key={key}><input type="checkbox" checked={selected} onChange={() => setAddSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })} /><span><strong>{displayModelName(model.name ?? model.id)}</strong>{model.name === undefined || model.name === model.id ? null : <small>{model.id}</small>}</span></label>;
            })}
          </div>
        )}
        <div className="model-manage-manual">
          <label className="provider-editor-grid"><span>模型 ID*</span><input value={manualId} aria-invalid={manualIdError !== undefined} onChange={(event) => { setManualId(event.target.value); setManualIdError(undefined); }} placeholder="例如 gpt-4o" />{manualIdError === undefined ? null : <small className="field-error">{manualIdError}</small>}</label>
          <label className="provider-editor-grid"><span>显示名称（可选）</span><input value={manualName} onChange={(event) => setManualName(event.target.value)} placeholder="例如 GPT-4o" /></label>
          <Button variant="secondary" size="sm" disabled={manualId.trim() === "" || busy} onClick={addManualModel}><Plus size={13} />添加</Button>
        </div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => { setAddSelected(new Set()); setFetched(undefined); setAddSearch(""); setView("list"); }}>返回</Button>
          {fetched === undefined || addSelected.size === 0 ? null : <Button onClick={addSelectedModels}>添加所选（{addSelected.size}）</Button>}
        </div>
      </div>
    )}</div> : null}
    {view === "edit" && editModel !== undefined ? <div className="provider-wizard"><EditModelForm model={editModel} onSave={saveEdit} onCancel={() => setView("list")} /></div> : null}
  </DialogContent></Dialog>;
}

/** 全局模型范围：跨供应商统一勾选启用集合（总览条入口），勾选即时保存。 */
function GlobalModelsDialog({ providers, customById, draft, busy, onToggleModel, onClose }: {
  providers: ProviderStatus[];
  customById: Map<string, ManagedProvider>;
  draft: Set<string>;
  busy: boolean;
  onToggleModel: (providerId: string, modelId: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => providers.map((provider) => ({
    provider,
    models: provider.models.filter((model) => search.trim() === "" || `${model.name ?? ""}\n${model.id}\n${provider.name}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())),
  })).filter((group) => group.models.length > 0), [providers, search]);
  const visibleTotal = groups.reduce((sum, group) => sum + group.models.length, 0);
  const selectedCount = groups.reduce((sum, group) => sum + group.models.filter((model) => draft.has(modelKey(group.provider.id, model.id))).length, 0);
  return <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}><DialogContent className="provider-dialog global-models-dialog" title="模型范围" description={`勾选即时生效：全部勾选 = 不限制；当前 ${selectedCount}/${visibleTotal} 已启用。`}>
    <div className="provider-wizard">
      <label className="provider-picker-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索供应商或模型…" /></label>
      <div className="global-models-list">{groups.length === 0 ? <div className="model-empty">没有匹配的模型</div> : groups.map((group) => <div className="global-models-group" key={group.provider.id}>
        <div className="global-models-head"><ProviderAvatar id={group.provider.id} name={customById.get(group.provider.id)?.name ?? group.provider.name} /><strong>{customById.get(group.provider.id)?.name ?? group.provider.name}</strong></div>
        <div className="pick-model-list">{group.models.map((model) => {
          const key = modelKey(group.provider.id, model.id);
          return <label className="settings-checkbox pick-model-item" key={key}><input type="checkbox" checked={draft.has(key)} disabled={busy} onChange={() => onToggleModel(group.provider.id, model.id)} /><span><strong>{displayModelName(model.name ?? model.id)}</strong>{model.name === undefined || model.name === model.id ? null : <small>{model.id}</small>}</span></label>;
        })}</div>
      </div>)}</div>
      <div className="dialog-actions"><Button variant="secondary" onClick={onClose}>完成</Button></div>
    </div>
  </DialogContent></Dialog>;
}

/** 设置页空状态：图标 + 引导文案 + 直达按钮。 */
function EmptyState({ icon: Icon, title, hint, actionLabel, onAction }: { icon: LucideIcon; title: string; hint: string; actionLabel: string; onAction: () => void }) {
  return <div className="settings-empty">
    <span className="settings-empty-icon"><Icon size={22} /></span>
    <strong>{title}</strong>
    <small>{hint}</small>
    <Button size="sm" onClick={onAction}><Plus size={14} />{actionLabel}</Button>
  </div>;
}

function EditModelForm({ model, onSave, onCancel }: { model: ManagedModel; onSave: (model: ManagedModel) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ManagedModel>({ ...model });
  return <div className="provider-wizard"><div className="model-config-fields"><label><span>模型 ID</span><input value={draft.id} disabled /></label><label><span>显示名称（可选）</span><input value={draft.name ?? ""} onChange={(event) => setDraft({ ...draft, name: event.target.value || undefined })} placeholder="例如 GPT-4o" /></label><label><span>上下文窗口（可选）</span><input type="number" min={1} value={draft.contextWindow ?? ""} onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label><label><span>最大输出 token（可选）</span><input type="number" min={1} value={draft.maxTokens ?? ""} onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label></div><div className="model-config-options"><label className="settings-checkbox"><input type="checkbox" checked={draft.reasoning} onChange={(event) => setDraft({ ...draft, reasoning: event.target.checked })} />支持思考</label><label className="settings-checkbox"><input type="checkbox" checked={draft.vision} onChange={(event) => setDraft({ ...draft, vision: event.target.checked })} />支持图片</label></div><div className="dialog-actions"><Button variant="secondary" onClick={onCancel}>取消</Button><Button onClick={() => onSave(draft)}>保存</Button></div></div>;
}

function AuthOperation({ operation, prompt, event, onRespond, onCancel, onClose }: { operation: AuthLoginOperation; prompt: AuthLoginOperation["prompt"]; event: AuthLoginOperation["event"]; onRespond: (value: string) => void; onCancel: () => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const options = useMemo(() => prompt?.options ?? [], [prompt?.options]);
  return <div className="auth-operation-overlay"><div className="auth-operation"><div className="settings-section-heading"><h2>{operation.state === "completed" ? "登录完成" : operation.state === "failed" ? "登录失败" : operation.state === "cancelled" ? "登录已取消" : "正在登录"}</h2><Button variant="ghost" size="icon" aria-label="取消登录" title="取消登录" onClick={operation.state === "running" ? onCancel : onClose}><X size={17} /></Button></div>{event?.message ? <p className="auth-event">{event.message}</p> : null}{event?.url ? <a className="auth-link" href={event.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开授权页面</a> : null}{operation.error ? <p className="settings-error">{operation.error}</p> : null}{operation.state === "running" && prompt ? <form className="auth-prompt" onSubmit={(eventSubmit) => { eventSubmit.preventDefault(); if (value.trim() !== "") { onRespond(value); setValue(""); } }}>{prompt.type === "select" ? <div className="auth-options">{options.map((option) => <button type="button" key={option.id} onClick={() => onRespond(option.id)}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</div> : <><label>{prompt.message}<input autoFocus type={prompt.type === "secret" ? "password" : "text"} placeholder={prompt.placeholder} value={value} onChange={(eventInput) => setValue(eventInput.target.value)} /></label><Button type="submit" disabled={value.trim() === ""}>提交</Button></>}</form> : null}{operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" ? <Button onClick={onClose}>关闭</Button> : null}</div></div>;
}

/** 安全：访问密码（设置/修改/关闭）与登录设备管理。 */
function SecurityPanel({ onMessage }: { onMessage: (message: string, tone?: SettingsMessageTone) => void }) {
  const [status, setStatus] = useState<AuthStatus | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const enabled = status?.required === true;

  useEffect(() => {
    let disposed = false;
    void api.authStatus().then(({ auth }) => { if (!disposed) setStatus(auth); })
      .catch((error: unknown) => { if (!disposed) onMessage(error instanceof Error ? error.message : "无法读取认证状态", "error"); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (newPassword.length < 8) { onMessage("密码至少 8 位", "error"); return; }
    if (newPassword !== confirmPassword) { onMessage("两次输入的密码不一致", "error"); return; }
    setBusy(true);
    try {
      setStatus(await api.setPassword(newPassword, enabled ? currentPassword : undefined));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onMessage(enabled ? "密码已更新，其他设备需要重新登录" : "已启用登录认证，下次打开需要输入密码");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "密码保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setDisableOpen(false);
    if (currentPassword === "") { onMessage("请先填写当前密码", "error"); return; }
    setBusy(true);
    try {
      setStatus(await api.setPassword(null, currentPassword));
      setCurrentPassword("");
      onMessage("已关闭登录认证");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "关闭认证失败", "error");
    } finally {
      setBusy(false);
    }
  };

  /** 退出登录：清掉本地会话后由 AuthGate 回到登录页。 */
  const signOut = (allDevices: boolean) => {
    if (busy) return;
    setBusy(true);
    const request = allDevices ? api.logoutAll() : api.logout();
    void request.catch((error: unknown) => { onMessage(error instanceof Error ? error.message : "退出登录失败", "error"); })
      .finally(() => { notifyUnauthorized(); });
  };

  return <section className="settings-section">
    <div className="settings-section-heading">
      <div>
        <h2>安全</h2>
        <p className="settings-muted">访问密码保护整个工作台：未登录的设备无法读取会话、执行命令或打开穿透地址。</p>
      </div>
    </div>
    {loading ? <p className="settings-muted">正在读取认证状态…</p> : <>
      <div className="security-status">
        <span className={`provider-chip ${enabled ? "ready" : "unset"}`}>{enabled ? <><Check size={12} />已启用登录认证</> : "未设置密码"}</span>
        <small>{enabled ? null : "当前任何能访问该地址的人都可以操作会话；开启公网穿透前请先设置密码。"}</small>
      </div>
      <form className="security-form" onSubmit={(event) => { void save(event); }}>
        {enabled ? <label className="settings-field"><span>当前密码</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label> : null}
        <label className="settings-field"><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} placeholder="至少 8 位" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label className="settings-field"><span>确认新密码</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        <div className="security-actions">
          <Button type="submit" disabled={busy || newPassword === ""}><ShieldCheck size={15} />{enabled ? "修改密码" : "启用登录认证"}</Button>
          {enabled ? <Button type="button" variant="danger" disabled={busy} onClick={() => setDisableOpen(true)}>关闭认证</Button> : null}
        </div>
      </form>
      {enabled ? <div className="security-actions">
        <Button variant="secondary" disabled={busy} onClick={() => signOut(false)}><LogOut size={15} />退出登录</Button>
        <Button variant="ghost" disabled={busy} onClick={() => signOut(true)}>退出所有设备</Button>
      </div> : null}
    </>}
    <Dialog open={disableOpen} onOpenChange={(open) => { if (!open && !busy) setDisableOpen(false); }}><DialogContent title="关闭登录认证"><p className="delete-session-message">关闭后，任何能访问该地址的人都可以读取会话、执行命令与修改文件，公网穿透地址也会直接暴露。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setDisableOpen(false)} disabled={busy}>取消</Button><Button variant="danger" onClick={() => { void disable(); }} disabled={busy}>关闭认证</Button></div></DialogContent></Dialog>
  </section>;
}
