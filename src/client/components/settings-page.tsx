import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, CircleAlert, CheckCircle2, ExternalLink, FolderPlus, Globe, KeyRound, LogOut, Plus, RotateCw, Save, Settings2, Trash2, X } from "lucide-react";
import type { AppSettings, AuthLoginOperation, ManagedModel, ManagedProvider, ProviderStatus, Workspace } from "../../shared/protocol";
import { api } from "../api";
import { isNotificationEnabled, requestNotificationPermission, setNotificationEnabled } from "../notifications";
import { Button } from "./ui/button";
import { WorkspaceDialog } from "./workspace-dialog";
import { Dialog, DialogContent } from "./ui/dialog";
import { TunnelPanel } from "./tunnel-panel";

interface SettingsPageProps {
  assistantName: string;
  uiMode: AppSettings["uiMode"];
  onAssistantNameChange: (name: string) => void;
  onUiModeChange: (mode: AppSettings["uiMode"]) => void;
  workspaces: Workspace[];
  onWorkspacesChange: (workspaces: Workspace[]) => void;
  onAddWorkspace: (path: string, label?: string) => Promise<void>;
  onRemoveWorkspace: (workspace: Workspace) => Promise<void>;
  onBack: () => void;
}

type SettingsTab = "general" | "providers" | "workspaces" | "tunnel";
type ProviderDialogStep = 1 | 2 | 3;
type SettingsMessageTone = "success" | "error";
const EMPTY_MODEL: ManagedModel = { id: "", reasoning: false, vision: false };
const EMPTY_PROVIDER: ManagedProvider = { id: "", baseUrl: "", api: "openai-completions", authHeader: true, models: [] };
const API_OPTIONS: Array<{ id: ManagedProvider["api"]; label: string; description: string }> = [
  { id: "openai-completions", label: "OpenAI Completions", description: "兼容 OpenAI Chat Completions 接口" },
  { id: "openai-responses", label: "OpenAI Responses", description: "使用 OpenAI Responses 接口" },
  { id: "anthropic-messages", label: "Anthropic Messages", description: "兼容 Anthropic Messages 接口" },
  { id: "google-generative-ai", label: "Google Generative AI", description: "使用 Google Generative AI 接口" },
];

