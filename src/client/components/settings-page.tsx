import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Boxes, Check, CircleAlert, CheckCircle2, ExternalLink, FolderPlus, Globe, KeyRound, LogOut, Plus, RotateCw, Save, Search, Settings2, Trash2, X } from "lucide-react";
import type { AppSettings, AuthLoginOperation, EnabledModelsStatus, FetchedModel, ManagedModel, ManagedProvider, ProviderStatus, Workspace } from "../../shared/protocol";
import { api } from "../api";
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

type SettingsTab = "general" | "providers" | "workspaces" | "tunnel";
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
  const saveProvider = async () => {
    setBusy("provider");
    try {
      const saved = await api.saveCustomProvider(provider);
      setCustomProviders((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.id.localeCompare(b.id)));
      setProviderDialogOpen(false);
      showMessage(saved.models.length === 0 ? "供应商已保存，点击行内「模型管理」按钮添加模型" : "供应商和模型配置已保存");
      await reload();
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
  /** 模型管理对话框保存：自定义供应商配置（models.json）+ 全局启用集合（patterns）。 */
  const saveModelManager = async (custom?: ManagedProvider) => {
    setBusy("model-manager");
    try {
      if (custom !== undefined) await api.saveCustomProvider(custom);
      const allKeys = new Set(providers.flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id))));
      if (enabledDraft.size === 0 && allKeys.size > 0) { showMessage("请至少启用一个模型", "error"); return; }
      // 全选 = 无限制，保持 Pi 配置干净（enabledModels 不写）。
      const unrestricted = allKeys.size > 0 && enabledDraft.size === allKeys.size && [...allKeys].every((key) => enabledDraft.has(key));
      const next = await api.updateEnabledModels(unrestricted ? [] : [...enabledDraft].map((key) => splitModelKey(key)));
      setEnabledDraft(initializeDraft(providers, next));
      showMessage("模型已保存，会话模型选择器已更新");
      await reload();
    } catch (error) { showMessage(error instanceof Error ? error.message : "模型保存失败", "error"); }
    finally { setBusy(undefined); }
  };
  const updateCustomModels = (providerId: string, models: ManagedModel[]) => {
    setCustomProviders((current) => current.map((item) => item.id === providerId ? { ...item, models } : item));
  };
  const toggleModel = (providerId: string, modelId: string) => {
    const key = modelKey(providerId, modelId);
    setEnabledDraft((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
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

  const currentStage = providerStage.kind;
  const providerDialogTitle = editingProvider ? "编辑供应商" : currentStage === "pick" ? "添加供应商" : currentStage === "known" ? "登录供应商" : currentStage === "custom-protocol" ? "选择接口" : "连接信息";
  return <section className="settings-page">
    <header className="settings-header"><Button variant="ghost" size="icon" aria-label="返回会话" title="返回会话" onClick={onBack}><X size={18} /></Button><h1>设置</h1></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" className={tab === "general" ? "selected" : ""} onClick={() => setTab("general")}><Settings2 size={16} />常规</button>
        <button type="button" className={tab === "providers" ? "selected" : ""} onClick={() => setTab("providers")}><KeyRound size={16} />供应商与账号</button>
        <button type="button" className={tab === "workspaces" ? "selected" : ""} onClick={() => setTab("workspaces")}><FolderPlus size={16} />工作区</button>
        <button type="button" className={tab === "tunnel" ? "selected" : ""} onClick={() => setTab("tunnel")}><Globe size={16} />内网穿透</button>
      </nav>
      <main className="settings-content">
        {message === undefined ? null : <div className={`settings-toast ${messageTone}`} role={messageTone === "error" ? "alert" : "status"}><span className="settings-toast-icon">{messageTone === "error" ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}</span><span>{message}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage(undefined)}><X size={14} /></button></div>}
        {tab === "general" ? <section className="settings-section"><h2>常规</h2><label className="settings-field"><span>助手名称</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveName(); }} /></label><Button onClick={() => { void saveName(); }} disabled={busy === "name" || name.trim() === ""}><Save size={15} />保存名称</Button><label className="settings-field settings-checkbox"><input type="checkbox" checked={notificationsEnabled} onChange={(event) => { void toggleNotifications(event.target.checked); }} /><span>会话运行结束时弹出通知（页面在后台时）</span></label><div className="settings-section-heading"><h2>服务</h2></div><p className="settings-muted">重启服务会短暂中断所有连接（自动重连恢复），仅加载现有构建，不会编译。</p><Button variant="danger" disabled={restarting} onClick={() => setRestartConfirmOpen(true)}><RotateCw size={15} />{restarting ? "正在重启…" : "重启服务"}</Button></section> : null}
        {tab === "providers" ? <section className="settings-section"><div className="settings-section-heading"><div><h2>供应商与账号</h2><p className="settings-muted">统一管理连接凭据、供应商接口和可用模型。</p></div><Button size="sm" onClick={openNewProvider}><Plus size={14} />添加供应商</Button></div>{loading ? <p className="settings-muted">正在读取供应商…</p> : <><label className="settings-checkbox settings-show-all"><input type="checkbox" checked={providersShowAll} onChange={(event) => setProvidersShowAll(event.target.checked)} /><span>{providersShowAll ? "隐藏未启用的供应商" : `显示全部供应商（${hiddenProviderCount} 个未启用）`}</span></label><div className="provider-list">{visibleProviders.length === 0 && customProviders.length === 0 ? <p className="settings-muted">暂无供应商配置</p> : visibleProviders.map((item) => <ProviderRow key={item.id} status={item} custom={customById.get(item.id)} enabledCount={providerEnabledCounts.get(item.id) ?? 0} busy={busy} onLogin={startLogin} onLogout={logout} onEdit={openEditProvider} onManageModels={setManagerTarget} onRemove={setProviderRemoveTarget} />)}{customProviders.filter((item) => !providers.some((status) => status.id === item.id)).map((item) => <article className="provider-row" key={item.id}><div className="provider-main"><strong>{item.name ?? item.id}</strong><small>{item.id} · {item.models.length} 个模型 · 未加载</small></div><div className="provider-status"><Button variant="secondary" size="sm" onClick={() => openEditProvider(item)}>编辑</Button><Button variant="ghost" size="icon" aria-label={`删除 ${item.id}`} title="删除供应商" disabled={busy === item.id} onClick={() => setProviderRemoveTarget(item)}><Trash2 size={15} /></Button></div></article>)}</div></>}</section> : null}
        {tab === "workspaces" ? <section className="settings-section"><div className="settings-section-heading"><h2>工作区</h2><Button size="sm" onClick={() => setWorkspaceDialogOpen(true)}><FolderPlus size={14} />添加工作区</Button></div>{workspaces.length === 0 ? <p className="settings-muted">暂无工作区</p> : <div className="provider-list">{workspaces.map((workspace, index) => <article className="provider-row workspace-settings-row" key={workspace.id}><div className="provider-main"><strong>{workspace.label}</strong><small>{workspace.cwd}</small></div><div className="provider-status workspace-settings-actions"><Button variant="ghost" size="icon" aria-label="上移工作区" title="上移" disabled={index === 0 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, -1); }}><ArrowUp size={15} /></Button><Button variant="ghost" size="icon" aria-label="下移工作区" title="下移" disabled={index === workspaces.length - 1 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, 1); }}><ArrowDown size={15} /></Button><Button variant="ghost" size="icon" aria-label={`删除工作区 ${workspace.label}`} title="删除工作区" disabled={workspaceBusy !== undefined} onClick={() => setWorkspaceRemoveTarget(workspace)}><Trash2 size={15} /></Button></div></article>)}</div>}</section> : null}
        {tab === "tunnel" ? <TunnelPanel onMessage={(nextMessage, tone) => showMessage(nextMessage, tone)} /> : null}
      </main>
    </div>
    <Dialog open={providerDialogOpen} onOpenChange={(open) => { if (!open && busy !== "provider") setProviderDialogOpen(false); }}><DialogContent className="provider-dialog" title={providerDialogTitle} description={providerDialogDescription(providerStage, editingProvider)}><ProviderWizard providers={pickerProviders} provider={provider} stage={providerStage} editing={editingProvider} busy={busy === "provider"} search={providerSearch} onSearchChange={setProviderSearch} onChange={setProvider} onStageChange={setProviderStage} onCancel={() => setProviderDialogOpen(false)} onLogin={startLogin} onSave={() => { void saveProvider(); }} /></DialogContent></Dialog>
    {managerTarget === undefined ? null : <ModelManagerDialog provider={managerTarget} custom={customById.get(managerTarget.id)} draft={enabledDraft} busy={busy === "model-manager"} onDraftChange={setEnabledDraft} onCustomModelsChange={updateCustomModels} onToggleModel={toggleModel} onSave={(custom) => { void saveModelManager(custom); }} onFetch={api.fetchProviderModels} onClose={() => setManagerTarget(undefined)} />}
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

