import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Bell, Bot, CheckCircle2, CircleAlert, FolderGit2, FolderPlus, Globe, KeyRound, RotateCw, ShieldCheck, Trash2, X } from "lucide-react";
import type { AppSettings, AuthLoginOperation, ManagedModel, ManagedProvider, ProviderStatus, Workspace } from "../../shared/protocol";
import { api } from "../api";
import { isNotificationEnabled, requestNotificationPermission, setNotificationEnabled } from "../notifications";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { WorkspaceDialog } from "./workspace-dialog";
import { TunnelPanel } from "./tunnel-panel";
import { SecurityPanel } from "./settings-security";
import {
  AuthOperation,
  initializeDraft,
  isProviderUsable,
  modelKey,
  ModelScopePage,
  ProviderDetailPage,
  ProvidersListPage,
  ProviderWizardPage,
  splitModelKey,
} from "./settings-providers";
import { SettingsEmpty, SettingsGroup, SettingsRow, SettingsShell, SettingsSubpage, SettingsSwitch, SettingsTopBar } from "./settings-ui";

interface SettingsPageProps {
  assistantName: string;
  onAssistantNameChange: (name: string) => void;
  workspaces: Workspace[];
  onWorkspacesChange: (workspaces: Workspace[]) => void;
  onAddWorkspace: (path: string, label?: string) => Promise<void>;
  onRemoveWorkspace: (workspace: Workspace) => Promise<void>;
  onBack: () => void;
}

type SettingsMessageTone = "success" | "error";
type SettingsRoute =
  | { page: "home" }
  | { page: "assistant-name" }
  | { page: "providers" }
  | { page: "provider"; providerId: string }
  | { page: "provider-new" }
  | { page: "provider-edit"; providerId: string }
  | { page: "model-scope" }
  | { page: "workspaces" }
  | { page: "tunnel" }
  | { page: "security" };

