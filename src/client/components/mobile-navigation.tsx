import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, MoreVertical, Plus, Settings2 } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, sessionAttentionLabel, sessionAttentionRank, sessionLabel } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface MobileSessionSwitcherProps {
  workspaces: Workspace[];
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  selectedSessionId?: string;
  onCreateSession: (workspaceId: string) => void;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
  onOpenSessionMenu: (workspaceId: string, session: SessionSummary) => void;
  onAddProject: () => void;
  assistantName: string;
  onOpenSettings: () => void;
}

interface MobileSessionEntry { workspace: Workspace; session: SessionSummary; }

export function MobileSessionSwitcher(props: MobileSessionSwitcherProps) {
  const [workspaceFilter, setWorkspaceFilter] = useState(() => window.localStorage.getItem("jarvis.mobile.session-project") ?? "all");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  useEffect(() => {
    if (workspaceFilter !== "all" && !props.workspaces.some((workspace) => workspace.id === workspaceFilter)) {
      setWorkspaceFilter("all");
      return;
    }
    window.localStorage.setItem("jarvis.mobile.session-project", workspaceFilter);
  }, [props.workspaces, workspaceFilter]);
  const requestCreateSession = () => {
    if (workspaceFilter === "all") {
      setProjectPickerOpen(true);
      return;
    }
    props.onCreateSession(workspaceFilter);
  };
  const entries = useMemo<MobileSessionEntry[]>(() => props.workspaces.flatMap((workspace) => (props.sessionsByWorkspace[workspace.id] ?? []).map((session) => ({ workspace, session }))).sort((a, b) => {
    return sessionAttentionRank(a.session) - sessionAttentionRank(b.session) || b.session.updatedAt.localeCompare(a.session.updatedAt);
  }), [props.sessionsByWorkspace, props.workspaces]);
  const visibleEntries = workspaceFilter === "all" ? entries : entries.filter((entry) => entry.workspace.id === workspaceFilter);
  return <section className="mobile-page mobile-all-sessions-page" aria-label="全部会话">
    <header className="mobile-switcher-header"><strong>{props.assistantName}</strong><div className="mobile-switcher-actions"><Button variant="ghost" size="icon" aria-label="打开设置" title="设置" onClick={props.onOpenSettings}><Settings2 size={18} /></Button><Button variant="ghost" size="icon" aria-label="新建会话" onClick={requestCreateSession} disabled={props.workspaces.length === 0}><Plus size={20} /></Button></div></header>
    <nav className="mobile-session-projects" aria-label="按项目筛选会话"><button type="button" className={workspaceFilter === "all" ? "selected" : ""} onClick={() => setWorkspaceFilter("all")}>全部</button>{props.workspaces.map((workspace) => <button type="button" key={workspace.id} className={workspaceFilter === workspace.id ? "selected" : ""} onClick={() => setWorkspaceFilter(workspace.id)}>{workspace.label}</button>)}<button type="button" className="mobile-add-project" aria-label="添加项目" onClick={props.onAddProject}><Plus size={15} /></button></nav>
    <div className="mobile-page-list mobile-switcher-list">
      {visibleEntries.map(({ workspace, session }) => <div data-session-id={session.id} className={`mobile-session-row ${session.id === props.selectedSessionId ? "selected" : ""}`} key={`${workspace.id}:${session.id}`}><button type="button" className="mobile-session-select" onClick={() => props.onSelectSession(workspace.id, session.id)}><span className="mobile-session-copy"><strong>{sessionLabel(session.name, session.preview)}</strong>{sessionAttentionLabel(session) === undefined ? <small>{formatRelativeTime(session.updatedAt)}</small> : <small className={`mobile-session-status attention-${session.attentionState ?? "idle"}`}>{sessionAttentionLabel(session)}</small>}</span>{sessionAttentionLabel(session) === undefined ? null : <span className={`sidebar-activity attention-${session.attentionState ?? "idle"} ${session.runState}`} role="status" aria-label={sessionAttentionLabel(session)} />}</button><Button variant="ghost" size="icon" aria-label={`管理会话 ${sessionLabel(session.name, session.preview)}`} onClick={() => props.onOpenSessionMenu(workspace.id, session)}><MoreVertical size={18} /></Button></div>)}
      {visibleEntries.length === 0 ? <div className="mobile-page-empty">暂无会话</div> : null}
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
