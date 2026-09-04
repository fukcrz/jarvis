import { ChevronDown, ChevronUp, Files, Folder, FolderPlus, MessageSquarePlus, Search, Settings2 } from "lucide-react";
import { useState, type PointerEvent } from "react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, isSessionRunning, sessionAttentionLabel, sessionAttentionRank, sessionLabel, sessionListWindow } from "../lib/utils";
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
  assistantName: string;
  onOpenSettings: () => void;
  onOpenFiles: () => void;
}

export function Sidebar(props: SidebarProps) {
  /** 每个项目展开会话的步数（0 = 默认收起状态，每展开一次 +1）。 */
  const [sessionExpands, setSessionExpands] = useState<Record<string, number>>({});

  function expandSessions(workspaceId: string): void {
    setSessionExpands((prev) => ({ ...prev, [workspaceId]: (prev[workspaceId] ?? 0) + 1 }));
  }

  function collapseSessions(workspaceId: string): void {
    setSessionExpands((prev) => ({ ...prev, [workspaceId]: 0 }));
  }
  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <span>项目</span>
        <div className="sidebar-toolbar-actions"><Tooltip label="搜索会话"><Button variant="ghost" size="icon" aria-label="搜索会话" onClick={props.onOpenSearch}><Search size={15} /></Button></Tooltip><Tooltip label="查看文件"><Button variant="ghost" size="icon" aria-label="查看文件" onClick={props.onOpenFiles}><Files size={16} /></Button></Tooltip><Tooltip label="添加项目"><Button variant="ghost" size="icon" aria-label="添加项目" onClick={props.onOpenWorkspaceDialog}><FolderPlus size={16} /></Button></Tooltip></div>
      </div>
      <nav className="project-tree" aria-label="项目列表">
        {props.workspaces.map((workspace) => {
          const sessions = props.sessionsByWorkspace[workspace.id] ?? [];
          // 默认窗口展示（执行中的会话始终显示，默认最多 5 个，可展开更多）。
          const window = sessionListWindow(sessions, sessionExpands[workspace.id] ?? 0);
          const expanded = props.expandedWorkspaceIds[workspace.id] === true;
          const activeSession = [...sessions].sort((a, b) => sessionAttentionRank(a) - sessionAttentionRank(b))[0];
          const toggleLabel = `${expanded ? "收起" : "展开"}${workspace.label}的会话`;

          return (
            <section className="project-node" key={workspace.id}>
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
                {sessions.length === 0 ? <div className="project-empty">暂无会话</div> : null}
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
