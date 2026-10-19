import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Copy, Download, FolderPlus, GripVertical, Info, MoreVertical, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import type { AppSettings, Workspace } from "../../shared/protocol";
import type { RecoveryNotice } from "../../shared/system";
import { api, type SystemInfo } from "../api";
import { getDesktopUpdateChannel, setDesktopNotificationEnabled, setDesktopUpdateChannel, type DesktopUpdateChannel } from "../desktop";
import { APP_VERSION, CHECK_UPDATE_EVENT } from "../lib/app-version";
import { isDesktopShell } from "../lib/desktop-shell";
import { isNotificationEnabled, notificationPermission, requestNotificationPermission, setNotificationEnabled } from "../notifications";
import { SaveState, SettingsConfirm, useDebouncedSave, useSaveStatus, useSettingsToast } from "./settings-feedback";
import { Kbd, SectionAction, Segmented, SettingRow, SettingsCard, SettingsEmptyLine, SettingsPageHead, SettingsSection, SettingsSwitch, SettingsTag, StButton } from "./settings-ui";
import { WorkspaceDialog } from "./workspace-dialog";
import { modKeyLabel } from "./settings-search";
import { useIsMobile } from "../hooks/use-is-mobile";

/* ------------------------------ 通用 ------------------------------ */

export function GeneralPage({ assistantName, onAssistantNameChange, extra }: { assistantName: string; onAssistantNameChange: (name: string) => void; extra?: React.ReactNode }) {
  const saveStatus = useSaveStatus();
  const isMobile = useIsMobile();
  const [name, setName] = useState(assistantName);
  const committed = useRef(assistantName);
  const debounced = useDebouncedSave(name, (value) => {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === committed.current) return;
    const previous = committed.current;
    committed.current = trimmed;
    void saveStatus.run("assistant-name", async () => {
      const settings: AppSettings = await api.updateSettings({ assistantName: trimmed });
      committed.current = settings.assistantName;
      onAssistantNameChange(settings.assistantName);
    }, { rollback: () => { committed.current = previous; } });
  });
  useEffect(() => {
    // 别处改了名字（另一台设备、服务器推送）：没在输入时跟着更新。
    if (assistantName === committed.current) return;
    committed.current = assistantName;
    debounced.reset(assistantName);
    setName(assistantName);
  }, [assistantName, debounced]);
  return <>
    <SettingsPageHead title="通用" description="基础信息与快捷键。改动立即生效。" />
    <SettingsSection id="basics" title="基本">
      <SettingsCard>
        <SettingRow id="assistant-name" title="助手名称" description={name.trim() === "" ? "名称留空不会保存，继续使用原来的名字" : "显示在欢迎页、通知和登录页上"}
          control={<><SaveState k="assistant-name" /><input className="st-inline-input" aria-label="助手名称" value={name} maxLength={64}
            onChange={(event) => { setName(event.target.value); debounced.schedule(); }} onBlur={debounced.flush}
            onKeyDown={(event) => { if (event.key === "Enter") debounced.flush(); }} /></>} />
      </SettingsCard>
    </SettingsSection>
    {isMobile ? null : <SettingsSection id="shortcuts" title="快捷键">
      <SettingsCard>
        <SettingRow id="shortcut-open-settings" title="打开设置" description="在任意页面按下即可打开设置" control={<Kbd>{modKeyLabel()} ,</Kbd>} />
        <SettingRow id="shortcut-search-settings" title="搜索设置" description="在设置里按下，搜索并跳到对应项" control={<Kbd>{modKeyLabel()} K</Kbd>} />
      </SettingsCard>
    </SettingsSection>}
    {extra}
  </>;
}

/* ------------------------------ 通知 ------------------------------ */

