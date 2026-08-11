import { useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Folder, MoreVertical, Plus } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, sessionLabel } from "../lib/utils";
import { Button } from "./ui/button";

interface MobileProjectsPageProps {
  workspaces: Workspace[];
  activeRunStateByWorkspace: Record<string, "running" | "stopping">;
  onAddProject: () => void;
  onOpenProject: (workspace: Workspace) => void;
  onOpenProjectMenu: (workspace: Workspace) => void;
}

export function MobileProjectsPage(props: MobileProjectsPageProps) {
  return <section className="mobile-page" aria-label="项目列表">
    <header className="mobile-page-header"><h1>项目</h1><Button variant="ghost" size="icon" aria-label="添加项目" onClick={props.onAddProject}><Plus size={19} /></Button></header>
    <div className="mobile-page-list">
      {props.workspaces.map((workspace) => {
        const runState = props.activeRunStateByWorkspace[workspace.id];
        return <div className="mobile-project-row" key={workspace.id}>
          <button type="button" className="mobile-project-select" onClick={() => props.onOpenProject(workspace)}><Folder size={18} /><span>{workspace.label}</span>{runState === undefined ? null : <span className={`sidebar-activity ${runState}`} role="status" aria-label={`${workspace.label} 有正在执行的会话`} />}<ChevronRight size={17} className="mobile-row-chevron" /></button>
          <Button variant="ghost" size="icon" aria-label={`管理项目 ${workspace.label}`} onClick={() => props.onOpenProjectMenu(workspace)}><MoreVertical size={18} /></Button>
        </div>;
      })}
      {props.workspaces.length === 0 ? <div className="mobile-page-empty">暂无项目</div> : null}
    </div>
  </section>;
}

interface MobileSessionsPageProps {
  workspace: Workspace | undefined;
  sessions: SessionSummary[];
  onBack: () => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onOpenProjectMenu: (workspace: Workspace) => void;
  onOpenSessionMenu: (session: SessionSummary) => void;
}

export function MobileSessionsPage(props: MobileSessionsPageProps) {
  const workspace = props.workspace;
  return <section className="mobile-page" aria-label="会话列表">
    <header className="mobile-page-header mobile-sessions-header"><Button variant="ghost" size="icon" aria-label="返回项目列表" onClick={props.onBack}><ArrowLeft size={19} /></Button><button type="button" className="mobile-page-title" onClick={() => { if (workspace !== undefined) props.onOpenProjectMenu(workspace); }} disabled={workspace === undefined}>{workspace?.label ?? "会话"}</button><Button variant="ghost" size="icon" aria-label="新建会话" onClick={props.onCreateSession} disabled={workspace === undefined}><Plus size={19} /></Button></header>
    <div className="mobile-page-list mobile-session-list">
      {props.sessions.map((session) => <div className="mobile-session-row" key={session.id}><button type="button" className="mobile-session-select" onClick={() => props.onSelectSession(session.id)}><span className="mobile-session-copy"><strong>{sessionLabel(session.name, session.preview)}</strong><small>{formatRelativeTime(session.updatedAt)}</small></span>{session.runState === "idle" ? null : <span className={`sidebar-activity ${session.runState}`} role="status" aria-label={session.runState === "stopping" ? "正在停止" : "正在执行"} />}</button><Button variant="ghost" size="icon" aria-label={`管理会话 ${sessionLabel(session.name, session.preview)}`} onClick={() => props.onOpenSessionMenu(session)}><MoreVertical size={18} /></Button></div>)}
      {props.sessions.length === 0 ? <div className="mobile-page-empty">暂无会话</div> : null}
    </div>
  </section>;
}

interface MobileSessionSwitcherProps {
  workspaces: Workspace[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  selectedWorkspaceId?: string;
  selectedSessionId?: string;
  onClose: () => void;
  onCreateSession: () => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onOpenSessionMenu: (workspaceId: string, session: SessionSummary) => void;
}

interface MobileSessionEntry { workspace: Workspace; session: SessionSummary; }

export function MobileSessionSwitcher(props: MobileSessionSwitcherProps) {
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const entries = useMemo<MobileSessionEntry[]>(() => props.workspaces.flatMap((workspace) => (props.sessionsByWorkspace[workspace.id] ?? []).map((session) => ({ workspace, session }))).sort((a, b) => {
    const rank = (state: SessionSummary["runState"]) => state === "running" ? 0 : state === "stopping" ? 1 : 2;
    return rank(a.session.runState) - rank(b.session.runState) || b.session.updatedAt.localeCompare(a.session.updatedAt);
  }), [props.sessionsByWorkspace, props.workspaces]);
  const visibleEntries = workspaceFilter === "all" ? entries : entries.filter((entry) => entry.workspace.id === workspaceFilter);
  return <div className="mobile-switcher" role="dialog" aria-label="全部会话">
    <header className="mobile-switcher-header"><Button variant="ghost" size="icon" aria-label="返回当前会话" onClick={props.onClose}><ArrowLeft size={19} /></Button><strong>全部会话</strong><Button variant="ghost" size="icon" aria-label="新建会话" onClick={props.onCreateSession} disabled={props.selectedWorkspaceId === undefined}><Plus size={20} /></Button></header>
    <nav className="mobile-session-projects" aria-label="按项目筛选会话"><button type="button" className={workspaceFilter === "all" ? "selected" : ""} onClick={() => setWorkspaceFilter("all")}>全部</button>{props.workspaces.map((workspace) => <button type="button" key={workspace.id} className={workspaceFilter === workspace.id ? "selected" : ""} onClick={() => setWorkspaceFilter(workspace.id)}>{workspace.label}</button>)}</nav>
    <div className="mobile-page-list mobile-switcher-list">
      {visibleEntries.map(({ workspace, session }) => <div className={`mobile-session-row ${session.id === props.selectedSessionId ? "selected" : ""}`} key={`${workspace.id}:${session.id}`}><button type="button" className="mobile-session-select" onClick={() => props.onSelectSession(workspace.id, session.id)}><span className="mobile-session-copy"><strong>{sessionLabel(session.name, session.preview)}</strong><small>{formatRelativeTime(session.updatedAt)}</small></span>{session.runState === "idle" ? null : <span className={`sidebar-activity ${session.runState}`} role="status" aria-label={session.runState === "stopping" ? "正在停止" : "正在执行"} />}</button><Button variant="ghost" size="icon" aria-label={`管理会话 ${sessionLabel(session.name, session.preview)}`} onClick={() => props.onOpenSessionMenu(workspace.id, session)}><MoreVertical size={18} /></Button></div>)}
      {visibleEntries.length === 0 ? <div className="mobile-page-empty">暂无会话</div> : null}
    </div>
  </div>;
}