function ProviderRow({ status, custom, enabledCount, busy, onLogin, onLogout, onEdit, onManageModels, onRemove }: { status: ProviderStatus; custom?: ManagedProvider; enabledCount: number; busy?: string; onLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => void; onLogout: (provider: ProviderStatus) => void; onEdit: (provider: ManagedProvider) => void; onManageModels: (provider: ProviderStatus) => void; onRemove: (provider: ManagedProvider) => void }) {
  const configuredCount = custom?.models.length ?? 0;
  // 自定义供应商以 models.json 配置为准；内置供应商以全局启用集合为准。
  const modelCount = configuredCount > 0 ? configuredCount : status.models.length;
  const summary = modelCount === 0 ? "未加载" : custom !== undefined ? `${modelCount} 个模型` : enabledCount >= modelCount ? `全部 ${modelCount} 个模型可用` : `${enabledCount}/${modelCount} 个模型已添加`;
  return <article className="provider-row"><div className="provider-main"><strong>{custom?.name ?? status.name}</strong><small>{status.id} · {summary}</small></div><div className="provider-status">{status.authConfigured ? <><span className="status-ready"><Check size={14} />{status.authSource ?? "已配置"}</span><Button variant="ghost" size="icon" aria-label={`退出 ${status.name}`} title={`退出 ${status.name}`} disabled={busy === status.id} onClick={() => onLogout(status)}><LogOut size={15} /></Button></> : <>{status.supportsApiKey ? <Button variant="secondary" size="sm" disabled={busy === status.id} onClick={() => onLogin(status, "api_key")}><KeyRound size={13} />API Key</Button> : null}{status.supportsOAuth ? <Button variant="secondary" size="sm" disabled={busy === status.id} onClick={() => onLogin(status, "oauth")}><ExternalLink size={13} />登录</Button> : null}</>}<Button variant="ghost" size="icon" aria-label={`管理 ${status.name} 的模型`} title="模型管理" disabled={modelCount === 0} onClick={() => onManageModels(status)}><Boxes size={15} /></Button>{custom === undefined ? null : <><Button variant="secondary" size="sm" onClick={() => onEdit(custom)}>编辑</Button><Button variant="ghost" size="icon" aria-label={`删除 ${status.id}`} title="删除供应商配置" disabled={busy === status.id} onClick={() => onRemove(custom)}><Trash2 size={15} /></Button></>}</div></article>;
}

