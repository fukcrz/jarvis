import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, ExternalLink, FolderPlus, KeyRound, LogOut, Plus, Save, Settings2, Trash2, X } from "lucide-react";
import type { AppSettings, AuthLoginOperation, ManagedModel, ManagedProvider, ProviderStatus, Workspace } from "../../shared/protocol";
import { api } from "../api";
import { isNotificationEnabled, requestNotificationPermission, setNotificationEnabled } from "../notifications";
import { Button } from "./ui/button";
import { WorkspaceDialog } from "./workspace-dialog";
import { Dialog, DialogContent } from "./ui/dialog";

interface SettingsPageProps {
  assistantName: string;
  onAssistantNameChange: (name: string) => void;
  workspaces: Workspace[];
  onWorkspacesChange: (workspaces: Workspace[]) => void;
  onAddWorkspace: (path: string, label?: string) => Promise<void>;
  onRemoveWorkspace: (workspace: Workspace) => Promise<void>;
  onBack: () => void;
}

type SettingsTab = "general" | "accounts" | "providers" | "workspaces";
const EMPTY_MODEL: ManagedModel = { id: "", reasoning: false, vision: false };
const EMPTY_PROVIDER: ManagedProvider = { id: "", baseUrl: "", api: "openai-completions", authHeader: true, models: [{ ...EMPTY_MODEL }] };