export function SettingsPage({ assistantName, uiMode, workspaces, onWorkspacesChange, onAddWorkspace, onRemoveWorkspace, onAssistantNameChange, onUiModeChange, onBack }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [name, setName] = useState(assistantName);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(() => isNotificationEnabled());
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [customProviders, setCustomProviders] = useState<ManagedProvider[]>([]);
  const [provider, setProvider] = useState<ManagedProvider>({ ...EMPTY_PROVIDER });
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [providerDialogStep, setProviderDialogStep] = useState<ProviderDialogStep>(1);
  const [editingProvider, setEditingProvider] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [messageTone, setMessageTone] = useState<SettingsMessageTone>("success");
  const [operation, setOperation] = useState<AuthLoginOperation | undefined>();
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState<string | undefined>();
  const [workspaceRemoveTarget, setWorkspaceRemoveTarget] = useState<Workspace | undefined>();
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
      const [available, custom] = await Promise.all([api.providers(), api.customProviders()]);
      setProviders(available);
      setCustomProviders(custom);
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
  const saveUiMode = async (mode: AppSettings["uiMode"]) => {
    if (mode === uiMode || busy !== undefined) return;
    setBusy("ui-mode");
    try {
      const settings = await api.updateSettings({ uiMode: mode });
      onUiModeChange(settings.uiMode);
      showMessage(mode === "beautiful" ? "已切换到新版聊天界面" : "已切换到经典聊天界面");
    } catch (error) { showMessage(error instanceof Error ? error.message : "界面切换失败", "error"); }
    finally { setBusy(undefined); }
  };
  const restart = async () => {
    setRestartConfirmOpen(false); setRestarting(true);
    try { await api.selfRestart(); showMessage("正在重启，连接将短暂中断…"); }
    catch (error) { setRestarting(false); showMessage(error instanceof Error ? error.message : "重启请求失败", "error"); }
  };
  const startLogin = async (target: ProviderStatus, type: "api_key" | "oauth") => {
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
    setProvider({ ...EMPTY_PROVIDER, models: [] }); setEditingProvider(false); setProviderDialogStep(1); setProviderDialogOpen(true);
  };
  const openEditProvider = (target: ManagedProvider) => {
    setProvider({ ...target, models: target.models.map((model) => ({ ...model })) }); setEditingProvider(true); setProviderDialogStep(2); setProviderDialogOpen(true);
  };
  const saveProvider = async () => {
    setBusy("provider");
    try {
      const saved = await api.saveCustomProvider(provider);
      setCustomProviders((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.id.localeCompare(b.id)));
      setProviderDialogOpen(false); showMessage("供应商和模型配置已保存"); await reload();
    } catch (error) { showMessage(error instanceof Error ? error.message : "供应商保存失败", "error"); }
    finally { setBusy(undefined); }
  };
  const removeProvider = async (id: string) => {
    setBusy(id);
    try { await api.removeCustomProvider(id); setCustomProviders((current) => current.filter((item) => item.id !== id)); showMessage("供应商已删除"); await reload(); }
    catch (error) { showMessage(error instanceof Error ? error.message : "供应商删除失败", "error"); }
    finally { setBusy(undefined); }
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
        {tab === "general" ? <section className="settings-section"><h2>常规</h2><label className="settings-field"><span>助手名称</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveName(); }} /></label><Button onClick={() => { void saveName(); }} disabled={busy === "name" || name.trim() === ""}><Save size={15} />保存名称</Button><div className="ui-mode-setting"><div><strong>聊天界面</strong><p>新版仅调整聊天页，保留会话、工具和输入行为。</p></div><div className="ui-mode-picker" role="radiogroup" aria-label="聊天界面版本"><button type="button" role="radio" aria-checked={uiMode === "legacy"} className={uiMode === "legacy" ? "selected" : ""} disabled={busy === "ui-mode"} onClick={() => { void saveUiMode("legacy"); }}>经典</button><button type="button" role="radio" aria-checked={uiMode === "beautiful"} className={uiMode === "beautiful" ? "selected" : ""} disabled={busy === "ui-mode"} onClick={() => { void saveUiMode("beautiful"); }}>新版</button></div></div><label className="settings-field settings-checkbox"><input type="checkbox" checked={notificationsEnabled} onChange={(event) => { void toggleNotifications(event.target.checked); }} /><span>会话运行结束时弹出通知（页面在后台时）</span></label><div className="settings-section-heading"><h2>服务</h2></div><p className="settings-muted">重启服务会短暂中断所有连接（自动重连恢复），仅加载现有构建，不会编译。</p><Button variant="danger" disabled={restarting} onClick={() => setRestartConfirmOpen(true)}><RotateCw size={15} />{restarting ? "正在重启…" : "重启服务"}</Button></section> : null}
        {tab === "providers" ? <section className="settings-section"><div className="settings-section-heading"><div><h2>供应商与账号</h2><p className="settings-muted">统一管理连接凭据、供应商接口和可用模型。</p></div><Button size="sm" onClick={openNewProvider}><Plus size={14} />添加供应商</Button></div>{loading ? <p className="settings-muted">正在读取供应商…</p> : <div className="provider-list">{providers.length === 0 && customProviders.length === 0 ? <p className="settings-muted">暂无供应商配置</p> : providers.map((item) => <ProviderRow key={item.id} status={item} custom={customById.get(item.id)} busy={busy} onLogin={startLogin} onLogout={logout} onEdit={openEditProvider} onRemove={removeProvider} />)}{customProviders.filter((item) => !providers.some((status) => status.id === item.id)).map((item) => <article className="provider-row" key={item.id}><div className="provider-main"><strong>{item.name ?? item.id}</strong><small>{item.id} · {item.models.length} 个模型 · 未加载</small></div><div className="provider-status"><Button variant="secondary" size="sm" onClick={() => openEditProvider(item)}>编辑</Button><Button variant="ghost" size="icon" aria-label={`删除 ${item.id}`} title="删除供应商" disabled={busy === item.id} onClick={() => { void removeProvider(item.id); }}><Trash2 size={15} /></Button></div></article>)}</div>}</section> : null}
        {tab === "workspaces" ? <section className="settings-section"><div className="settings-section-heading"><h2>工作区</h2><Button size="sm" onClick={() => setWorkspaceDialogOpen(true)}><FolderPlus size={14} />添加工作区</Button></div>{workspaces.length === 0 ? <p className="settings-muted">暂无工作区</p> : <div className="provider-list">{workspaces.map((workspace, index) => <article className="provider-row workspace-settings-row" key={workspace.id}><div className="provider-main"><strong>{workspace.label}</strong><small>{workspace.cwd}</small></div><div className="provider-status workspace-settings-actions"><Button variant="ghost" size="icon" aria-label="上移工作区" title="上移" disabled={index === 0 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, -1); }}><ArrowUp size={15} /></Button><Button variant="ghost" size="icon" aria-label="下移工作区" title="下移" disabled={index === workspaces.length - 1 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, 1); }}><ArrowDown size={15} /></Button><Button variant="ghost" size="icon" aria-label={`删除工作区 ${workspace.label}`} title="删除工作区" disabled={workspaceBusy !== undefined} onClick={() => setWorkspaceRemoveTarget(workspace)}><Trash2 size={15} /></Button></div></article>)}</div>}</section> : null}
        {tab === "tunnel" ? <TunnelPanel onMessage={(nextMessage, tone) => showMessage(nextMessage, tone)} /> : null}
      </main>
    </div>
    <Dialog open={providerDialogOpen} onOpenChange={(open) => { if (!open && busy !== "provider") setProviderDialogOpen(false); }}><DialogContent className="provider-dialog" title={editingProvider ? "编辑供应商" : "添加供应商"} description="先选择接口，再填写连接信息，最后配置模型。"><ProviderWizard provider={provider} step={providerDialogStep} editing={editingProvider} busy={busy === "provider"} onChange={setProvider} onStepChange={setProviderDialogStep} onCancel={() => setProviderDialogOpen(false)} onSave={() => { void saveProvider(); }} /></DialogContent></Dialog>
    {operation === undefined ? null : <AuthOperation operation={operation} prompt={operation.prompt} event={operation.event} onRespond={(value) => { void api.respondLogin(operation.id, value).then(setOperation); }} onCancel={() => { void api.cancelLogin(operation.id).then(setOperation); }} onClose={() => setOperation(undefined)} />}
    <WorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} onAdd={onAddWorkspace} />
    <Dialog open={workspaceRemoveTarget !== undefined} onOpenChange={(open) => { if (!open && workspaceBusy === undefined) setWorkspaceRemoveTarget(undefined); }}><DialogContent title="删除工作区"><p className="delete-session-message"><strong>{workspaceRemoveTarget?.label ?? ""}</strong>及其会话历史将保留在磁盘上。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setWorkspaceRemoveTarget(undefined)} disabled={workspaceBusy !== undefined}>取消</Button><Button variant="danger" onClick={() => { void removeWorkspace(); }} disabled={workspaceBusy !== undefined}>删除</Button></div></DialogContent></Dialog>
    <Dialog open={restartConfirmOpen} onOpenChange={(open) => { if (!open && !restarting) setRestartConfirmOpen(false); }}><DialogContent title="重启服务"><p className="delete-session-message">所有会话将断开数秒，随后自动重连恢复。重启仅加载现有构建，不会编译。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setRestartConfirmOpen(false)} disabled={restarting}>取消</Button><Button variant="danger" onClick={() => { void restart(); }} disabled={restarting}>重启</Button></div></DialogContent></Dialog>
  </section>;
}

