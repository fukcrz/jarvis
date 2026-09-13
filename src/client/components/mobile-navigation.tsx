import { useEffect, useMemo, useState, type PointerEvent } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CircleDot, Focus, Folder, LoaderCircle, MoreVertical, Plus, Search, Settings2, Star } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, isSessionRunning, sessionAttentionLabel, sessionAttentionRank, sessionAttentionState, sessionLabel, sessionListWindow, sortSessionSummaries } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface MobileSessionSwitcherProps {
  workspaces: Workspace[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  selectedSessionId?: string;
  onCreateSession: (workspaceId: string) => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onOpenSessionMenu: (workspaceId: string, session: SessionSummary) => void;
  onOpenSearch: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  onAddProject: () => void;
  assistantName: string;
  onOpenSettings: () => void;
  onOpenFiles: () => void;
  onOpenProjectMenu: (workspace: Workspace) => void;
}

interface MobileSessionGroup {
  workspace: Workspace;
  sessions: SessionSummary[];
}

const MOBILE_EXPANDED_GROUPS_STORAGE_KEY = "jarvis.mobile.projects.expanded";

function projectAttentionRank(sessions: SessionSummary[]): number {
  return sessions.reduce((rank, session) => Math.min(rank, sessionAttentionRank(session)), 4);
}

function projectLatestAttentionAt(sessions: SessionSummary[]): string {
  return sessions.reduce((latest, session) => {
    const at = session.attentionAt ?? "";
    return at.localeCompare(latest) > 0 ? at : latest;
  }, "");
}

function projectLatestUserMessageAt(sessions: SessionSummary[]): string {
  return sessions.reduce((latest, session) => {
    const at = session.lastUserMessageAt ?? session.createdAt;
    return at.localeCompare(latest) > 0 ? at : latest;
  }, "");
}

/** 项目芯片顺序：关注状态优先，同档按进入该档的时间，再按用户上次发送。 */
export function sortWorkspacesByAttention(workspaces: Workspace[], sessionsByWorkspace: Record<string, SessionSummary[]>): Workspace[] {
  return [...workspaces].sort((a, b) => {
    const aSessions = sessionsByWorkspace[a.id] ?? [];
    const bSessions = sessionsByWorkspace[b.id] ?? [];
    return projectAttentionRank(aSessions) - projectAttentionRank(bSessions)
      || projectLatestAttentionAt(bSessions).localeCompare(projectLatestAttentionAt(aSessions))
      || projectLatestUserMessageAt(bSessions).localeCompare(projectLatestUserMessageAt(aSessions))
      || a.sortOrder - b.sortOrder;
  });
}

export function shouldShowMobileSessionGroup(sessionCount: number, focusMode: boolean): boolean {
  return sessionCount > 0 || focusMode;
}

export function projectAttentionSession(sessions: SessionSummary[]): SessionSummary | undefined {
  const session = sortSessionSummaries(sessions)[0];
  return session === undefined || sessionAttentionLabel(session) === undefined ? undefined : session;
}

export function MobileSessionSwitcher(props: MobileSessionSwitcherProps) {
  const [workspaceFilter, setWorkspaceFilter] = useState(() => window.localStorage.getItem("jarvis.mobile.session-project") ?? "all");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  /** 全部视图：项目组展开状态（默认全部收起，同 PC 侧栏）。 */
  const [expandedGroupIds, setExpandedGroupIds] = useState<Record<string, boolean>>(readMobileExpandedGroups);
  /** 展开的组内会话窗口步数（默认窗口 + 每次「展开更多」+1，同 PC 侧栏）。 */
  const [sessionExpandSteps, setSessionExpandSteps] = useState<Record<string, number>>({});
  useEffect(() => {
    if (workspaceFilter !== "all" && !props.workspaces.some((workspace) => workspace.id === workspaceFilter)) {
      setWorkspaceFilter("all");
      return;
    }
    window.localStorage.setItem("jarvis.mobile.session-project", workspaceFilter);
  }, [props.workspaces, workspaceFilter]);
  useEffect(() => {
    saveMobileExpandedGroups(expandedGroupIds);
  }, [expandedGroupIds]);
  const requestCreateSession = () => {
    if (workspaceFilter === "all") {
      setProjectPickerOpen(true);
      return;
    }
    props.onCreateSession(workspaceFilter);
  };
  // 按项目分桶：组顺序跟 PC 侧栏一致；组内按关注档、进入该档时间、用户发送时间排。
  const groups = useMemo<MobileSessionGroup[]>(() => {
    const result: MobileSessionGroup[] = [];
    for (const workspace of props.workspaces) {
      if (workspaceFilter !== "all" && workspace.id !== workspaceFilter) continue;
      const sessions = sortSessionSummaries(props.sessionsByWorkspace[workspace.id] ?? []);
      if (!shouldShowMobileSessionGroup(sessions.length, props.focusMode)) continue;
      result.push({ workspace, sessions });
    }
    return result;
  }, [props.workspaces, props.sessionsByWorkspace, workspaceFilter]);
  const projectChips = useMemo(() => sortWorkspacesByAttention(props.workspaces, props.sessionsByWorkspace), [props.workspaces, props.sessionsByWorkspace]);
  const toggleGroup = (workspaceId: string) => {
    setExpandedGroupIds((current) => ({ ...current, [workspaceId]: current[workspaceId] !== true }));
  };
  const expandGroupSessions = (workspaceId: string) => {
    setSessionExpandSteps((current) => ({ ...current, [workspaceId]: (current[workspaceId] ?? 0) + 1 }));
  };
  const collapseGroupSessions = (workspaceId: string) => {
    setSessionExpandSteps((current) => ({ ...current, [workspaceId]: 0 }));
  };
  const renderSessionRows = (workspaceId: string, sessions: SessionSummary[]) => sessions.map((session) => (
    <MobileSessionRow key={`${workspaceId}:${session.id}`} session={session} selected={session.id === props.selectedSessionId} onSelect={() => props.onSelectSession(workspaceId, session.id)} onMenu={() => props.onOpenSessionMenu(workspaceId, session)} />
  ));
  return <section className="mobile-page mobile-all-sessions-page" aria-label="全部会话">
    <header className="mobile-switcher-header"><strong>{props.assistantName}</strong><div className="mobile-switcher-actions"><Button variant="ghost" size="icon" aria-label="搜索会话" title="搜索会话" onClick={props.onOpenSearch}><Search size={16} /></Button><Button variant="ghost" size="icon" className={`session-focus-toggle${props.focusMode ? " active" : ""}`} aria-label={props.focusMode ? "关闭聚焦会话" : "开启聚焦会话"} aria-pressed={props.focusMode} title={props.focusMode ? "关闭聚焦会话" : "开启聚焦会话"} onClick={props.onToggleFocusMode}><Focus size={16} /></Button><Button variant="ghost" size="icon" aria-label="查看文件" title="文件" onClick={props.onOpenFiles}><Folder size={16} /></Button><Button variant="ghost" size="icon" aria-label="打开设置" title="设置" onClick={props.onOpenSettings}><Settings2 size={16} /></Button><Button variant="ghost" size="icon" aria-label="新建会话" onClick={requestCreateSession} disabled={props.workspaces.length === 0}><Plus size={16} /></Button></div></header>
    <nav className="mobile-session-projects" aria-label="按项目筛选会话"><button type="button" className={workspaceFilter === "all" ? "selected" : ""} onClick={() => setWorkspaceFilter("all")}>全部</button>{projectChips.map((workspace) => {
      const attentionSession = projectAttentionSession(props.sessionsByWorkspace[workspace.id] ?? []);
      return <button type="button" key={workspace.id} className={workspaceFilter === workspace.id ? "selected" : ""} aria-label={`${workspace.label}${attentionSession === undefined ? "" : `，${sessionAttentionLabel(attentionSession)}`}`} onClick={() => { if (!consumeLongPress()) setWorkspaceFilter(workspace.id); }} onContextMenu={(event) => { event.preventDefault(); props.onOpenProjectMenu(workspace); }} onPointerDown={(event) => startLongPress(event, () => props.onOpenProjectMenu(workspace))} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress}><span className="mobile-project-label">{workspace.label}</span><MobileProjectStatus session={attentionSession} /></button>;
    })}<button type="button" className="mobile-add-project" aria-label="添加项目" onClick={props.onAddProject}><Plus size={15} /></button></nav>
    <div className="mobile-page-list mobile-switcher-list">
      {groups.length === 0 ? <div className="mobile-page-empty">{props.focusMode ? "暂无聚焦会话" : "暂无会话"}</div> : null}
      {workspaceFilter !== "all" ? groups.map(({ workspace, sessions }) => <div className="mobile-session-group-list" key={workspace.id}>{renderSessionRows(workspace.id, sessions)}</div>) : groups.map(({ workspace, sessions }) => {
        // 默认收起：与 PC 侧栏一致，只显示项目头；展开后按窗口展示会话（关注中的始终可见）。
        const expanded = expandedGroupIds[workspace.id] === true;
        const listWindow = sessionListWindow(sessions, sessionExpandSteps[workspace.id] ?? 0);
        const attention = expanded ? undefined : sessions[0];
        return <section className={`mobile-session-group${expanded ? " expanded" : ""}`} key={workspace.id}>
          <div className="mobile-session-group-header">
            <button type="button" className="mobile-session-group-toggle" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${workspace.label}的会话`} onClick={() => toggleGroup(workspace.id)}>
              <ChevronRight size={15} className="mobile-session-group-chevron" aria-hidden="true" />
              <Folder size={14} aria-hidden="true" />
              <strong>{workspace.label}</strong>
              {attention !== undefined && sessionAttentionLabel(attention) !== undefined ? <span className={`sidebar-activity attention-${attention.attentionState ?? "idle"} ${attention.runState}`} role="status" aria-label={`${workspace.label} 有${sessionAttentionLabel(attention)}`} /> : null}
              <span className="mobile-session-group-count">{sessions.length} 个会话</span>
            </button>
            <Button variant="ghost" size="icon" className="mobile-session-group-menu" aria-label={`${workspace.label}的项目操作`} onClick={() => props.onOpenProjectMenu(workspace)}><MoreVertical size={16} /></Button>
            <Button variant="ghost" size="icon" className="mobile-session-group-new" aria-label={`在 ${workspace.label} 中新建会话`} onClick={() => props.onCreateSession(workspace.id)}><Plus size={16} /></Button>
          </div>
          {expanded ? <div className="mobile-session-group-list">
            {renderSessionRows(workspace.id, listWindow.sessions)}
            {listWindow.hasMore ? <button type="button" className="mobile-session-window-action" onClick={() => expandGroupSessions(workspace.id)} aria-label="展开更多会话"><ChevronDown size={14} />展开更多会话</button> : null}
            {listWindow.expanded ? <button type="button" className="mobile-session-window-action" onClick={() => collapseGroupSessions(workspace.id)} aria-label="收起会话"><ChevronUp size={14} />收起会话</button> : null}
          </div> : null}
        </section>;
      })}
    </div>
    <Dialog open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
      <DialogContent title="选择项目">
        <div className="mobile-project-picker">
          {props.workspaces.map((workspace) => <button type="button" key={workspace.id} onClick={() => { setProjectPickerOpen(false); props.onCreateSession(workspace.id); }}><Folder size={16} /><span>{workspace.label}</span><ChevronRight size={16} /></button>)}
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}

export function readMobileExpandedGroups(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(MOBILE_EXPANDED_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function saveMobileExpandedGroups(expandedGroupIds: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(MOBILE_EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify(expandedGroupIds));
  } catch {
    // The session list remains usable when browser storage is unavailable.
  }
}

function MobileProjectStatus({ session }: { session: SessionSummary | undefined }) {
  if (session === undefined) return null;
  const state = sessionAttentionState(session);
  const label = sessionAttentionLabel(session);
  if (label === undefined) return null;
  const Icon = state === "running" ? LoaderCircle : state === "failed" ? CircleAlert : state === "completed_unread" ? CheckCircle2 : CircleDot;
  return <span className={`mobile-project-status attention-${state}${session.runState === "stopping" ? " stopping" : ""}`} title={label} aria-hidden="true"><Icon size={11} className={state === "running" ? "spin" : undefined} /></span>;
}

interface MobileSessionRowProps {
  session: SessionSummary;
  selected: boolean;
  onSelect: () => void;
  onMenu: () => void;
}

function MobileSessionRow(props: MobileSessionRowProps) {
  const { session, selected } = props;
  return <div className={`mobile-session-row${selected ? " selected" : ""}`}>
    <button type="button" className="mobile-session-select" onClick={props.onSelect}><span className="mobile-session-copy"><strong>{session.starred === true ? <Star className="session-star" size={11} fill="currentColor" aria-hidden="true" /> : null}<span>{sessionLabel(session.name, session.preview)}</span></strong>{isSessionRunning(session) ? null : <small>{formatRelativeTime(session.updatedAt)}</small>}</span>{sessionAttentionLabel(session) === undefined ? null : <span className={`sidebar-activity attention-${session.attentionState ?? "idle"} ${session.runState}`} role="status" aria-label={sessionAttentionLabel(session)} />}</button>
    <Button variant="ghost" size="icon" className="mobile-session-menu" aria-label={`管理会话 ${sessionLabel(session.name, session.preview)}`} onClick={props.onMenu}><MoreVertical size={16} /></Button>
  </div>;
}

let longPressTimer: number | undefined;
let suppressNextClick = false;

function startLongPress(event: PointerEvent<HTMLButtonElement>, action: () => void): void {
  if (event.pointerType !== "touch") return;
  cancelLongPress();
  longPressTimer = window.setTimeout(() => {
    longPressTimer = undefined;
    suppressNextClick = true;
    action();
  }, 500);
}

function consumeLongPress(): boolean {
  if (!suppressNextClick) return false;
  suppressNextClick = false;
  return true;
}

function cancelLongPress(): void {
  if (longPressTimer === undefined) return;
  window.clearTimeout(longPressTimer);
  longPressTimer = undefined;
}