export function SettingsPage({ assistantName, workspaces, onWorkspacesChange, onAddWorkspace, onRemoveWorkspace, onAssistantNameChange, onBack }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [name, setName] = useState(assistantName);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(() => isNotificationEnabled());
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [customProviders, setCustomProviders] = useState<ManagedProvider[]>([]);
  const [provider, setProvider] = useState<ManagedProvider>({ ...EMPTY_PROVIDER, models: [{ ...EMPTY_MODEL }] });
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [operation, setOperation] = useState<AuthLoginOperation | undefined>();
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState<string | undefined>();
  const [workspaceRemoveTarget, setWorkspaceRemoveTarget] = useState<Workspace | undefined>();

  const reload = async () => {
    setLoading(true);
    try {
      const [available, custom] = await Promise.all([api.providers(), api.customProviders()]);
      setProviders(available);
      setCustomProviders(custom);
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法加载设置"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);

  useEffect(() => {
    if (operation === undefined || operation.state !== "running") return;
    const timer = window.setInterval(() => {
      void api.loginStatus(operation.id).then((next) => { setOperation(next); if (next.state === "completed") void reload(); }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "登录状态读取失败"));
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation?.id, operation?.state]);

  const saveName = async () => {
    setBusy("name");
    try { const settings: AppSettings = await api.updateSettings(name); onAssistantNameChange(settings.assistantName); setName(settings.assistantName); setMessage("已保存"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "名称保存失败"); }
    finally { setBusy(undefined); }
  };

  const startLogin = async (target: ProviderStatus, type: "api_key" | "oauth") => {
    setAccountPickerOpen(false);
    setBusy(target.id);
    try { setOperation(await api.startLogin(target.id, type)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "登录启动失败"); }
    finally { setBusy(undefined); }
  };

  const logout = async (target: ProviderStatus) => {
    setBusy(target.id);
    try { await api.logoutProvider(target.id); await reload(); setMessage(`已退出 ${target.name}`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "退出登录失败"); }
    finally { setBusy(undefined); }
  };

  const saveProvider = async () => {
    setBusy("provider");
    try { const saved = await api.saveCustomProvider(provider); setCustomProviders((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.id.localeCompare(b.id))); setEditing(false); setMessage("供应商配置已保存"); await reload(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "供应商保存失败"); }
    finally { setBusy(undefined); }
  };

  const removeProvider = async (id: string) => {
    setBusy(id);
    try { await api.removeCustomProvider(id); setCustomProviders((current) => current.filter((item) => item.id !== id)); setMessage("供应商已删除"); await reload(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "供应商删除失败"); }
    finally { setBusy(undefined); }
  };

  const moveWorkspace = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= workspaces.length || workspaceBusy !== undefined) return;
    const next = [...workspaces];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(targetIndex, 0, item);
    setWorkspaceBusy("order");
    try { onWorkspacesChange(await api.reorderWorkspaces(next.map((workspace) => workspace.id))); setMessage("工作区顺序已保存"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "工作区排序失败"); }
    finally { setWorkspaceBusy(undefined); }
  };

  const removeWorkspace = async () => {
    const workspace = workspaceRemoveTarget;
    if (workspace === undefined || workspaceBusy !== undefined) return;
    setWorkspaceBusy(workspace.id);
    try { await onRemoveWorkspace(workspace); setWorkspaceRemoveTarget(undefined); setMessage("工作区已删除"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "工作区删除失败"); }
    finally { setWorkspaceBusy(undefined); }
  };

  const operationPrompt = operation?.prompt;
  const operationEvent = operation?.event;
  // 运行结束通知开关：开启时请求浏览器权限（须在用户手势内调用）。
  const toggleNotifications = async (enabled: boolean) => {
    if (enabled) {
      const permission = await requestNotificationPermission();
      if (permission !== "granted") return; // 未授权（拒绝/不支持）：保持关闭
      setNotificationEnabled(true);
      setNotificationsEnabledState(true);
      return;
    }
    setNotificationEnabled(false);
    setNotificationsEnabledState(false);
  };
  return <section className="settings-page">
    <header className="settings-header"><Button variant="ghost" size="icon" aria-label="返回会话" title="返回会话" onClick={onBack}><X size={18} /></Button><h1>设置</h1></header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" className={tab === "general" ? "selected" : ""} onClick={() => setTab("general")}><Settings2 size={16} />常规</button>
        <button type="button" className={tab === "accounts" ? "selected" : ""} onClick={() => setTab("accounts")}><KeyRound size={16} />账号与登录</button>
        <button type="button" className={tab === "providers" ? "selected" : ""} onClick={() => setTab("providers")}><Plus size={16} />供应商配置</button>
        <button type="button" className={tab === "workspaces" ? "selected" : ""} onClick={() => setTab("workspaces")}><FolderPlus size={16} />工作区</button>
      </nav>
      <main className="settings-content">
        {message === undefined ? null : <div className="settings-message" role="status"><span>{message}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage(undefined)}><X size={14} /></button></div>}
        {tab === "general" ? <section className="settings-section"><h2>常规</h2><label className="settings-field"><span>助手名称</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveName(); }} /></label><Button onClick={() => { void saveName(); }} disabled={busy === "name" || name.trim() === ""}><Save size={15} />保存名称</Button><label className="settings-field settings-checkbox"><input type="checkbox" checked={notificationsEnabled} onChange={(event) => { void toggleNotifications(event.target.checked); }} /><span>会话运行结束时弹出通知（页面在后台时）</span></label></section> : null}
        {tab === "accounts" ? <section className="settings-section"><div className="settings-section-heading"><h2>账号与登录</h2><Button variant="secondary" size="sm" onClick={() => setAccountPickerOpen((open) => !open)}><Plus size={14} />添加账号</Button></div>{loading ? <p className="settings-muted">正在读取供应商…</p> : <>{accountPickerOpen ? <div className="account-picker"><strong>选择供应商</strong>{providers.filter((item) => !item.authConfigured).map((item) => <div className="account-picker-row" key={item.id}><div className="provider-main"><strong>{item.name}</strong><small>{item.id}</small></div><div className="provider-status">{item.supportsApiKey ? <Button variant="secondary" size="sm" disabled={busy === item.id} onClick={() => { void startLogin(item, "api_key"); }}><KeyRound size={13} />API Key</Button> : null}{item.supportsOAuth ? <Button variant="secondary" size="sm" disabled={busy === item.id} onClick={() => { void startLogin(item, "oauth"); }}><ExternalLink size={13} />登录</Button> : null}</div></div>)}{providers.every((item) => item.authConfigured) ? <span className="settings-muted">没有可添加的供应商</span> : null}</div> : null}<div className="provider-list">{providers.filter((item) => item.authConfigured).map((item) => <article className="provider-row" key={item.id}><div className="provider-main"><strong>{item.name}</strong><small>{item.id} · {item.models.length} 个模型</small></div><div className="provider-status"><span className="status-ready"><Check size={14} />{item.authSource ?? "已配置"}</span><Button variant="ghost" size="icon" aria-label={`退出 ${item.name}`} title={`退出 ${item.name}`} disabled={busy === item.id} onClick={() => { void logout(item); }}><LogOut size={15} /></Button></div></article>)}{providers.every((item) => !item.authConfigured) && !accountPickerOpen ? <span className="settings-muted">暂无已登录账号</span> : null}</div></>}</section> : null}
        {tab === "providers" ? <section className="settings-section"><div className="settings-section-heading"><h2>供应商配置</h2><Button size="sm" onClick={() => { setProvider({ ...EMPTY_PROVIDER, models: [{ ...EMPTY_MODEL }] }); setEditing(true); }}><Plus size={14} />添加供应商</Button></div>{editing ? <ProviderEditor provider={provider} onChange={setProvider} onCancel={() => setEditing(false)} onSave={() => { void saveProvider(); }} busy={busy === "provider"} /> : <div className="provider-list">{customProviders.length === 0 ? <p className="settings-muted">暂无自定义供应商</p> : customProviders.map((item) => <article className="provider-row" key={item.id}><div className="provider-main"><strong>{item.name ?? item.id}</strong><small>{item.id} · {item.baseUrl} · {item.models.length} 个模型</small></div><div className="provider-status"><Button variant="secondary" size="sm" onClick={() => { setProvider(item); setEditing(true); }}>编辑</Button><Button variant="ghost" size="icon" aria-label={`删除 ${item.id}`} title="删除供应商" disabled={busy === item.id} onClick={() => { void removeProvider(item.id); }}><Trash2 size={15} /></Button></div></article>)}</div>}</section> : null}
        {tab === "workspaces" ? <section className="settings-section"><div className="settings-section-heading"><h2>工作区</h2><Button size="sm" onClick={() => setWorkspaceDialogOpen(true)}><FolderPlus size={14} />添加工作区</Button></div>{workspaces.length === 0 ? <p className="settings-muted">暂无工作区</p> : <div className="provider-list">{workspaces.map((workspace, index) => <article className="provider-row workspace-settings-row" key={workspace.id}><div className="provider-main"><strong>{workspace.label}</strong><small>{workspace.cwd}</small></div><div className="provider-status workspace-settings-actions"><Button variant="ghost" size="icon" aria-label="上移工作区" title="上移" disabled={index === 0 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, -1); }}><ArrowUp size={15} /></Button><Button variant="ghost" size="icon" aria-label="下移工作区" title="下移" disabled={index === workspaces.length - 1 || workspaceBusy !== undefined} onClick={() => { void moveWorkspace(index, 1); }}><ArrowDown size={15} /></Button><Button variant="ghost" size="icon" aria-label={`删除工作区 ${workspace.label}`} title="删除工作区" disabled={workspaceBusy !== undefined} onClick={() => setWorkspaceRemoveTarget(workspace)}><Trash2 size={15} /></Button></div></article>)}</div>}</section> : null}
      </main>
    </div>
    {operation === undefined ? null : <AuthOperation operation={operation} prompt={operationPrompt} event={operationEvent} onRespond={(value) => { void api.respondLogin(operation.id, value).then(setOperation); }} onCancel={() => { void api.cancelLogin(operation.id).then(setOperation); }} onClose={() => setOperation(undefined)} />}
    <WorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} onAdd={onAddWorkspace} />
    <Dialog open={workspaceRemoveTarget !== undefined} onOpenChange={(open) => { if (!open && workspaceBusy === undefined) setWorkspaceRemoveTarget(undefined); }}><DialogContent title="删除工作区"><p className="delete-session-message"><strong>{workspaceRemoveTarget?.label ?? ""}</strong>及其会话历史将保留在磁盘上。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setWorkspaceRemoveTarget(undefined)} disabled={workspaceBusy !== undefined}>取消</Button><Button variant="danger" onClick={() => { void removeWorkspace(); }} disabled={workspaceBusy !== undefined}>删除</Button></div></DialogContent></Dialog>
  </section>;
}

