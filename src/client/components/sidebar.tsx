import { ChevronRight, Folder, FolderPlus, MessageSquarePlus, Settings2 } from "lucide-react";
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
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <span>Projects</span>
        <Tooltip label="Add project"><Button variant="ghost" size="icon" aria-label="Add project" onClick={props.onOpenWorkspaceDialog}><FolderPlus size={16} /></Button></Tooltip>
      </div>
      <nav className="project-tree" aria-label="Projects">
        {props.workspaces.map((workspace) => {
          const sessions = props.sessionsByWorkspace[workspace.id] ?? [];
          const expanded = props.expandedWorkspaceIds[workspace.id] === true;
          const active = workspace.id === props.workspaceId;
          const toggleLabel = `${expanded ? "Collapse" : "Expand"} ${workspace.label} sessions`;

          return (
            <section className={`project-node ${active ? "active" : ""}`} key={workspace.id}>
              <div className="project-row">
                <button className="project-toggle" type="button" aria-label={toggleLabel} aria-expanded={expanded} onClick={() => props.onToggleWorkspace(workspace.id)}>
                  <ChevronRight className={expanded ? "project-chevron-expanded" : ""} size={14} />
                  <Folder size={15} />
                  <span>{workspace.label}</span>
                </button>
                <Tooltip label={`New session in ${workspace.label}`}><Button variant="ghost" size="icon" className="project-new-session" aria-label={`New session in ${workspace.label}`} onClick={() => props.onCreateSession(workspace.id)}><MessageSquarePlus size={15} /></Button></Tooltip>
              </div>
              {expanded ? <div className="project-sessions" role="group">
                {sessions.map((session) => <button key={session.id} type="button" data-session-id={session.id} className={`session-row ${workspace.id === props.workspaceId && session.id === props.selectedSessionId ? "selected" : ""}`} aria-current={workspace.id === props.workspaceId && session.id === props.selectedSessionId ? "page" : undefined} onClick={() => props.onSelectSession(workspace.id, session.id)}>
                  <span className={`session-dot ${session.runState}`}></span>
                  <span className="session-text"><strong>{sessionLabel(session.name, session.preview)}</strong><small>{formatRelativeTime(session.updatedAt)}</small></span>
                </button>)}
                {sessions.length === 0 ? <div className="project-empty">No sessions</div> : null}
              </div> : null}
            </section>
          );
        })}
        {props.workspaces.length === 0 ? <div className="session-list-empty"><Settings2 size={17} /><span>No projects yet</span></div> : null}
      </nav>
      <div className="sidebar-footer"><span>Local</span></div>
    </aside>
  );
}