/** 设置入口：分组首页 + 内部子页栈，PC/移动端使用同一信息架构。 */
export function SettingsPage({ assistantName, workspaces, onWorkspacesChange, onAddWorkspace, onRemoveWorkspace, onAssistantNameChange, onBack }: SettingsPageProps) {
  const [stack, setStack] = useState<SettingsRoute[]>([{ page: "home" }]);
  const [name, setName] = useState(assistantName);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(() => isNotificationEnabled());
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [customProviders, setCustomProviders] = useState<ManagedProvider[]>([]);
  const [enabledDraft, setEnabledDraft] = useState<Set<string>>(new Set());
  const [providersShowAll, setProvidersShowAll] = useState(false);
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
  const [tunnelSummary, setTunnelSummary] = useState<string>();
  const [securitySummary, setSecuritySummary] = useState<string>();

  const route = stack[stack.length - 1] ?? { page: "home" };
  const showMessage = (nextMessage: string, tone: SettingsMessageTone = "success") => { setMessageTone(tone); setMessage(nextMessage); };
  const push = (nextRoute: SettingsRoute) => setStack((current) => [...current, nextRoute]);
  const goBack = () => setStack((current) => current.length > 1 ? current.slice(0, -1) : current);
  const replaceTop = (nextRoute: SettingsRoute) => setStack((current) => [...current.slice(0, -1), nextRoute]);

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
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "无法加载设置", "error");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);

  // 首页只展示当前摘要；具体页会各自读取和轮询完整数据。
  useEffect(() => {
    let disposed = false;
    void api.tunnelList().then((tunnels) => {
      if (disposed) return;
      const running = tunnels.filter((tunnel) => tunnel.state === "running").length;
      setTunnelSummary(tunnels.length === 0 ? "未设置" : running > 0 ? `${String(running)} 运行中` : "已停止");
    }).catch(() => { if (!disposed) setTunnelSummary(""); });
    void api.authStatus().then(({ auth }) => { if (!disposed) setSecuritySummary(auth.required ? "已启用" : "未启用"); })
      .catch(() => { if (!disposed) setSecuritySummary(""); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (operation === undefined || operation.state !== "running") return;
    const timer = window.setInterval(() => {
      void api.loginStatus(operation.id).then((next) => {
        setOperation(next);
        if (next.state === "completed") void reload();
      }).catch((error: unknown) => showMessage(error instanceof Error ? error.message : "登录状态读取失败", "error"));
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation?.id, operation?.state]);

  // 删除后不保留指向已删除供应商的详情/编辑页。
  useEffect(() => {
    setStack((current) => {
      const next = current.filter((item) => {
        if (item.page === "provider") return providers.some((provider) => provider.id === item.providerId);
        if (item.page === "provider-edit") return customProviders.some((provider) => provider.id === item.providerId);
        return true;
      });
      return next.length === current.length ? current : next.length === 0 ? [{ page: "home" }] : next;
    });
  }, [providers, customProviders]);

  const saveName = async (nextName: string): Promise<boolean> => {
    setBusy("name");
    try {
      const settings: AppSettings = await api.updateSettings({ assistantName: nextName });
      onAssistantNameChange(settings.assistantName);
      setName(settings.assistantName);
      showMessage("已保存");
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "名称保存失败", "error");
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const restart = async () => {
    setRestartConfirmOpen(false);
    setRestarting(true);
    try {
      await api.selfRestart();
      showMessage("正在重启，连接将短暂中断…");
    } catch (error) {
      setRestarting(false);
      showMessage(error instanceof Error ? error.message : "重启请求失败", "error");
    }
  };
  const startLogin = async (target: ProviderStatus, type: "api_key" | "oauth") => {
    setBusy(target.id);
    try {
      setOperation(await api.startLogin(target.id, type));
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "登录启动失败", "error");
    } finally {
      setBusy(undefined);
    }
  };
  const logout = async (target: ProviderStatus) => {
    setBusy(target.id);
    try {
      await api.logoutProvider(target.id);
      await reload();
      showMessage(`已退出 ${target.name}`);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "退出登录失败", "error");
    } finally {
      setBusy(undefined);
    }
  };
  const saveProvider = async (provider: ManagedProvider, openModelsAfterSave: boolean) => {
    setBusy("provider");
    try {
      const saved = await api.saveCustomProvider(provider);
      setCustomProviders((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((left, right) => left.id.localeCompare(right.id)));
      showMessage(saved.models.length === 0 ? "供应商已保存" : "供应商和模型配置已保存");
      await reload();
      if (openModelsAfterSave) replaceTop({ page: "provider", providerId: saved.id });
      else goBack();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "供应商保存失败", "error");
    } finally {
      setBusy(undefined);
    }
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
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "供应商删除失败", "error");
    } finally {
      setBusy(undefined);
    }
  };
  const persistEnabled = async (next: Set<string>): Promise<boolean> => {
    const allKeys = new Set(providers.filter(isProviderUsable).flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id))));
    const scoped = new Set([...next].filter((key) => allKeys.has(key)));
    if (scoped.size === 0 && allKeys.size > 0) {
      showMessage("请至少启用一个模型", "error");
      return false;
    }
    setBusy("model-manager");
    try {
      const unrestricted = allKeys.size > 0 && scoped.size === allKeys.size;
      const status = await api.updateEnabledModels(unrestricted ? [] : [...scoped].map((key) => splitModelKey(key)));
      setEnabledDraft(initializeDraft(providers, status));
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "模型保存失败", "error");
      await reload();
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const persistCustomModels = async (providerId: string, models: ManagedModel[]): Promise<boolean> => {
    const current = customProviders.find((provider) => provider.id === providerId);
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
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "模型保存失败", "error");
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const toggleModelInstant = (providerId: string, modelId: string) => {
    const key = modelKey(providerId, modelId);
    const next = new Set(enabledDraft);
    if (next.has(key)) next.delete(key); else next.add(key);
    setEnabledDraft(next);
    void persistEnabled(next);
  };
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
    const next = [...workspaces];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(targetIndex, 0, item);
    setWorkspaceBusy("order");
    try {
      onWorkspacesChange(await api.reorderWorkspaces(next.map((workspace) => workspace.id)));
      showMessage("工作区顺序已保存");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "工作区排序失败", "error");
    } finally {
      setWorkspaceBusy(undefined);
    }
  };
  const removeWorkspace = async () => {
    const workspace = workspaceRemoveTarget;
    if (workspace === undefined || workspaceBusy !== undefined) return;
    setWorkspaceBusy(workspace.id);
    try {
      await onRemoveWorkspace(workspace);
      setWorkspaceRemoveTarget(undefined);
      showMessage("工作区已删除");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "工作区删除失败", "error");
    } finally {
      setWorkspaceBusy(undefined);
    }
  };
  const toggleNotifications = async (enabled: boolean) => {
    if (enabled) {
      const permission = await requestNotificationPermission();
      if (permission !== "granted") return;
      setNotificationEnabled(true);
      setNotificationsEnabledState(true);
      return;
    }
    setNotificationEnabled(false);
    setNotificationsEnabledState(false);
  };

  const customById = useMemo(() => new Map(customProviders.map((provider) => [provider.id, provider])), [customProviders]);
  const allModelKeys = useMemo(() => new Set(providers.filter(isProviderUsable).flatMap((provider) => provider.models.map((model) => modelKey(provider.id, model.id)))), [providers]);
  const unrestricted = allModelKeys.size > 0 && [...allModelKeys].every((key) => enabledDraft.has(key));
  const providerSummary = useMemo(() => {
    if (loading) return "…";
    const connected = providers.filter(isProviderUsable).length;
    return connected === 0 ? "未配置" : `${String(connected)} 已连接 · ${String(enabledDraft.size)} 模型`;
  }, [providers, enabledDraft, loading]);

  let page: React.ReactNode;
  if (route.page === "home") {
    page = <><SettingsTopBar title="设置" home onBack={onBack} /><SettingsShell><div className="settings-stack">
      <SettingsGroup title="常规">
        <SettingsRow icon={Bot} label="助手名称" value={name} chevron onClick={() => push({ page: "assistant-name" })} />
        <SettingsRow icon={Bell} label="运行结束通知" control={<SettingsSwitch checked={notificationsEnabled} onChange={(enabled) => { void toggleNotifications(enabled); }} label="运行结束通知" />} />
      </SettingsGroup>
      <SettingsGroup title="连接">
        <SettingsRow icon={KeyRound} label="供应商与账号" value={providerSummary} chevron onClick={() => push({ page: "providers" })} />
        <SettingsRow icon={FolderGit2} label="工作区" value={workspaces.length === 0 ? "未添加" : `${String(workspaces.length)} 个`} chevron onClick={() => push({ page: "workspaces" })} />
        <SettingsRow icon={Globe} label="内网穿透" value={tunnelSummary} chevron onClick={() => push({ page: "tunnel" })} />
      </SettingsGroup>
      <SettingsGroup title="服务">
        <SettingsRow icon={ShieldCheck} label="安全" value={securitySummary} chevron onClick={() => push({ page: "security" })} />
        <SettingsRow icon={RotateCw} label={restarting ? "正在重启…" : "重启服务"} danger disabled={restarting} onClick={() => setRestartConfirmOpen(true)} />
      </SettingsGroup>
    </div></SettingsShell></>;
  } else if (route.page === "assistant-name") {
    page = <AssistantNamePage initialName={name} busy={busy === "name"} onSave={saveName} onBack={goBack} />;
  } else if (route.page === "providers") {
    page = <ProvidersListPage providers={providers} customProviders={customProviders} customById={customById} enabledDraft={enabledDraft} loading={loading} showAll={providersShowAll} unrestricted={unrestricted}
      onShowAllChange={setProvidersShowAll} onOpenScope={() => push({ page: "model-scope" })} onOpenProvider={(providerId) => push({ page: "provider", providerId })}
      onEditCustom={(provider) => push({ page: "provider-edit", providerId: provider.id })} onAddProvider={() => push({ page: "provider-new" })} onBack={goBack} />;
  } else if (route.page === "provider") {
    const provider = providers.find((item) => item.id === route.providerId);
    page = provider === undefined ? <SettingsSubpage title="供应商" onBack={goBack}><p className="settings-page-note">正在读取供应商…</p></SettingsSubpage> : <ProviderDetailPage provider={provider} custom={customById.get(provider.id)} draft={enabledDraft} busy={busy}
      onToggleModel={toggleModelInstant} onEnableModels={enableModelsInstant} onCustomModels={persistCustomModels} onLogin={startLogin} onLogout={logout}
      onEdit={(custom) => push({ page: "provider-edit", providerId: custom.id })} onFetch={api.fetchProviderModels} onBack={goBack} />;
  } else if (route.page === "provider-new") {
    page = <ProviderWizardPage providers={providers} busy={busy === "provider"} onSave={saveProvider} onLogin={startLogin} onBack={goBack} />;
  } else if (route.page === "provider-edit") {
    const custom = customProviders.find((item) => item.id === route.providerId);
    page = custom === undefined ? <SettingsSubpage title="供应商" onBack={goBack}><p className="settings-page-note">正在读取供应商…</p></SettingsSubpage> : <ProviderWizardPage providers={providers} editing={custom} busy={busy === "provider"} onSave={saveProvider} onDelete={setProviderRemoveTarget} onLogin={startLogin} onBack={goBack} />;
  } else if (route.page === "model-scope") {
    page = <ModelScopePage providers={providers} customById={customById} draft={enabledDraft} busy={busy === "model-manager"} onToggleModel={toggleModelInstant} onBack={goBack} />;
  } else if (route.page === "workspaces") {
    page = <WorkspacesPage workspaces={workspaces} busy={workspaceBusy} onMove={moveWorkspace} onRemove={setWorkspaceRemoveTarget} onAdd={() => setWorkspaceDialogOpen(true)} onBack={goBack} />;
  } else if (route.page === "tunnel") {
    page = <SettingsSubpage title="内网穿透" onBack={goBack}><TunnelPanel onMessage={(nextMessage, tone) => showMessage(nextMessage, tone)} /></SettingsSubpage>;
  } else {
    page = <SettingsSubpage title="安全" onBack={goBack}><SecurityPanel onMessage={(nextMessage, tone) => showMessage(nextMessage, tone)} /></SettingsSubpage>;
  }

  return <section className="settings-page">
    {page}
    {message === undefined ? null : <div className={`toast-surface settings-toast ${messageTone}`} role={messageTone === "error" ? "alert" : "status"}><span className="toast-surface-icon">{messageTone === "error" ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}</span><span>{message}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage(undefined)}><X size={14} /></button></div>}
    {operation === undefined ? null : <AuthOperation operation={operation} prompt={operation.prompt} event={operation.event} onRespond={(value) => { void api.respondLogin(operation.id, value).then(setOperation); }} onCancel={() => { void api.cancelLogin(operation.id).then(setOperation); }} onClose={() => setOperation(undefined)} />}
    <WorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} onAdd={onAddWorkspace} />
    <Dialog open={providerRemoveTarget !== undefined} onOpenChange={(open) => { if (!open && busy === undefined) setProviderRemoveTarget(undefined); }}><DialogContent title="删除供应商"><p className="delete-session-message"><strong>{providerRemoveTarget?.name ?? providerRemoveTarget?.id ?? ""}</strong>的接口配置与 {String(providerRemoveTarget?.models.length ?? 0)} 个模型将被删除，此操作不可撤销。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setProviderRemoveTarget(undefined)} disabled={busy !== undefined}>取消</Button><Button variant="danger" onClick={() => { void removeProvider(); }} disabled={busy !== undefined}>删除</Button></div></DialogContent></Dialog>
    <Dialog open={workspaceRemoveTarget !== undefined} onOpenChange={(open) => { if (!open && workspaceBusy === undefined) setWorkspaceRemoveTarget(undefined); }}><DialogContent title="删除工作区"><p className="delete-session-message"><strong>{workspaceRemoveTarget?.label ?? ""}</strong>及其会话历史将保留在磁盘上。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setWorkspaceRemoveTarget(undefined)} disabled={workspaceBusy !== undefined}>取消</Button><Button variant="danger" onClick={() => { void removeWorkspace(); }} disabled={workspaceBusy !== undefined}>删除</Button></div></DialogContent></Dialog>
    <Dialog open={restartConfirmOpen} onOpenChange={(open) => { if (!open && !restarting) setRestartConfirmOpen(false); }}><DialogContent title="重启服务"><p className="delete-session-message">所有会话将断开数秒，随后自动重连恢复。重启仅加载现有构建，不会编译。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setRestartConfirmOpen(false)} disabled={restarting}>取消</Button><Button variant="danger" onClick={() => { void restart(); }} disabled={restarting}>重启</Button></div></DialogContent></Dialog>
  </section>;
}