function ProviderWizard({ providers, provider, stage, editing, busy, search, onSearchChange, onChange, onStageChange, onCancel, onLogin, onSave }: { providers: ProviderStatus[]; provider: ManagedProvider; stage: ProviderStage; editing: boolean; busy: boolean; search: string; onSearchChange: (value: string) => void; onChange: (provider: ManagedProvider) => void; onStageChange: (stage: ProviderStage) => void; onCancel: () => void; onLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => void; onSave: () => void }) {
  const detailsValid = provider.id.trim() !== "" && provider.baseUrl.trim() !== "";
  if (stage.kind === "pick") {
    return <div className="provider-wizard"><div className="provider-picker"><label className="provider-picker-search"><Search size={14} /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索供应商，如 Anthropic、GitHub Copilot…" /></label><button type="button" className="api-choice provider-picker-custom" onClick={() => onStageChange({ kind: "custom-protocol" })}><span><strong>自定义供应商</strong><small>填写 Base URL 的任意兼容接口（中转、内网服务等）</small></span><Plus size={16} /></button><div className="api-choice-list provider-picker-list">{providers.map((item) => { const configured = item.authConfigured || item.custom; return <button type="button" key={item.id} className={`api-choice ${configured ? "provider-picker-configured" : ""}`} onClick={() => onStageChange({ kind: "known", provider: item })}><span><strong>{item.name}</strong><small>{item.id} · {item.models.length} 个模型{configured ? " · 已配置" : ""}</small></span>{configured ? <span className="status-ready"><Check size={13} />已配置</span> : null}</button>; })}</div></div><div className="dialog-actions"><Button variant="secondary" onClick={onCancel}>取消</Button></div></div>;
  }
  if (stage.kind === "known") {
    return <div className="provider-wizard"><div className="api-choice-list"><div className="api-choice selected provider-known-head"><span><strong>{stage.provider.name}</strong><small>{stage.provider.id} · {stage.provider.models.length} 个模型</small></span></div></div><div className="dialog-actions provider-login-actions"><Button variant="secondary" onClick={() => onStageChange({ kind: "pick" })}>返回</Button>{stage.provider.supportsApiKey ? <Button disabled={busy} onClick={() => onLogin(stage.provider, "api_key")}><KeyRound size={14} />API Key</Button> : null}{stage.provider.supportsOAuth ? <Button disabled={busy} onClick={() => onLogin(stage.provider, "oauth")}><ExternalLink size={14} />登录</Button> : null}</div></div>;
  }
  if (stage.kind === "custom-protocol") {
    return <div className="provider-wizard"><div className="api-choice-list">{API_OPTIONS.map((option) => <button type="button" key={option.id} className={`api-choice ${provider.api === option.id ? "selected" : ""}`} onClick={() => onChange({ ...provider, api: option.id })}><span><strong>{option.label}</strong><small>{option.description}</small></span>{provider.api === option.id ? <Check size={16} /> : null}</button>)}</div><div className="dialog-actions"><Button variant="secondary" onClick={() => onStageChange({ kind: "pick" })}>返回</Button><Button onClick={() => onStageChange({ kind: "custom-connection" })}>下一步</Button></div></div>;
  }
  return <div className="provider-wizard"><div className="provider-editor-grid"><label><span>ID</span><input value={provider.id} disabled={editing} autoFocus={!editing} onChange={(event) => onChange({ ...provider, id: event.target.value })} placeholder="例如 my-provider" /></label><label><span>显示名称（可选）</span><input value={provider.name ?? ""} onChange={(event) => onChange({ ...provider, name: event.target.value || undefined })} placeholder="例如 我的模型服务" /></label><label className="provider-editor-wide"><span>Base URL</span><input value={provider.baseUrl} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label><label className="provider-editor-wide"><span>接口协议</span><select value={provider.api} onChange={(event) => onChange({ ...provider, api: event.target.value as ManagedProvider["api"] })}>{API_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><label className="settings-checkbox"><input type="checkbox" checked={provider.authHeader} onChange={(event) => onChange({ ...provider, authHeader: event.target.checked })} /><span>发送 Bearer Authorization</span></label></div><div className="dialog-actions"><Button variant="secondary" onClick={editing ? onCancel : () => onStageChange({ kind: "custom-protocol" })}>{editing ? "取消" : "上一步"}</Button><Button disabled={busy || !detailsValid} onClick={onSave}><Save size={14} />{busy ? "保存中…" : "确认并保存"}</Button></div></div>;
}

/** 供应商的模型管理：已添加列表 + 添加视图（内置列表选择 / 自定义手动编辑 + 自动获取） + 编辑视图。 */
function ModelManagerDialog({ provider, custom, draft, busy, onDraftChange, onCustomModelsChange, onToggleModel, onSave, onFetch, onClose }: {
  provider: ProviderStatus;
  custom: ManagedProvider | undefined;
  draft: Set<string>;
  busy: boolean;
  onDraftChange: (draft: Set<string>) => void;
  onCustomModelsChange: (providerId: string, models: ManagedModel[]) => void;
  onToggleModel: (providerId: string, modelId: string) => void;
  onSave: (custom?: ManagedProvider) => void;
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
    const next = new Set(draft);
    for (const key of addSelected) next.add(key);
    if (custom !== undefined && fetched !== undefined) {
      const existing = new Set(custom.models.map((model) => model.id));
      const additions = fetched.filter((model) => addSelected.has(modelKey(provider.id, model.id)) && !existing.has(model.id));
      onCustomModelsChange(provider.id, [...custom.models, ...additions.map((model) => ({ id: model.id, name: model.name, reasoning: false, vision: false }))]);
    }
    onDraftChange(next);
    setView("list");
    setAddSelected(new Set());
    setFetched(undefined);
    setAddSearch("");
  };
  const addManualModel = () => {
    const id = manualId.trim();
    if (id === "" || custom === undefined) return;
    onCustomModelsChange(provider.id, [...custom.models, { id, ...(manualName.trim() ? { name: manualName.trim() } : {}), reasoning: false, vision: false }]);
    onDraftChange(new Set(draft).add(modelKey(provider.id, id)));
    setManualId("");
    setManualName("");
  };
  const removeModel = (modelId: string) => {
    if (custom !== undefined) onCustomModelsChange(provider.id, custom.models.filter((model) => model.id !== modelId));
    onToggleModel(provider.id, modelId);
  };
  const editModels = custom?.models ?? [];
  const saveEdit = (next: ManagedModel) => {
    if (custom === undefined || editModel === undefined) return;
    const index = editModels.findIndex((model) => model.id === editModel.id);
    const nextList = index < 0 ? [...editModels, next] : editModels.map((model) => model.id === editModel.id ? next : model);
    onCustomModelsChange(provider.id, nextList);
    setEditModel(undefined);
    setView("list");
  };
  const title = view === "add" ? `添加模型 · ${provider.name}` : view === "edit" ? `编辑模型 · ${provider.name}` : `模型管理 · ${provider.name}`;
  const listDescription = custom === undefined
    ? `已添加的模型会出现在会话的模型选择器中（${addedModels.length}/${provider.models.length}）。`
    : `该供应商已配置 ${addedModels.length} 个模型，添加后即可在会话的模型选择器中使用。`;
  return <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}><DialogContent className="provider-dialog model-manager-dialog" title={title} description={view === "list" ? listDescription : view === "add" ? custom === undefined ? "从供应商的模型列表中选择要添加的模型。" : "从接口获取模型列表自动填入，或手动添加模型信息。" : "编辑模型的显示信息。点击「保存模型」统一写入。"}>
    {view === "list" ? <div className="provider-wizard"><div className="model-manage-list">{addedModels.length === 0 ? <div className="model-empty">尚未添加模型，点击「添加模型」。</div> : addedModels.map((model) => { const configured = customModelById.get(model.id); return <div className="model-manage-row" key={model.id}><button type="button" className="model-manage-row-main" disabled={custom === undefined} onClick={() => { setEditModel(configured ?? { ...model }); setView("edit"); }}><span className="model-manage-copy"><strong>{displayModelName(model.name ?? model.id)}</strong><small>{model.id}{model.reasoning ? " · 思考" : ""}{model.vision ? " · 图片" : ""}</small></span></button><Button variant="ghost" size="icon" aria-label={`移除 ${model.id}`} title="移除模型" disabled={busy} onClick={() => removeModel(model.id)}><Trash2 size={14} /></Button></div>; })}</div><div className="dialog-actions"><Button variant="secondary" size="sm" onClick={onClose}>关闭</Button><Button variant="secondary" disabled={busy || (custom === undefined && provider.models.length === 0)} onClick={() => { setAddSelected(new Set()); setFetched(undefined); setAddSearch(""); setView("add"); }}><Plus size={14} />添加模型</Button><Button disabled={busy || draft.size === 0} title={draft.size === 0 ? "请至少启用一个模型" : undefined} onClick={() => onSave(custom)}><Save size={14} />{busy ? "保存中…" : "保存模型"}</Button></div></div> : null}
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
          <label className="provider-editor-grid"><span>模型 ID*</span><input value={manualId} onChange={(event) => setManualId(event.target.value)} placeholder="例如 gpt-4o" /></label>
          <label className="provider-editor-grid"><span>显示名称（可选）</span><input value={manualName} onChange={(event) => setManualName(event.target.value)} placeholder="例如 GPT-4o" /></label>
          <Button variant="secondary" size="sm" disabled={manualId.trim() === ""} onClick={addManualModel}><Plus size={13} />手动添加</Button>
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

function EditModelForm({ model, onSave, onCancel }: { model: ManagedModel; onSave: (model: ManagedModel) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ManagedModel>({ ...model });
  return <div className="provider-wizard"><div className="model-config-fields"><label><span>模型 ID</span><input value={draft.id} disabled /></label><label><span>显示名称（可选）</span><input value={draft.name ?? ""} onChange={(event) => setDraft({ ...draft, name: event.target.value || undefined })} placeholder="例如 GPT-4o" /></label><label><span>上下文窗口（可选）</span><input type="number" min={1} value={draft.contextWindow ?? ""} onChange={(event) => setDraft({ ...draft, contextWindow: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label><label><span>最大输出 token（可选）</span><input type="number" min={1} value={draft.maxTokens ?? ""} onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label></div><div className="model-config-options"><label className="settings-checkbox"><input type="checkbox" checked={draft.reasoning} onChange={(event) => setDraft({ ...draft, reasoning: event.target.checked })} />支持思考</label><label className="settings-checkbox"><input type="checkbox" checked={draft.vision} onChange={(event) => setDraft({ ...draft, vision: event.target.checked })} />支持图片</label></div><div className="dialog-actions"><Button variant="secondary" onClick={onCancel}>取消</Button><Button onClick={() => onSave(draft)}>保存</Button></div></div>;
}

function AuthOperation({ operation, prompt, event, onRespond, onCancel, onClose }: { operation: AuthLoginOperation; prompt: AuthLoginOperation["prompt"]; event: AuthLoginOperation["event"]; onRespond: (value: string) => void; onCancel: () => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const options = useMemo(() => prompt?.options ?? [], [prompt?.options]);
  return <div className="auth-operation-overlay"><div className="auth-operation"><div className="settings-section-heading"><h2>{operation.state === "completed" ? "登录完成" : operation.state === "failed" ? "登录失败" : operation.state === "cancelled" ? "登录已取消" : "正在登录"}</h2><Button variant="ghost" size="icon" aria-label="取消登录" title="取消登录" onClick={operation.state === "running" ? onCancel : onClose}><X size={17} /></Button></div>{event?.message ? <p className="auth-event">{event.message}</p> : null}{event?.url ? <a className="auth-link" href={event.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开授权页面</a> : null}{operation.error ? <p className="settings-error">{operation.error}</p> : null}{operation.state === "running" && prompt ? <form className="auth-prompt" onSubmit={(eventSubmit) => { eventSubmit.preventDefault(); if (value.trim() !== "") { onRespond(value); setValue(""); } }}>{prompt.type === "select" ? <div className="auth-options">{options.map((option) => <button type="button" key={option.id} onClick={() => onRespond(option.id)}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</div> : <><label>{prompt.message}<input autoFocus type={prompt.type === "secret" ? "password" : "text"} placeholder={prompt.placeholder} value={value} onChange={(eventInput) => setValue(eventInput.target.value)} /></label><Button type="submit" disabled={value.trim() === ""}>提交</Button></>}</form> : null}{operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" ? <Button onClick={onClose}>关闭</Button> : null}</div></div>;
}