function ProviderRow({ status, custom, busy, onLogin, onLogout, onEdit, onRemove }: { status: ProviderStatus; custom?: ManagedProvider; busy?: string; onLogin: (provider: ProviderStatus, type: "api_key" | "oauth") => void; onLogout: (provider: ProviderStatus) => void; onEdit: (provider: ManagedProvider) => void; onRemove: (id: string) => void }) {
  const modelCount = custom?.models.length || status.models.length;
  return <article className="provider-row"><div className="provider-main"><strong>{custom?.name ?? status.name}</strong><small>{status.id} · {modelCount} 个模型{custom === undefined ? " · 内置供应商" : " · 已启用配置"}</small></div><div className="provider-status">{status.authConfigured ? <><span className="status-ready"><Check size={14} />{status.authSource ?? "已配置"}</span><Button variant="ghost" size="icon" aria-label={`退出 ${status.name}`} title={`退出 ${status.name}`} disabled={busy === status.id} onClick={() => onLogout(status)}><LogOut size={15} /></Button></> : <>{status.supportsApiKey ? <Button variant="secondary" size="sm" disabled={busy === status.id} onClick={() => onLogin(status, "api_key")}><KeyRound size={13} />API Key</Button> : null}{status.supportsOAuth ? <Button variant="secondary" size="sm" disabled={busy === status.id} onClick={() => onLogin(status, "oauth")}><ExternalLink size={13} />登录</Button> : null}</>}{custom === undefined ? null : <><Button variant="secondary" size="sm" onClick={() => onEdit(custom)}>编辑</Button><Button variant="ghost" size="icon" aria-label={`删除 ${status.id}`} title="删除供应商配置" disabled={busy === status.id} onClick={() => onRemove(status.id)}><Trash2 size={15} /></Button></>}</div></article>;
}