function AssistantNamePage({ initialName, busy, onSave, onBack }: { initialName: string; busy: boolean; onSave: (name: string) => Promise<boolean>; onBack: () => void }) {
  const [draft, setDraft] = useState(initialName);
  useEffect(() => setDraft(initialName), [initialName]);
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave(draft).then((saved) => { if (saved) onBack(); });
  };
  return <SettingsSubpage title="助手名称" onBack={onBack}>
    <form className="settings-stack" onSubmit={save}>
      <SettingsGroup><label className="settings-form-field"><span>名称</span><input autoFocus value={draft} maxLength={64} onChange={(event) => setDraft(event.target.value)} /></label></SettingsGroup>
      <Button type="submit" disabled={busy || draft.trim() === ""}>保存</Button>
    </form>
  </SettingsSubpage>;
}

function WorkspacesPage({ workspaces, busy, onMove, onRemove, onAdd, onBack }: { workspaces: Workspace[]; busy?: string; onMove: (index: number, direction: -1 | 1) => void; onRemove: (workspace: Workspace) => void; onAdd: () => void; onBack: () => void }) {
  return <SettingsSubpage title="工作区" onBack={onBack}>
    <div className="settings-stack">
      {workspaces.length === 0 ? <SettingsEmpty icon={FolderPlus} title="还没有工作区" actionLabel="添加工作区" onAction={onAdd} /> : <SettingsGroup>
        {workspaces.map((workspace, index) => <div className="settings-row settings-workspace-row" key={workspace.id}>
          <span className="settings-row-main"><strong>{workspace.label}</strong><small>{workspace.cwd}</small></span>
          <span className="settings-row-actions">
            <Button variant="ghost" size="icon" aria-label="上移工作区" title="上移" disabled={index === 0 || busy !== undefined} onClick={() => onMove(index, -1)}><ArrowUp size={15} /></Button>
            <Button variant="ghost" size="icon" aria-label="下移工作区" title="下移" disabled={index === workspaces.length - 1 || busy !== undefined} onClick={() => onMove(index, 1)}><ArrowDown size={15} /></Button>
            <Button variant="ghost" size="icon" aria-label={`删除工作区 ${workspace.label}`} title="删除工作区" disabled={busy !== undefined} onClick={() => onRemove(workspace)}><Trash2 size={15} /></Button>
          </span>
        </div>)}
        <SettingsRow icon={FolderPlus} label="添加工作区" accent onClick={onAdd} />
      </SettingsGroup>}
    </div>
  </SettingsSubpage>;
}
