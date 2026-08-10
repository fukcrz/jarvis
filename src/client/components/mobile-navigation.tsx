import { useState } from "react";
import { ArrowLeft, ChevronRight, Folder, MoreVertical, Plus, Search } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, matchesSessionQuery, sessionLabel } from "../lib/utils";
import { Button } from "./ui/button";

interface MobileProjectsPageProps {
  workspaces: Workspace[];
  /** First active run state per workspace, so project rows can show the spinner. */
  activeRunStateByWorkspace: Record<string, "running" | "stopping">;
  onAddProject: () => void;
  onOpenProject: (workspace: Workspace) => void;
  onOpenProjectMenu: (workspace: Workspace) => void;
}

export function MobileProjectsPage(props: MobileProjectsPageProps) {
  return <section className="mobile-page" aria-label="项目列表">
    <header className="mobile-page-header">
      <h1>项目</h1>
      <Button variant="ghost" size="icon" aria-label="添加项目" onClick={props.onAddProject}><Plus size={19} /></Button>
    </header>
    <div className="mobile-page-list">
      {props.workspaces.map((workspace) => {
        const runState = props.activeRunStateByWorkspace[workspace.id];
        return <div className="mobile-project-row" key={workspace.id}>
          <button type="button" className="mobile-project-select" onClick={() => props.onOpenProject(workspace)}>
            <Folder size={18} />
            <span>{workspace.label}</span>
            {runState === undefined ? null : <span className={`sidebar-activity ${runState}`} role="status" aria-label={`${workspace.label} 有正在执行的会话`} />}
            <ChevronRight size={17} className="mobile-row-chevron" />
          </button>
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
  const [query, setQuery] = useState("");
  const workspace = props.workspace;
  const visibleSessions = props.sessions.filter((session) => matchesSessionQuery(session, query));
  return <section className="mobile-page" aria-label="会话列表">
    <header className="mobile-page-header mobile-sessions-header">
      <Button variant="ghost" size="icon" aria-label="返回项目列表" onClick={props.onBack}><ArrowLeft size={19} /></Button>
      <button type="button" className="mobile-page-title" onClick={() => { if (workspace !== undefined) props.onOpenProjectMenu(workspace); }} disabled={workspace === undefined}>{workspace?.label ?? "会话"}</button>
      <Button variant="ghost" size="icon" aria-label="新建会话" onClick={props.onCreateSession} disabled={workspace === undefined}><Plus size={19} /></Button>
    </header>
    <div className="mobile-search-wrap">
      <Search size={16} />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" />
      {query === "" ? null : <button type="button" aria-label="清除会话搜索" onClick={() => setQuery("")}>×</button>}
    </div>
    <div className="mobile-page-list mobile-session-list">
      {visibleSessions.map((session) => <div className="mobile-session-row" key={session.id}>
        <button type="button" className="mobile-session-select" onClick={() => props.onSelectSession(session.id)}>
          <span className="mobile-session-copy"><strong>{sessionLabel(session.name, session.preview)}</strong><small>{formatRelativeTime(session.updatedAt)}</small></span>
          {session.runState === "idle" ? null : <span className={`sidebar-activity ${session.runState}`} role="status" aria-label={session.runState === "stopping" ? "正在停止" : "正在执行"} />}
        </button>
        <Button variant="ghost" size="icon" aria-label={`管理会话 ${sessionLabel(session.name, session.preview)}`} onClick={() => props.onOpenSessionMenu(session)}><MoreVertical size={18} /></Button>
      </div>)}
      {visibleSessions.length === 0 ? <div className="mobile-page-empty">{query.trim() === "" ? "暂无会话" : "没有匹配的会话"}</div> : null}
    </div>
  </section>;
}

interface MobileSessionSwitcherProps {
  workspace: Workspace | undefined;
  sessions: SessionSummary[];
  selectedSessionId?: string;
  onClose: () => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
}

export function MobileSessionSwitcher(props: MobileSessionSwitcherProps) {
  const [query, setQuery] = useState("");
  const visibleSessions = props.sessions.filter((session) => matchesSessionQuery(session, query));
  return <div className="mobile-switcher" role="dialog" aria-label="快速切换会话">
    <div className="mobile-switcher-header">
      <strong>{props.workspace?.label ?? "会话"}</strong>
      <Button variant="ghost" size="icon" aria-label="关闭快速切换" onClick={props.onClose}><ArrowLeft size={18} /></Button>
    </div>
    <div className="mobile-search-wrap">
      <Search size={16} />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" aria-label="搜索会话" autoFocus />
      {query === "" ? null : <button type="button" aria-label="清除会话搜索" onClick={() => setQuery("")}>×</button>}
    </div>
    <div className="mobile-page-list mobile-switcher-list">
      {visibleSessions.map((session) => <button type="button" className={`mobile-switcher-item ${session.id === props.selectedSessionId ? "selected" : ""}`} key={session.id} onClick={() => props.onSelectSession(session.id)}>
        <span className="mobile-session-copy"><strong>{sessionLabel(session.name, session.preview)}</strong><small>{formatRelativeTime(session.updatedAt)}</small></span>
        {session.id === props.selectedSessionId ? <span aria-hidden="true">✓</span> : null}
      </button>)}
      {visibleSessions.length === 0 ? <div className="mobile-page-empty">{query.trim() === "" ? "暂无会话" : "没有匹配的会话"}</div> : null}
    </div>
    <button type="button" className="mobile-switcher-new" onClick={props.onCreateSession}><Plus size={17} />新建会话</button>
  </div>;
}