function ProviderWizard({ provider, step, editing, busy, onChange, onStepChange, onCancel, onSave }: { provider: ManagedProvider; step: ProviderDialogStep; editing: boolean; busy: boolean; onChange: (provider: ManagedProvider) => void; onStepChange: (step: ProviderDialogStep) => void; onCancel: () => void; onSave: () => void }) {
  const detailsValid = provider.id.trim() !== "" && provider.baseUrl.trim() !== "";
  const modelsValid = provider.models.length > 0 && provider.models.every((model) => model.id.trim() !== "");
  const updateModel = (index: number, patch: Partial<ManagedModel>) => onChange({ ...provider, models: provider.models.map((model, current) => current === index ? { ...model, ...patch } : model) });
  return <div className="provider-wizard"><div className="provider-steps"><span className={step === 1 ? "active" : "complete"}>1 选择接口</span><span className={step === 2 ? "active" : step === 3 ? "complete" : ""}>2 连接信息</span><span className={step === 3 ? "active" : ""}>3 模型配置</span></div>
    {step === 1 ? <div className="api-choice-list">{API_OPTIONS.map((option) => <button type="button" key={option.id} className={`api-choice ${provider.api === option.id ? "selected" : ""}`} onClick={() => onChange({ ...provider, api: option.id })}><span><strong>{option.label}</strong><small>{option.description}</small></span>{provider.api === option.id ? <Check size={16} /> : null}</button>)}</div> : null}
    {step === 2 ? <div className="provider-editor-grid"><label><span>ID</span><input value={provider.id} disabled={editing} autoFocus={!editing} onChange={(event) => onChange({ ...provider, id: event.target.value })} placeholder="例如 my-provider" /></label><label><span>显示名称（可选）</span><input value={provider.name ?? ""} onChange={(event) => onChange({ ...provider, name: event.target.value || undefined })} placeholder="例如 我的模型服务" /></label><label className="provider-editor-wide"><span>Base URL</span><input value={provider.baseUrl} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label><label className="settings-checkbox"><input type="checkbox" checked={provider.authHeader} onChange={(event) => onChange({ ...provider, authHeader: event.target.checked })} /><span>发送 Bearer Authorization</span></label></div> : null}
    {step === 3 ? <div className="model-config"><div className="settings-section-heading"><div><strong>模型配置</strong><p className="settings-muted">至少添加一个模型后才能保存，模型会出现在会话顶部的模型选择器中。</p></div><Button variant="secondary" size="sm" onClick={() => onChange({ ...provider, models: [...provider.models, { ...EMPTY_MODEL }] })}><Plus size={14} />添加模型</Button></div>{provider.models.length === 0 ? <div className="model-empty">尚未配置模型，请点击“添加模型”。</div> : <div className="model-config-list">{provider.models.map((model, index) => <div className="model-config-card" key={`${index}-${model.id}`}><div className="model-config-fields"><label><span>模型 ID</span><input autoFocus={index === provider.models.length - 1 && model.id === ""} value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} placeholder="例如 gpt-4o" /></label><label><span>显示名称（可选）</span><input value={model.name ?? ""} onChange={(event) => updateModel(index, { name: event.target.value || undefined })} placeholder="例如 GPT-4o" /></label><label><span>上下文窗口（可选）</span><input type="number" min={1} value={model.contextWindow ?? ""} onChange={(event) => updateModel(index, { contextWindow: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label><label><span>最大输出 token（可选）</span><input type="number" min={1} value={model.maxTokens ?? ""} onChange={(event) => updateModel(index, { maxTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder="自动" /></label></div><div className="model-config-options"><label className="settings-checkbox"><input type="checkbox" checked={model.reasoning} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} />支持思考</label><label className="settings-checkbox"><input type="checkbox" checked={model.vision} onChange={(event) => updateModel(index, { vision: event.target.checked })} />支持图片</label>{provider.models.length > 1 ? <Button variant="ghost" size="icon" aria-label="删除模型" title="删除模型" onClick={() => onChange({ ...provider, models: provider.models.filter((_, current) => current !== index) })}><Trash2 size={14} /></Button> : null}</div></div>)}</div>}</div> : null}
    <div className="dialog-actions"><Button variant="secondary" onClick={step === 1 || (step === 2 && editing) ? onCancel : () => onStepChange((step - 1) as ProviderDialogStep)}>{step === 1 || (step === 2 && editing) ? "取消" : "上一步"}</Button>{step === 1 ? <Button onClick={() => onStepChange(2)}>下一步</Button> : step === 2 ? <Button disabled={!detailsValid} onClick={() => onStepChange(3)}>配置模型</Button> : <Button disabled={busy || !modelsValid} onClick={onSave}><Save size={14} />{busy ? "保存中…" : "确认并保存"}</Button>}</div>
  </div>;
}

function AuthOperation({ operation, prompt, event, onRespond, onCancel, onClose }: { operation: AuthLoginOperation; prompt: AuthLoginOperation["prompt"]; event: AuthLoginOperation["event"]; onRespond: (value: string) => void; onCancel: () => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const options = useMemo(() => prompt?.options ?? [], [prompt?.options]);
  return <div className="auth-operation-overlay"><div className="auth-operation"><div className="settings-section-heading"><h2>{operation.state === "completed" ? "登录完成" : operation.state === "failed" ? "登录失败" : operation.state === "cancelled" ? "登录已取消" : "正在登录"}</h2><Button variant="ghost" size="icon" aria-label="取消登录" title="取消登录" onClick={operation.state === "running" ? onCancel : onClose}><X size={17} /></Button></div>{event?.message ? <p className="auth-event">{event.message}</p> : null}{event?.url ? <a className="auth-link" href={event.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开授权页面</a> : null}{operation.error ? <p className="settings-error">{operation.error}</p> : null}{operation.state === "running" && prompt ? <form className="auth-prompt" onSubmit={(eventSubmit) => { eventSubmit.preventDefault(); if (value.trim() !== "") { onRespond(value); setValue(""); } }}>{prompt.type === "select" ? <div className="auth-options">{options.map((option) => <button type="button" key={option.id} onClick={() => onRespond(option.id)}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</div> : <><label>{prompt.message}<input autoFocus type={prompt.type === "secret" ? "password" : "text"} placeholder={prompt.placeholder} value={value} onChange={(eventInput) => setValue(eventInput.target.value)} /></label><Button type="submit" disabled={value.trim() === ""}>提交</Button></>}</form> : null}{operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" ? <Button onClick={onClose}>关闭</Button> : null}</div></div>;
}