export function NotificationsPage({ enabled, onEnabledChange }: { enabled: boolean; onEnabledChange: (enabled: boolean) => void }) {
  const saveStatus = useSaveStatus();
  const toast = useSettingsToast();
  const desktop = isDesktopShell();
  const permission = desktop ? "granted" : notificationPermission();
  const toggle = (next: boolean) => {
    onEnabledChange(next);
    void saveStatus.run("notifications", async () => {
      if (desktop) {
        await setDesktopNotificationEnabled(next);
        setNotificationEnabled(next);
        return;
      }
      if (next) {
        const result = await requestNotificationPermission();
        if (result !== "granted") throw new Error(result === "unsupported" ? "这个浏览器不支持通知" : "浏览器没有授权通知，请在地址栏左侧的网站设置里允许");
      }
      setNotificationEnabled(next);
    }, { rollback: () => onEnabledChange(!next) }).then((ok) => { if (!ok && !desktop) toast.notify("通知没有打开：浏览器未授权", "error"); });
  };
  return <>
    <SettingsPageHead title="通知" description="运行结束时提醒你。桌面端用系统通知，浏览器里需要先授权。" />
    <SettingsSection id="run-notifications" title="运行结束">
      <SettingsCard>
        <SettingRow id="notify-run-finished" title="运行结束时通知" description={desktop ? "AI 回复完成、出错或需要你确认时，弹出系统通知" : "AI 回复完成、出错或需要你确认时，弹出浏览器通知（页面在后台时）"}
          control={<><SaveState k="notifications" /><SettingsSwitch checked={enabled} onChange={toggle} label="运行结束时通知" /></>} />
        {desktop ? null : <SettingRow title="浏览器授权" description={permission === "granted" ? "已允许这个网站发通知" : permission === "denied" ? "已被拒绝：需要在浏览器的网站设置里改回允许" : permission === "unsupported" ? "这个浏览器不支持通知" : "打开开关时会询问"}
          control={<SettingsTag tone={permission === "granted" ? "ok" : permission === "denied" ? "warn" : undefined}>{permission === "granted" ? "已允许" : permission === "denied" ? "已拒绝" : permission === "unsupported" ? "不支持" : "未询问"}</SettingsTag>} />}
      </SettingsCard>
    </SettingsSection>
  </>;
}

export function initialNotificationsEnabled(): boolean {
  return isNotificationEnabled();
}

/* ------------------------------ 关于与更新 ------------------------------ */

