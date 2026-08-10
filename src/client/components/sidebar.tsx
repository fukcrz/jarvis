import { Folder, FolderPlus, MessageSquarePlus, Settings2 } from "lucide-react";
import type { PointerEvent } from "react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, sessionLabel } from "../lib/utils";
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
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <span>项目</span>
        <Tooltip label="添加项目"><Button variant="ghost" size="icon" aria-label="添加项目" onClick={props.onOpenWorkspaceDialog}><FolderPlus size={16} /></Button></Tooltip>
      </div>
      <nav className="project-tree" aria-label="项目列表">
        {props.workspaces.map((workspace) => {
          const sessions = props.sessionsByWorkspace[workspace.id] ?? [];
          const expanded = props.expandedWorkspaceIds[workspace.id] === true;
          const active = workspace.id === props.workspaceId;
          const activeSession = sessions.find((session) => session.runState === "running" || session.runState === "stopping");
          const toggleLabel = `${expanded ? "收起" : "展开"}${workspace.label}的会话`;

          return (
            <section className={`project-node ${active ? "active" : ""}`} key={workspace.id}>
              <div className="project-row">
                <button className="project-toggle" type="button" aria-label={toggleLabel} aria-expanded={expanded} onClick={() => { if (!consumeLongPress()) props.onToggleWorkspace(workspace.id); }} onContextMenu={(event) => {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  props.onOpenProjectMenu(workspace, { x: event.clientX === 0 ? bounds.right : event.clientX, y: event.clientY === 0 ? bounds.bottom : event.clientY });
                }} onPointerDown={(event) => startLongPress(event, () => props.onLongPressProject(workspace))} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress}>
                  <Folder size={15} />
                  <span>{workspace.label}</span>
                </button>
                <Tooltip label={`在 ${workspace.label} 中新建会话`}><Button variant="ghost" size="icon" className="project-new-session" aria-label={`在 ${workspace.label} 中新建会话`} onClick={(event) => { event.stopPropagation(); props.onCreateSession(workspace.id); }}><MessageSquarePlus size={15} /></Button></Tooltip>
                {expanded || activeSession === undefined ? null : <span className={`sidebar-activity ${activeSession.runState}`} role="status" aria-label={`${workspace.label} 有正在执行的会话`} />}
              </div>
              {expanded ? <div className="project-sessions" role="group">
                {sessions.map((session) => <button key={session.id} type="button" data-session-id={session.id} className={`session-row ${workspace.id === props.workspaceId && session.id === props.selectedSessionId ? "selected" : ""}`} aria-current={workspace.id === props.workspaceId && session.id === props.selectedSessionId ? "page" : undefined} onClick={() => { if (!consumeLongPress()) props.onSelectSession(workspace.id, session.id); }} onPointerDown={(event) => startLongPress(event, () => props.onLongPressSession(workspace.id, session))} onPointerUp={cancelLongPress} onPointerCancel={cancelLongPress} onPointerLeave={cancelLongPress} onContextMenu={(event) => {
                  event.preventDefault();
                  const bounds = event.currentTarget.getBoundingClientRect();
                  props.onOpenSessionMenu(workspace.id, session, {
                    x: event.clientX === 0 ? bounds.right : event.clientX,
                    y: event.clientY === 0 ? bounds.bottom : event.clientY,
                  });
                }}>
                  <span className="session-text"><strong>{sessionLabel(session.name, session.preview)}</strong><small>{formatRelativeTime(session.updatedAt)}</small></span>
                  {session.runState === "idle" ? null : <span className={`sidebar-activity ${session.runState}`} role="status" aria-label={`${session.runState === "stopping" ? "正在停止" : "正在执行"}的会话`} />}
                </button>)}
                {sessions.length === 0 ? <div className="project-empty">暂无会话</div> : null}
              </div> : null}
            </section>
          );
        })}
        {props.workspaces.length === 0 ? <div className="session-list-empty"><Settings2 size={17} /><span>暂无项目</span></div> : null}
      </nav>
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
