import { ChevronDown, ChevronUp, Files, Focus, Folder, FolderPlus, MessageSquarePlus, Search, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, isSessionRunning, sessionAttentionLabel, sessionAttentionRank, sessionLabel, sessionListWindow, workspaceDropTarget } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

interface SidebarProps {
  workspaces: Workspace[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  workspaceId?: string;
  selectedSessionId?: string;
  expandedWorkspaceIds: Record<string, boolean>;
  onToggleWorkspace: (id: string) => void;
  onOpenWorkspaceDialog: () => void;
  onCreateSession: (workspaceId: string) => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onOpenProjectMenu: (workspace: Workspace, position: { x: number; y: number }) => void;
  onOpenSessionMenu: (workspaceId: string, session: SessionSummary, position: { x: number; y: number }) => void;
  onLongPressProject: (workspace: Workspace) => void;
  onLongPressSession: (workspaceId: string, session: SessionSummary) => void;
  onOpenSearch: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  assistantName: string;
  onOpenSettings: () => void;
  onOpenFiles: () => void;
  onReorderWorkspaces: (sourceId: string, targetId: string, placeAfter: boolean) => void;
  workspaceOrderPending: boolean;
}

const WORKSPACE_DRAG_THRESHOLD_PX = 6;

interface WorkspacePointerDrag {
  pointerId: number;
  sourceId: string;
  startX: number;
  startY: number;
  moved: boolean;
}

export function Sidebar(props: SidebarProps) {
  /** 每个项目展开会话的步数（0 = 默认收起状态，每展开一次 +1）。 */
  const [sessionExpands, setSessionExpands] = useState<Record<string, number>>({});
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | undefined>();
  const [dropTarget, setDropTarget] = useState<{ id: string; placeAfter: boolean } | undefined>();
  const treeRef = useRef<HTMLElement>(null);
  const pointerDragRef = useRef<WorkspacePointerDrag | undefined>(undefined);
  const dropTargetRef = useRef<{ id: string; placeAfter: boolean } | undefined>(undefined);
  const orderPendingRef = useRef(props.workspaceOrderPending);
  const reorderRef = useRef(props.onReorderWorkspaces);
  orderPendingRef.current = props.workspaceOrderPending;
  reorderRef.current = props.onReorderWorkspaces;

  function expandSessions(workspaceId: string): void {
    setSessionExpands((prev) => ({ ...prev, [workspaceId]: (prev[workspaceId] ?? 0) + 1 }));
  }

  function collapseSessions(workspaceId: string): void {
    setSessionExpands((prev) => ({ ...prev, [workspaceId]: 0 }));
  }

  function readDropNodes(): Array<{ id: string; top: number; height: number }> {
    const tree = treeRef.current;
    if (tree === null) return [];
    return [...tree.querySelectorAll<HTMLElement>(".project-node[data-workspace-id]")].flatMap((node) => {
      const id = node.dataset.workspaceId;
      const row = node.querySelector<HTMLElement>(".project-row");
      if (id === undefined || row === null) return [];
      const bounds = row.getBoundingClientRect();
      return [{ id, top: bounds.top, height: bounds.height }];
    });
  }

  function setDropHint(next: { id: string; placeAfter: boolean } | undefined): void {
    dropTargetRef.current = next;
    setDropTarget((current) => current?.id === next?.id && current?.placeAfter === next?.placeAfter ? current : next);
  }

  function finishWorkspaceDrag(commit: boolean): void {
    const drag = pointerDragRef.current;
    pointerDragRef.current = undefined;
    const target = dropTargetRef.current;
    setDraggingWorkspaceId(undefined);
    setDropHint(undefined);
    document.body.classList.remove("project-reordering");
    if (drag?.moved === true) window.setTimeout(() => { suppressNextClick = false; }, 0);
    if (!commit || drag === undefined || !drag.moved || target === undefined) return;
    reorderRef.current(drag.sourceId, target.id, target.placeAfter);
  }

  function startWorkspacePointerDrag(event: PointerEvent<HTMLElement>, workspaceId: string): void {
    if (event.pointerType !== "mouse" || event.button !== 0 || orderPendingRef.current) return;
    if ((event.target as HTMLElement | null)?.closest(".project-new-session") !== null) return;
    pointerDragRef.current = { pointerId: event.pointerId, sourceId: workspaceId, startX: event.clientX, startY: event.clientY, moved: false };
  }

  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag === undefined || event.pointerId !== drag.pointerId) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < WORKSPACE_DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        suppressNextClick = true;
        setDraggingWorkspaceId(drag.sourceId);
        document.body.classList.add("project-reordering");
      }
      event.preventDefault();
      setDropHint(workspaceDropTarget(drag.sourceId, event.clientY, readDropNodes()));
    };
    const onUp = (event: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag === undefined || event.pointerId !== drag.pointerId) return;
      finishWorkspaceDrag(true);
    };
    const onCancel = (event: globalThis.PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag === undefined || event.pointerId !== drag.pointerId) return;
      finishWorkspaceDrag(false);
    };
    const onBlur = () => finishWorkspaceDrag(false);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
      document.body.classList.remove("project-reordering");
    };
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <span>项目</span>
        <div className="sidebar-toolbar-actions"><Tooltip label="搜索会话"><Button variant="ghost" size="icon" aria-label="搜索会话" onClick={props.onOpenSearch}><Search size={15} /></Button></Tooltip><Tooltip label={props.focusMode ? "关闭聚焦会话" : "开启聚焦会话"}><Button variant="ghost" size="icon" className={`session-focus-toggle${props.focusMode ? " active" : ""}`} aria-label={props.focusMode ? "关闭聚焦会话" : "开启聚焦会话"} aria-pressed={props.focusMode} onClick={props.onToggleFocusMode}><Focus size={15} /></Button></Tooltip><Tooltip label="查看文件"><Button variant="ghost" size="icon" aria-label="查看文件" onClick={props.onOpenFiles}><Files size={16} /></Button></Tooltip><Tooltip label="添加项目"><Button variant="ghost" size="icon" aria-label="添加项目" onClick={props.onOpenWorkspaceDialog}><FolderPlus size={16} /></Button></Tooltip></div>
      </div>
      <nav ref={treeRef} className="project-tree" aria-label="项目列表">
        {props.workspaces.map((workspace) => {
          const sessions = props.sessionsByWorkspace[workspace.id] ?? [];
          // 默认窗口展示（执行中的会话始终显示，默认最多 5 个，可展开更多）。
          const window = sessionListWindow(sessions, sessionExpands[workspace.id] ?? 0);
          const expanded = props.expandedWorkspaceIds[workspace.id] === true;
          const activeSession = [...sessions].sort((a, b) => sessionAttentionRank(a) - sessionAttentionRank(b))[0];
          const toggleLabel = `${expanded ? "收起" : "展开"}${workspace.label}的会话`;

          return (
            <section className={`project-node${draggingWorkspaceId === workspace.id ? " dragging" : ""}${dropTarget?.id === workspace.id && dropTarget.placeAfter ? " drop-after" : ""}${dropTarget?.id === workspace.id && !dropTarget.placeAfter ? " drop-before" : ""}`} data-workspace-id={workspace.id} key={workspace.id}>
              <div className="project-row" onPointerDown={(event) => startWorkspacePointerDrag(event, workspace.id)}>
                <button className="project-toggle" type="button" aria-label={toggleLabel} aria-expanded={expanded} onClick={() => { if (!consumeLongPress()) props.onToggleWorkspace(workspace.id); }} onContextMenu={(event) => {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  props.onOpenProjectMenu(workspace, { x: event.clientX === 0 ? bounds.right : event.clientX, y: event.clientY === 0 ? bounds.bottom : event.clientY });
                }} onPointerDown={(event) => startLongPress(event, () => props.onLongPressProject(workspace))} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress}>
                  <Folder size={15} />
                  <span>{workspace.label}</span>
                </button>
                <Tooltip label={`在 ${workspace.label} 中新建会话`}><Button variant="ghost" size="icon" className="project-new-session" aria-label={`在 ${workspace.label} 中新建会话`} onClick={(event) => { event.stopPropagation(); props.onCreateSession(workspace.id); }}><MessageSquarePlus size={15} /></Button></Tooltip>
                {expanded || activeSession === undefined || sessionAttentionLabel(activeSession) === undefined ? null : <span className={`sidebar-activity attention-${activeSession.attentionState ?? "idle"} ${activeSession.runState}`} role="status" aria-label={`${workspace.label} 有${sessionAttentionLabel(activeSession)}`} />}
              </div>
              {expanded ? <div className="project-sessions" role="group">
                {window.sessions.map((session) => <button key={session.id} type="button" data-session-id={session.id} className={`session-row ${workspace.id === props.workspaceId && session.id === props.selectedSessionId ? "selected" : ""}`} aria-current={workspace.id === props.workspaceId && session.id === props.selectedSessionId ? "page" : undefined} onClick={() => { if (!consumeLongPress()) props.onSelectSession(workspace.id, session.id); }} onPointerDown={(event) => startLongPress(event, () => props.onLongPressSession(workspace.id, session))} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress} onContextMenu={(event) => {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  props.onOpenSessionMenu(workspace.id, session, {
                    x: event.clientX === 0 ? bounds.right : event.clientX,
                    y: event.clientY === 0 ? bounds.bottom : event.clientY,
                  });
                }}>
                  <span className="session-text"><strong>{sessionLabel(session.name, session.preview)}</strong>{isSessionRunning(session) ? null : <small>{formatRelativeTime(session.updatedAt)}</small>}</span>
                  {sessionAttentionLabel(session) === undefined ? null : <span className={`sidebar-activity attention-${session.attentionState ?? "idle"} ${session.runState}`} role="status" aria-label={`${sessionAttentionLabel(session)}的会话`} />}
                </button>)}
                {window.hasMore ? <button type="button" className="session-expand-more" onClick={() => expandSessions(workspace.id)} aria-label="展开更多会话"><ChevronDown size={13} />展开更多会话</button> : null}
                {window.expanded ? <button type="button" className="session-collapse" onClick={() => collapseSessions(workspace.id)} aria-label="收起会话"><ChevronUp size={13} />收起会话</button> : null}
                {sessions.length === 0 ? <div className="project-empty">{props.focusMode ? "暂无聚焦会话" : "暂无会话"}</div> : null}
              </div> : null}
            </section>
          );
        })}
        {props.workspaces.length === 0 ? <div className="session-list-empty"><Settings2 size={17} /><span>暂无项目</span></div> : null}
      </nav>
      <button type="button" className="sidebar-settings" onClick={props.onOpenSettings}><Settings2 size={15} /><span>{props.assistantName} 设置</span></button>
    </aside>
  );
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