export function AboutPage({ children }: { children?: React.ReactNode }) {
  const saveStatus = useSaveStatus();
  const toast = useSettingsToast();
  const [channel, setChannel] = useState<DesktopUpdateChannel>();
  const [info, setInfo] = useState<SystemInfo>();
  const [recoveries, setRecoveries] = useState<RecoveryNotice[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api.systemInfo().then((value) => { if (!cancelled) setInfo(value); }, () => undefined);
    void api.recoveries().then((value) => { if (!cancelled) setRecoveries(value); }, () => undefined);
    return () => { cancelled = true; };
  }, []);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getDesktopUpdateChannel().then((value) => { if (!cancelled) setChannel(value); }, () => undefined);
    return () => { cancelled = true; };
  }, []);
  const changeChannel = (next: DesktopUpdateChannel) => {
    const previous = channel;
    setChannel(next);
    void saveStatus.run("update-channel", () => setDesktopUpdateChannel(next), { rollback: () => setChannel(previous) });
  };
  const restart = async () => {
    setRestarting(true);
    try {
      await api.selfRestart();
      setRestartOpen(false);
      toast.notify("正在重启，连接会短暂中断…");
    } catch (error) {
      setRestarting(false);
      toast.notify(error instanceof Error ? error.message : "重启请求失败", "error");
    }
  };
  const desktop = isDesktopShell();
  const versionText = APP_VERSION === undefined ? "未知版本" : `v${APP_VERSION}`;
  const copyVersion = () => {
    const lines = [`Jarvis ${versionText}`, `运行方式：${desktop ? "桌面端" : "网页"}`, `更新通道：${channel === "beta" ? "测试版" : channel === "stable" ? "正式版" : "—"}`, `浏览器：${navigator.userAgent}`];
    void navigator.clipboard.writeText(lines.join("\n")).then(() => toast.notify("已复制版本信息"), () => toast.notify("复制失败，请手动选择文字复制", "error"));
  };
  return <>
    <SettingsPageHead title="关于与更新" description="Jarvis 版本、更新、服务维护与诊断。" />
    {children}
    {(info?.warnings ?? []).length === 0 ? null : <SettingsSection id="startup-warnings" title="启动提示">
      <SettingsCard>{(info?.warnings ?? []).map((warning) => <SettingRow key={warning} leading={<AlertTriangle size={15} className="st-row-glyph warn" />} title={warning} />)}</SettingsCard>
    </SettingsSection>}
    {recoveries.length === 0 ? null : <SettingsSection id="recoveries" title="本次启动的配置恢复">
      <SettingsCard>{recoveries.map((notice) => <SettingRow key={`${notice.file}:${notice.at}`} title={fileName(notice.file)}
        description={`${notice.outcome === "backup" ? "读取失败，已从备份恢复" : "读取失败且没有可用备份，已改用默认值"}（${notice.reason}）${notice.corruptPath === undefined ? "" : `。坏文件留在 ${notice.corruptPath}`}`}
        control={<SettingsTag tone={notice.outcome === "backup" ? "acc" : "warn"}>{notice.outcome === "backup" ? "已恢复" : "已重置"}</SettingsTag>} />)}</SettingsCard>
    </SettingsSection>}
    <SettingsSection id="updates" title="版本与更新">
      <SettingsCard>
        <SettingRow id="version" leading={<span className="st-row-icon acc"><Info size={15} /></span>} title={<>Jarvis<span className="st-sub-id">{versionText}</span></>}
          description={desktop ? "桌面端会定期自动检查更新，也可以手动检查" : "网页版跟随这台电脑上的 Jarvis 服务；在桌面端更新后刷新页面即可"}
          control={desktop ? <StButton onClick={() => window.dispatchEvent(new Event(CHECK_UPDATE_EVENT))}><RefreshCw size={13} />检查更新</StButton> : <SettingsTag>网页</SettingsTag>} />
        {channel === undefined ? null : <SettingRow id="update-channel" title="更新通道" description={channel === "beta" ? "测试版：检查更新时会收到测试版和正式版中较新的一个" : "正式版：只接收正式版更新"}
          control={<><SaveState k="update-channel" /><Segmented label="更新通道" value={channel} options={[{ value: "stable", label: "正式版" }, { value: "beta", label: "测试版" }]} onChange={changeChannel} /></>} />}
      </SettingsCard>
    </SettingsSection>
    <SettingsSection id="service" title="服务">
      <SettingsCard>
        <SettingRow id="restart-service" title="重启服务" description="所有会话会断开几秒，随后自动重连" control={<StButton disabled={restarting} onClick={() => setRestartOpen(true)}><RotateCw size={13} className={restarting ? "spin" : undefined} />{restarting ? "正在重启…" : "重启"}</StButton>} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection id="about-diagnostics" title="诊断">
      <SettingsCard>
        <SettingRow id="diagnostics" title="导出诊断包" description="版本、配置（不含密码和 token）和最近的服务日志，反馈问题时附上" control={<a className="st-btn" href="/api/system/diagnostics" download><Download size={13} />导出</a>} />
        <SettingRow title="复制版本信息" description="版本号、运行方式、更新通道和浏览器信息" control={<StButton onClick={copyVersion}><Copy size={13} />复制</StButton>} />
        {info?.snapshotDirectory === undefined ? null : <SettingRow id="snapshots" title={`每日快照（保留 ${String(info.snapshotKeep ?? 7)} 份）`} mono
          description={info.snapshots === undefined || info.snapshots.length === 0 ? `还没有快照 · ${info.snapshotDirectory}` : `最近一份 ${info.snapshots[0]?.name.replace(/\.zip$/, "") ?? ""}，共 ${String(info.snapshots.length)} 份 · ${info.snapshotDirectory}`} />}
      </SettingsCard>
    </SettingsSection>
    <SettingsConfirm open={restartOpen} busy={restarting} danger title="重启服务？" confirmLabel="重启" onCancel={() => setRestartOpen(false)} onConfirm={() => { void restart(); }}>
      <p>所有会话会断开几秒，正在运行的回复会中断，随后自动重连恢复。</p>
    </SettingsConfirm>
  </>;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/* ------------------------------ 工作区 ------------------------------ */