function ProviderEditor({ provider, onChange, onCancel, onSave, busy }: { provider: ManagedProvider; onChange: (provider: ManagedProvider) => void; onCancel: () => void; onSave: () => void; busy: boolean }) {
  const updateModel = (index: number, patch: Partial<ManagedModel>) => onChange({ ...provider, models: provider.models.map((model, current) => current === index ? { ...model, ...patch } : model) });
  return <div className="provider-editor"><div className="provider-editor-grid"><label><span>ID</span><input value={provider.id} disabled={provider.id !== ""} onChange={(event) => onChange({ ...provider, id: event.target.value })} /></label><label><span>名称</span><input value={provider.name ?? ""} onChange={(event) => onChange({ ...provider, name: event.target.value || undefined })} /></label><label className="provider-editor-wide"><span>Base URL</span><input value={provider.baseUrl} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} /></label><label><span>API</span><select value={provider.api} onChange={(event) => onChange({ ...provider, api: event.target.value as ManagedProvider["api"] })}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label><label className="settings-checkbox"><input type="checkbox" checked={provider.authHeader} onChange={(event) => onChange({ ...provider, authHeader: event.target.checked })} /><span>发送 Bearer Authorization</span></label></div><div className="model-editor-list"><div className="settings-section-heading"><strong>模型</strong><Button variant="ghost" size="sm" onClick={() => onChange({ ...provider, models: [...provider.models, { ...EMPTY_MODEL }] })}><Plus size={14} />添加模型</Button></div>{provider.models.map((model, index) => <div className="model-editor-row" key={`${index}-${model.id}`}><input placeholder="模型 ID" value={model.id} onChange={(event) => updateModel(index, { id: event.target.value })} /><input placeholder="显示名称" value={model.name ?? ""} onChange={(event) => updateModel(index, { name: event.target.value || undefined })} /><label className="settings-checkbox"><input type="checkbox" checked={model.reasoning} onChange={(event) => updateModel(index, { reasoning: event.target.checked })} />思考</label><label className="settings-checkbox"><input type="checkbox" checked={model.vision} onChange={(event) => updateModel(index, { vision: event.target.checked })} />图片</label>{provider.models.length > 1 ? <Button variant="ghost" size="icon" aria-label="删除模型" title="删除模型" onClick={() => onChange({ ...provider, models: provider.models.filter((_, current) => current !== index) })}><Trash2 size={14} /></Button> : null}</div>)}</div><div className="dialog-actions"><Button variant="secondary" onClick={onCancel}>取消</Button><Button onClick={onSave} disabled={busy}><Save size={14} />保存供应商</Button></div></div>;
}

