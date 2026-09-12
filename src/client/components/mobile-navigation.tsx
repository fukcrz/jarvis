import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronUp, CircleAlert, CircleDot, Focus, Folder, GitBranch, LoaderCircle, MoreVertical, Pencil, Plus, Search, Settings2, Trash2 } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, isSessionRunning, sessionAttentionLabel, sessionAttentionRank, sessionAttentionState, sessionLabel, sessionListWindow } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface MobileSessionSwitcherProps {
  workspaces: Workspace[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  selectedSessionId?: string;
  onCreateSession: (workspaceId: string) => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onOpenSessionMenu: (workspaceId: string, session: SessionSummary) => void;
  onRenameSession: (workspaceId: string, session: SessionSummary) => void;
  onForkSession: (workspaceId: string, session: SessionSummary) => void;
  onDeleteSession: (workspaceId: string, session: SessionSummary) => void;
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

/** 左滑露出的操作区宽度（三个 44px 按钮）。 */
const SWIPE_ACTION_WIDTH = 132;
const MOBILE_EXPANDED_GROUPS_STORAGE_KEY = "jarvis.mobile.projects.expanded";

/** 分组排序权重：组内最紧急的会话决定该组的优先级。 */
function groupAttentionRank(group: MobileSessionGroup): number {
  return group.sessions.reduce((rank, session) => Math.min(rank, sessionAttentionRank(session)), 4);
}

/** 组内最近一次活动时间。 */
function groupLatestUpdatedAt(group: MobileSessionGroup): string {
  return group.sessions.reduce((latest, session) => (session.updatedAt.localeCompare(latest) > 0 ? session.updatedAt : latest), "");
}

export function shouldShowMobileSessionGroup(sessionCount: number, focusMode: boolean): boolean {
  return sessionCount > 0 || focusMode;
}

export function projectAttentionSession(sessions: SessionSummary[]): SessionSummary | undefined {
  const session = [...sessions].sort((a, b) => sessionAttentionRank(a) - sessionAttentionRank(b) || b.updatedAt.localeCompare(a.updatedAt))[0];
  return session === undefined || sessionAttentionLabel(session) === undefined ? undefined : session;
}

export function MobileSessionSwitcher(props: MobileSessionSwitcherProps) {
  const [workspaceFilter, setWorkspaceFilter] = useState(() => window.localStorage.getItem("jarvis.mobile.session-project") ?? "all");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [openSwipeKey, setOpenSwipeKey] = useState<string | null>(null);
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
  // 按项目分桶：筛选 + 组内排序（attentionRank 优先，再按最近更新）。
  const groups = useMemo<MobileSessionGroup[]>(() => {
    const result: MobileSessionGroup[] = [];
    for (const workspace of props.workspaces) {
      if (workspaceFilter !== "all" && workspace.id !== workspaceFilter) continue;
      const sessions = (props.sessionsByWorkspace[workspace.id] ?? [])
        .sort((a, b) => sessionAttentionRank(a) - sessionAttentionRank(b) || b.updatedAt.localeCompare(a.updatedAt));
      if (!shouldShowMobileSessionGroup(sessions.length, props.focusMode)) continue;
      result.push({ workspace, sessions });
    }
    // 组排序：有需要关注的会话的组优先，再按组内最近活动（活跃项目靠前）。
    result.sort((a, b) => groupAttentionRank(a) - groupAttentionRank(b) || groupLatestUpdatedAt(b).localeCompare(groupLatestUpdatedAt(a)));
    return result;
  }, [props.workspaces, props.sessionsByWorkspace, workspaceFilter]);
  const setSwipeOpen = (key: string, open: boolean) => {
    setOpenSwipeKey((current) => (open ? key : current === key ? null : current));
  };
  const toggleGroup = (workspaceId: string) => {
    setExpandedGroupIds((current) => ({ ...current, [workspaceId]: current[workspaceId] !== true }));
  };
  const expandGroupSessions = (workspaceId: string) => {
    setSessionExpandSteps((current) => ({ ...current, [workspaceId]: (current[workspaceId] ?? 0) + 1 }));
  };
  const collapseGroupSessions = (workspaceId: string) => {
    setSessionExpandSteps((current) => ({ ...current, [workspaceId]: 0 }));
  };
  const renderSessionRows = (workspaceId: string, sessions: SessionSummary[]) => sessions.map((session) => {
    const rowKey = `${workspaceId}:${session.id}`;
    return <MobileSessionRow key={rowKey} rowKey={rowKey} session={session} selected={session.id === props.selectedSessionId} open={openSwipeKey === rowKey} onOpenChange={setSwipeOpen} onSelect={() => props.onSelectSession(workspaceId, session.id)} onMenu={() => props.onOpenSessionMenu(workspaceId, session)} onRename={() => props.onRenameSession(workspaceId, session)} onFork={() => props.onForkSession(workspaceId, session)} onDelete={() => props.onDeleteSession(workspaceId, session)} />;
  });
  return <section className="mobile-page mobile-all-sessions-page" aria-label="全部会话">
    <header className="mobile-switcher-header"><strong>{props.assistantName}</strong><div className="mobile-switcher-actions"><Button variant="ghost" size="icon" aria-label="搜索会话" title="搜索会话" onClick={props.onOpenSearch}><Search size={18} /></Button><Button variant="ghost" size="icon" className={`session-focus-toggle${props.focusMode ? " active" : ""}`} aria-label={props.focusMode ? "关闭聚焦会话" : "开启聚焦会话"} aria-pressed={props.focusMode} title={props.focusMode ? "关闭聚焦会话" : "开启聚焦会话"} onClick={props.onToggleFocusMode}><Focus size={18} /></Button><Button variant="ghost" size="icon" aria-label="查看文件" title="文件" onClick={props.onOpenFiles}><Folder size={18} /></Button><Button variant="ghost" size="icon" aria-label="打开设置" title="设置" onClick={props.onOpenSettings}><Settings2 size={18} /></Button><Button variant="ghost" size="icon" aria-label="新建会话" onClick={requestCreateSession} disabled={props.workspaces.length === 0}><Plus size={20} /></Button></div></header>
    <nav className="mobile-session-projects" aria-label="按项目筛选会话"><button type="button" className={workspaceFilter === "all" ? "selected" : ""} onClick={() => setWorkspaceFilter("all")}>全部</button>{props.workspaces.map((workspace) => {
      const attentionSession = projectAttentionSession(props.sessionsByWorkspace[workspace.id] ?? []);
      return <button type="button" key={workspace.id} className={workspaceFilter === workspace.id ? "selected" : ""} aria-label={`${workspace.label}${attentionSession === undefined ? "" : `，${sessionAttentionLabel(attentionSession)}`}`} onClick={() => { if (!consumeLongPress()) setWorkspaceFilter(workspace.id); }} onContextMenu={(event) => { event.preventDefault(); props.onOpenProjectMenu(workspace); }} onPointerDown={(event) => startLongPress(event, () => props.onOpenProjectMenu(workspace))} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress}><span className="mobile-project-label">{workspace.label}</span><MobileProjectStatus session={attentionSession} /></button>;
    })}<button type="button" className="mobile-add-project" aria-label="添加项目" onClick={props.onAddProject}><Plus size={15} /></button></nav>
    <div className="mobile-page-list mobile-switcher-list" onPointerDown={(event) => {
      // 点击列表其他位置时收起已滑开的行（行内的手势处理自身）。
      if (openSwipeKey === null) return;
      const swipeTarget = (event.target as Element).closest("[data-swipe-id]");
      if (swipeTarget?.getAttribute("data-swipe-id") !== openSwipeKey) setOpenSwipeKey(null);
    }}>
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
      <DialogContent title="选择项目" description="新会话将创建在所选项目中。">
        <div className="mobile-project-picker">
          {props.workspaces.map((workspace) => <button type="button" key={workspace.id} onClick={() => { setProjectPickerOpen(false); props.onCreateSession(workspace.id); }}><Folder size={17} /><span>{workspace.label}</span><ChevronRight size={16} /></button>)}
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
  return <span className={`mobile-project-status attention-${state}${session.runState === "stopping" ? " stopping" : ""}`} title={label} aria-hidden="true"><Icon size={13} className={state === "running" ? "spin" : undefined} /></span>;
}

interface MobileSessionRowProps {
  rowKey: string;
  session: SessionSummary;
  selected: boolean;
  open: boolean;
  onOpenChange: (rowKey: string, open: boolean) => void;
  onSelect: () => void;
  onMenu: () => void;
  onRename: () => void;
  onFork: () => void;
  onDelete: () => void;
}

interface SwipeDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startTranslate: number;
  lastTranslate: number;
  locked: "horizontal" | "vertical" | null;
  moved: boolean;
}