export function WorkspacesPage({ workspaces, onWorkspacesChange, onAddWorkspace, onRemoveWorkspace }: {
  workspaces: Workspace[];
  onWorkspacesChange: (workspaces: Workspace[]) => void;
  onAddWorkspace: (path: string, label?: string) => Promise<void>;
  onRemoveWorkspace: (workspace: Workspace) => Promise<void>;
}) {
  const saveStatus = useSaveStatus();
  const toast = useSettingsToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removePending, setRemovePending] = useState<Workspace>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string>();
  const [overId, setOverId] = useState<string>();
  const dragRef = useRef<{ id: string; pointerId: number; startY: number; moved: boolean } | undefined>(undefined);
  const [mobileMenuId, setMobileMenuId] = useState<string>();
  const visible = workspaces.filter((workspace) => !hidden.has(workspace.id));
  const latest = useRef(workspaces);
  latest.current = workspaces;

  const reorder = (next: Workspace[]) => {
    const previous = latest.current;
    onWorkspacesChange(next);
    void saveStatus.run("workspace-order", async () => { onWorkspacesChange(await api.reorderWorkspaces(next.map((workspace) => workspace.id))); }, { rollback: () => onWorkspacesChange(previous) });
  };
  const move = (id: string, targetId: string) => {
    if (id === targetId) return;
    const next = [...latest.current];
    const from = next.findIndex((workspace) => workspace.id === id);
    const to = next.findIndex((workspace) => workspace.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    reorder(next);
  };
  const shift = (index: number, direction: -1 | 1) => {
    const target = visible[index + direction];
    const current = visible[index];
    if (target !== undefined && current !== undefined) move(current.id, target.id);
  };
  const finishDrag = (commit: boolean) => {
    const drag = dragRef.current;
    dragRef.current = undefined;
    setDragId(undefined);
    setOverId(undefined);
    document.body.classList.remove("workspace-reordering");
    if (commit && drag?.moved && overId !== undefined) move(drag.id, overId);
  };
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === undefined || drag.pointerId !== event.pointerId) return;
      if (!drag.moved && Math.abs(event.clientY - drag.startY) < 6) return;
      drag.moved = true;
      event.preventDefault();
      setDragId(drag.id);
      document.body.classList.add("workspace-reordering");
      const rows = [...document.querySelectorAll<HTMLElement>(".st-ws-row")];
      const target = rows.find((row) => {
        const bounds = row.getBoundingClientRect();
        return event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      });
      if (target !== undefined) setOverId(target.id.replace("setting-workspace-", ""));
    };
    const onUp = (event: PointerEvent) => { if (dragRef.current?.pointerId === event.pointerId) finishDrag(true); };
    const onCancel = (event: PointerEvent) => { if (dragRef.current?.pointerId === event.pointerId) finishDrag(false); };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.classList.remove("workspace-reordering");
    };
  }, [overId]);
  const remove = (workspace: Workspace) => {
    const setHide = (value: boolean) => setHidden((current) => { const next = new Set(current); if (value) next.add(workspace.id); else next.delete(workspace.id); return next; });
    setHide(true);
    toast.showUndo({
      message: `已移除工作区 ${workspace.label}（文件和会话记录仍留在磁盘上）`,
      undo: () => setHide(false),
      commit: async () => { await onRemoveWorkspace(workspace); setHide(false); },
      onCommitError: (error) => { setHide(false); toast.notify(error instanceof Error ? error.message : "工作区删除失败", "error"); },
    });
  };
  const rename = (workspace: Workspace, label: string) => {
    void saveStatus.run(`workspace:${workspace.id}`, async () => {
      const saved = await api.renameWorkspace(workspace.id, label);
      onWorkspacesChange(latest.current.map((item) => item.id === saved.id ? saved : item));
    });
  };

  return <>
    <SettingsPageHead title="工作区" description="会话按工作区分组。拖动调整侧栏顺序，名称可以直接改。" />
    <SettingsSection id="workspace-list" title="工作区" hint={`${String(visible.length)} 个`} action={<span className="st-inline"><SaveState k="workspace-order" /><SectionAction label="添加工作区" icon={FolderPlus} onClick={() => setDialogOpen(true)} /></span>}>
      <SettingsCard>
        {visible.length === 0 ? <SettingsEmptyLine>还没有工作区。添加一个项目文件夹，就能在里面开会话。</SettingsEmptyLine> : visible.map((workspace, index) => <div key={workspace.id}
          className={`st-row st-ws-row${dragId === workspace.id ? " dragging" : ""}${overId === workspace.id && dragId !== workspace.id ? " drop" : ""}`} id={`setting-workspace-${workspace.id}`}
          >
          <span className="st-grip" title="拖动排序" aria-hidden onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragRef.current = { id: workspace.id, pointerId: event.pointerId, startY: event.clientY, moved: false };
          }}><GripVertical size={15} /></span>
          <WorkspaceName workspace={workspace} onRename={rename} />
          <span className="st-ctl st-ws-actions">
            <SaveState k={`workspace:${workspace.id}`} />
            <span className="st-ws-desktop-actions">
              <StButton variant="ghost" icon aria-label={`上移 ${workspace.label}`} title="上移" disabled={index === 0} onClick={() => shift(index, -1)}><ArrowUp size={14} /></StButton>
              <StButton variant="ghost" icon aria-label={`下移 ${workspace.label}`} title="下移" disabled={index === visible.length - 1} onClick={() => shift(index, 1)}><ArrowDown size={14} /></StButton>
              <StButton variant="ghost" icon aria-label={`移除 ${workspace.label}`} title="移除（不删文件）" onClick={() => setRemovePending(workspace)}><Trash2 size={14} /></StButton>
            </span>
            <span className="st-ws-mobile-actions">
              <StButton variant="ghost" icon aria-label={`打开 ${workspace.label} 操作`} title="更多操作" onClick={() => setMobileMenuId((current) => current === workspace.id ? undefined : workspace.id)}><MoreVertical size={16} /></StButton>
              {mobileMenuId === workspace.id ? <span className="st-ws-menu">
                <button type="button" disabled={index === 0} onClick={() => { shift(index, -1); setMobileMenuId(undefined); }}><ArrowUp size={14} />上移</button>
                <button type="button" disabled={index === visible.length - 1} onClick={() => { shift(index, 1); setMobileMenuId(undefined); }}><ArrowDown size={14} />下移</button>
                <button type="button" className="danger" onClick={() => { setRemovePending(workspace); setMobileMenuId(undefined); }}><Trash2 size={14} />移除</button>
              </span> : null}
            </span>
          </span>
        </div>)}
      </SettingsCard>
    </SettingsSection>
    <WorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} onAdd={onAddWorkspace} />
    <SettingsConfirm open={removePending !== undefined} busy={false} danger title="移除工作区？" confirmLabel="移除" onCancel={() => setRemovePending(undefined)} onConfirm={() => {
      if (removePending === undefined) return;
      const workspace = removePending;
      setRemovePending(undefined);
      remove(workspace);
    }}>
      <p><b>{removePending?.label}</b> 将从工作区列表移除，文件和会话记录仍保留在磁盘上。</p>
    </SettingsConfirm>
  </>;
}

function WorkspaceName({ workspace, onRename }: { workspace: Workspace; onRename: (workspace: Workspace, label: string) => void }) {
  const [label, setLabel] = useState(workspace.label);
  const debounced = useDebouncedSave(label, (value) => { if (value.trim() !== "" && value.trim() !== workspace.label) onRename(workspace, value.trim()); });
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setLabel(workspace.label);
    debounced.reset(workspace.label);
  }, [workspace.label, debounced]);
  return <span className="st-row-text">
    <input className="st-name-input" aria-label={`${workspace.label} 的名称`} value={label} placeholder={workspace.label}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; debounced.flush(); if (label.trim() === "") setLabel(workspace.label); }}
      onChange={(event) => { setLabel(event.target.value); debounced.schedule(); }}
      onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
    <small className="mono" title={workspace.cwd}>{workspace.cwd}</small>
  </span>;
}