function AuthOperation({ operation, prompt, event, onRespond, onCancel, onClose }: { operation: AuthLoginOperation; prompt: AuthLoginOperation["prompt"]; event: AuthLoginOperation["event"]; onRespond: (value: string) => void; onCancel: () => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const options = useMemo(() => prompt?.options ?? [], [prompt?.options]);
  return <div className="auth-operation-overlay"><div className="auth-operation"><div className="settings-section-heading"><h2>{operation.state === "completed" ? "登录完成" : operation.state === "failed" ? "登录失败" : operation.state === "cancelled" ? "登录已取消" : "正在登录"}</h2><Button variant="ghost" size="icon" aria-label="取消登录" title="取消登录" onClick={operation.state === "running" ? onCancel : onClose}><X size={17} /></Button></div>{event?.message ? <p className="auth-event">{event.message}</p> : null}{event?.url ? <a className="auth-link" href={event.url} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开授权页面</a> : null}{operation.error ? <p className="settings-error">{operation.error}</p> : null}{operation.state === "running" && prompt ? <form className="auth-prompt" onSubmit={(eventSubmit) => { eventSubmit.preventDefault(); if (value.trim() !== "") { onRespond(value); setValue(""); } }}>{prompt.type === "select" ? <div className="auth-options">{options.map((option) => <button type="button" key={option.id} onClick={() => onRespond(option.id)}><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</button>)}</div> : <><label>{prompt.message}<input autoFocus type={prompt.type === "secret" ? "password" : "text"} placeholder={prompt.placeholder} value={value} onChange={(eventInput) => setValue(eventInput.target.value)} /></label><Button type="submit" disabled={value.trim() === ""}>提交</Button></>}</form> : null}{operation.state === "completed" || operation.state === "failed" || operation.state === "cancelled" ? <Button onClick={onClose}>关闭</Button> : null}</div></div>;
}