function MobileSessionRow(props: MobileSessionRowProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<SwipeDrag | undefined>(undefined);
  /** 左滑手势结束后抑制随即到来的 click（滑动并非点击）。 */
  const suppressClickRef = useRef(false);
  const { rowKey, session, selected, open, onOpenChange } = props;

  function setTranslate(px: number) {
    const el = contentRef.current;
    if (el !== null) el.style.transform = `translateX(${px}px)`;
  }

  function endDrag(commit: boolean) {
    const drag = dragRef.current;
    dragRef.current = undefined;
    if (drag === undefined) return;
    const el = contentRef.current;
    if (el === null) return;
    el.style.transition = "";
    if (drag.locked !== "horizontal" || !commit) return;
    // 吸附到距离当前最近的一端：lastTranslate 越接近 0 越倾向关闭，越接近 -WIDTH 越倾向打开。
    const target = drag.moved && drag.lastTranslate < -SWIPE_ACTION_WIDTH / 2 ? -SWIPE_ACTION_WIDTH : 0;
    setTranslate(target);
    // 过渡结束后清除 inline transform，交给 class（swipe-open）控制，避免残留覆盖后续状态。
    window.setTimeout(() => {
      if (el.style.transform !== "") el.style.transform = "";
    }, 220);
    if (drag.moved) {
      suppressClickRef.current = true;
      onOpenChange(rowKey, target === -SWIPE_ACTION_WIDTH);
    }
  }

  function handleSelectClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (props.open) {
      onOpenChange(rowKey, false);
      return;
    }
    props.onSelect();
  }

  return <div className="mobile-session-swipe" data-swipe-id={rowKey}>
    <div className="mobile-session-actions">
      <button type="button" className="mobile-session-action-rename" onClick={() => { onOpenChange(rowKey, false); props.onRename(); }}><Pencil size={15} />重命名</button>
      <button type="button" className="mobile-session-action-fork" onClick={() => { onOpenChange(rowKey, false); props.onFork(); }}><GitBranch size={15} />分支</button>
      <button type="button" className="mobile-session-action-delete" disabled={session.runState !== "idle"} onClick={() => { onOpenChange(rowKey, false); props.onDelete(); }}><Trash2 size={15} />删除</button>
    </div>
    <div ref={contentRef} className={`mobile-session-row${open ? " swipe-open" : ""}${selected ? " selected" : ""}`} onPointerDown={(event) => {
      suppressClickRef.current = false;
      if (event.pointerType !== "touch") return;
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startTranslate: open ? -SWIPE_ACTION_WIDTH : 0, lastTranslate: open ? -SWIPE_ACTION_WIDTH : 0, locked: null, moved: false };
    }} onPointerMove={(event) => {
      const drag = dragRef.current;
      if (drag === undefined || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.locked === null) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
          drag.locked = "vertical";
          return;
        }
        if (Math.abs(dx) > 8) drag.locked = "horizontal";
        else return;
      }
      if (drag.locked !== "horizontal") return;
      const el = contentRef.current;
      if (el !== null) el.style.transition = "none";
      drag.lastTranslate = Math.min(0, Math.max(-SWIPE_ACTION_WIDTH, drag.startTranslate + dx));
      if (Math.abs(drag.lastTranslate - drag.startTranslate) > 10) drag.moved = true;
      setTranslate(drag.lastTranslate);
    }} onPointerUp={(event) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      endDrag(true);
    }} onPointerCancel={(event) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      endDrag(false);
    }}>
      <button type="button" className="mobile-session-select" onClick={handleSelectClick}><span className="mobile-session-copy"><strong>{sessionLabel(session.name, session.preview)}</strong>{isSessionRunning(session) ? null : <small>{formatRelativeTime(session.updatedAt)}</small>}</span>{sessionAttentionLabel(session) === undefined ? null : <span className={`sidebar-activity attention-${session.attentionState ?? "idle"} ${session.runState}`} role="status" aria-label={sessionAttentionLabel(session)} />}</button>
      <Button variant="ghost" size="icon" className="mobile-session-menu" aria-label={`管理会话 ${sessionLabel(session.name, session.preview)}`} onClick={() => {
        if (suppressClickRef.current) { suppressClickRef.current = false; return; }
        if (props.open) { onOpenChange(rowKey, false); return; }
        props.onMenu();
      }}><MoreVertical size={18} /></Button>
    </div>
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
