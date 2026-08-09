import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderPlus, Menu, Pencil, Plus, Trash2 } from "lucide-react";
import type { ModelDescriptor, SessionRef, SessionSummary, Workspace } from "../shared/protocol";
import { workspaceEventSchema } from "../shared/protocol";
import { api, socketUrl } from "./api";
import { PromptEditor } from "./components/prompt-editor";
import { ModelSelector } from "./components/model-selector";
import { Sidebar } from "./components/sidebar";
import { Timeline } from "./components/timeline";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { Tooltip } from "./components/ui/tooltip";
import { sessionLabel } from "./lib/utils";
import { useSessionStream } from "./hooks/use-session-stream";

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() => window.localStorage.getItem("jarvis.workspace") ?? undefined);
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, SessionSummary[]>>({});
  const [sessionId, setSessionId] = useState<string | undefined>(() => window.localStorage.getItem("jarvis.session") ?? undefined);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Record<string, boolean>>(() => readExpandedWorkspaces());
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | undefined>();
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readDrafts());

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedSession = selectedWorkspace === undefined
    ? undefined
    : (sessionsByWorkspace[selectedWorkspace.id] ?? []).find((session) => session.id === sessionId);
  const selectedRef = useMemo<SessionRef | undefined>(() => selectedWorkspace === undefined || selectedSession === undefined
    ? undefined
    : { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id }, [selectedWorkspace?.id, selectedSession?.id]);
  // The stream owns the authoritative runtime model snapshot and realtime changes.
  const stream = useSessionStream(selectedRef);

  useEffect(() => { setModelSwitchPending(false); }, [selectedRef?.workspaceId, selectedRef?.sessionId]);

  const loadWorkspaces = useCallback(async () => {
    const values = await api.listWorkspaces();
    setWorkspaces(values);
    setWorkspaceId((current) => current !== undefined && values.some((workspace) => workspace.id === current) ? current : values[0]?.id);
  }, []);

  const loadProjectSessions = useCallback(async (projects: Workspace[]): Promise<Record<string, SessionSummary[]>> => {
    const entries = await Promise.all(projects.map(async (workspace) => [workspace.id, await api.listSessions(workspace.id)] as const));
    return Object.fromEntries(entries);
  }, []);

  useEffect(() => {
    void loadWorkspaces().catch((error: unknown) => setPageError(error instanceof Error ? error.message : "Unable to load projects")).finally(() => setLoading(false));
  }, [loadWorkspaces]);

  useEffect(() => {
    if (workspaces.length === 0) {
      setSessionsByWorkspace({});
      return;
    }
    let disposed = false;
    void loadProjectSessions(workspaces).then((sessions) => {
      if (!disposed) setSessionsByWorkspace(sessions);
    }).catch((error: unknown) => {
      if (!disposed) setPageError(error instanceof Error ? error.message : "Unable to load sessions");
    });
    return () => { disposed = true; };
  }, [workspaces, loadProjectSessions]);

  useEffect(() => {
    if (workspaces.length === 0) {
      if (!loading) {
        if (workspaceId !== undefined) setWorkspaceId(undefined);
        if (sessionId !== undefined) setSessionId(undefined);
      }
      return;
    }
    const workspace = workspaceId === undefined ? undefined : workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace === undefined) {
      setWorkspaceId(workspaces[0]?.id);
      return;
    }
    const sessions = sessionsByWorkspace[workspace.id];
    if (sessions === undefined) return;
    if (sessionId !== undefined && sessions.some((session) => session.id === sessionId)) return;
    setSessionId(sessions[0]?.id);
  }, [workspaces, sessionsByWorkspace, workspaceId, sessionId, loading]);

  useEffect(() => {
    setExpandedWorkspaceIds((current) => {
      const next: Record<string, boolean> = {};
      let changed = Object.keys(current).length !== workspaces.length;
      for (const workspace of workspaces) {
        const value = current[workspace.id] ?? (workspace.id === workspaceId || workspace.id === workspaces[0]?.id);
        next[workspace.id] = value;
        if (current[workspace.id] !== value) changed = true;
      }
      return changed ? next : current;
    });
  }, [workspaces, workspaceId]);

  useEffect(() => {
    if (workspaceId === undefined) window.localStorage.removeItem("jarvis.workspace");
    else window.localStorage.setItem("jarvis.workspace", workspaceId);
  }, [workspaceId]);

  useEffect(() => {
    if (sessionId === undefined) window.localStorage.removeItem("jarvis.session");
    else window.localStorage.setItem("jarvis.session", sessionId);
  }, [sessionId]);

  useEffect(() => {
    window.localStorage.setItem("jarvis.projects.expanded", JSON.stringify(expandedWorkspaceIds));
  }, [expandedWorkspaceIds]);

  useEffect(() => {
    window.localStorage.setItem("jarvis.drafts", JSON.stringify(drafts));
  }, [drafts]);

  useEffect(() => {
    let disposed = false;
    const cleanups = workspaces.map((workspace) => {
      let socket: WebSocket | undefined;
      let reconnect: number | undefined;
      const connect = () => {
        if (disposed) return;
        const connection = new WebSocket(socketUrl(`/api/workspaces/${workspace.id}/events`));
        socket = connection;
        connection.addEventListener("message", (event) => {
          try {
            const parsed = workspaceEventSchema.safeParse(JSON.parse(String(event.data)));
            if (!parsed.success) return;
            setSessionsByWorkspace((current) => ({
              ...current,
              [workspace.id]: mergeSession(current[workspace.id] ?? [], parsed.data.session),
            }));
          } catch {
            // A malformed workspace event does not invalidate the active view.
          }
        });
        connection.addEventListener("close", () => {
          if (!disposed && socket === connection) reconnect = window.setTimeout(connect, 1_500);
        });
      };
      connect();
      return () => {
        if (reconnect !== undefined) window.clearTimeout(reconnect);
        socket?.close();
      };
    });
    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [workspaces]);

  useEffect(() => {
    const status = stream.transcript.status;
    if (status.sessionId === "" || selectedRef === undefined) return;
    setSessionsByWorkspace((current) => {
      const sessions = current[selectedRef.workspaceId] ?? [];
      const index = sessions.findIndex((session) => session.id === status.sessionId);
      if (index === -1) return current;
      const next = [...sessions];
      const session = next[index];
      if (session === undefined || session.runState === status.runState) return current;
      next[index] = { ...session, runState: status.runState };
      return { ...current, [selectedRef.workspaceId]: next };
    });
  }, [stream.transcript.status, selectedRef]);

  const createSession = async (targetWorkspaceId = workspaceId) => {
    if (targetWorkspaceId === undefined) return;
    try {
      const session = await api.createSession(targetWorkspaceId);
      setSessionsByWorkspace((current) => ({ ...current, [targetWorkspaceId]: mergeSession(current[targetWorkspaceId] ?? [], session) }));
      setWorkspaceId(targetWorkspaceId);
      setSessionId(session.id);
      setExpandedWorkspaceIds((current) => ({ ...current, [targetWorkspaceId]: true }));
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to create session");
    }
  };

  const addWorkspace = async () => {
    try {
      const workspace = await api.addWorkspace(workspacePath, workspaceLabel.trim() || undefined);
      setWorkspaces((current) => mergeWorkspace(current, workspace));
      setSessionsByWorkspace((current) => current[workspace.id] === undefined ? { ...current, [workspace.id]: [] } : current);
      setExpandedWorkspaceIds((current) => ({ ...current, [workspace.id]: true }));
      setWorkspaceId(workspace.id);
      setSessionId(undefined);
      setWorkspacePath("");
      setWorkspaceLabel("");
      setWorkspaceDialogOpen(false);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to add project");
    }
  };

  const removeWorkspace = async (id: string) => {
    try {
      await api.removeWorkspace(id);
      const remaining = workspaces.filter((workspace) => workspace.id !== id);
      setWorkspaces(remaining);
      setSessionsByWorkspace((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setExpandedWorkspaceIds((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      if (workspaceId === id) {
        setWorkspaceId(remaining[0]?.id);
        setSessionId(undefined);
      }
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to remove project");
    }
  };

  const renameSession = async () => {
    if (selectedRef === undefined) return;
    try {
      const session = await api.renameSession(selectedRef, renameValue);
      setSessionsByWorkspace((current) => ({ ...current, [selectedRef.workspaceId]: mergeSession(current[selectedRef.workspaceId] ?? [], session) }));
      setRenameOpen(false);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to rename session");
    }
  };

  const submitPrompt = async (text: string): Promise<boolean> => {
    if (selectedRef === undefined) return false;
    try {
      await api.prompt(selectedRef, text, crypto.randomUUID());
      setSessionsByWorkspace((current) => ({
        ...current,
        [selectedRef.workspaceId]: current[selectedRef.workspaceId]?.map((session) => session.id === selectedRef.sessionId
          ? { ...session, runState: "running", updatedAt: new Date().toISOString() }
          : session) ?? [],
      }));
      setPageError(undefined);
      return true;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to send prompt");
      return false;
    }
  };

  const abort = async () => {
    if (selectedRef === undefined) return;
    try {
      await api.abort(selectedRef, stream.transcript.status.activeRun?.id);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to stop the run");
    }
  };

  const selectModel = async (model: ModelDescriptor) => {
    if (selectedRef === undefined || modelSwitchPending) return;
    setModelSwitchPending(true);
    try {
      await stream.selectModel(model);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Unable to change model");
    } finally {
      setModelSwitchPending(false);
    }
  };

  const chooseSession = (nextWorkspaceId: string, nextSessionId: string) => {
    setWorkspaceId(nextWorkspaceId);
    setSessionId(nextSessionId);
    setExpandedWorkspaceIds((current) => ({ ...current, [nextWorkspaceId]: true }));
    setMobileOpen(false);
  };

  const sidebar = <Sidebar
    workspaces={workspaces}
    sessionsByWorkspace={sessionsByWorkspace}
    workspaceId={workspaceId}
    selectedSessionId={sessionId}
    expandedWorkspaceIds={expandedWorkspaceIds}
    onToggleWorkspace={(id) => setExpandedWorkspaceIds((current) => ({ ...current, [id]: !current[id] }))}
    onOpenWorkspaceDialog={() => { setWorkspaceDialogOpen(true); setMobileOpen(false); }}
    onCreateSession={(id) => { void createSession(id); setMobileOpen(false); }}
    onSelectSession={chooseSession}
  />;

  if (loading) return <main className="app-loading">Opening workspace...</main>;

  return (
    <main className="app-shell">
      <div className="desktop-sidebar">{sidebar}</div>
      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="dialog-overlay mobile-overlay" />
          <DialogPrimitive.Content className="mobile-sidebar" aria-label="Project and session navigation">{sidebar}</DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <section className="main-pane">
        <header className="chat-header">
          <div className="chat-title-wrap">
            <Tooltip label="Open navigation"><Button variant="ghost" size="icon" className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={19} /></Button></Tooltip>
            <div className="chat-title">
              <div><h1>{selectedSession === undefined ? "New session" : sessionLabel(selectedSession.name, selectedSession.preview)}</h1>{selectedSession === undefined ? null : <Tooltip label="Rename session"><Button variant="ghost" size="icon" aria-label="Rename session" onClick={() => { setRenameValue(selectedSession.name ?? sessionLabel(selectedSession.name, selectedSession.preview)); setRenameOpen(true); }}><Pencil size={15} /></Button></Tooltip>}</div>
            </div>
          </div>
        </header>
        {pageError === undefined ? null : <div className="page-error" role="alert"><span>{pageError}</span><button type="button" aria-label="Dismiss error" onClick={() => setPageError(undefined)}>Dismiss</button></div>}
        {selectedRef === undefined ? <section className="empty-workspace"><FolderPlus size={28} /><h2>No session selected</h2><Button onClick={() => { void createSession(); }} disabled={workspaceId === undefined}><Plus size={16} /> New session</Button></section> : <>
          <Timeline items={stream.transcript.items} hasMore={stream.transcript.hasMore} loadingMore={stream.loadingEarlier} onLoadMore={stream.loadEarlier} error={stream.error ?? stream.transcript.status.lastError?.message} />
          <PromptEditor
            key={selectedRef.sessionId}
            sessionId={selectedRef.sessionId}
            initialValue={drafts[selectedRef.sessionId] ?? ""}
            busy={stream.transcript.status.runState !== "idle"}
            onDraftChange={(value) => setDrafts((current) => ({ ...current, [selectedRef.sessionId]: value }))}
            onSubmit={submitPrompt}
            onStop={() => { void abort(); }}
            controls={selectedSession === undefined ? undefined : <ModelSelector model={stream.transcript.model} disabled={stream.connection !== "live" || stream.transcript.status.runState !== "idle"} pending={modelSwitchPending} onSelect={(model) => { void selectModel(model); }} />}
          />
        </>}
      </section>

      <Dialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen}>
        <DialogContent title="Projects" description="Add a local directory or remove a registered project.">
          <div className="workspace-form">
            <label>Path<input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/path/to/project" autoFocus /></label>
            <label>Name <span>optional</span><input value={workspaceLabel} onChange={(event) => setWorkspaceLabel(event.target.value)} placeholder="Project name" /></label>
            <Button onClick={() => { void addWorkspace(); }} disabled={workspacePath.trim() === ""}><FolderPlus size={16} /> Add project</Button>
          </div>
          <div className="registered-workspaces">
            {workspaces.map((workspace) => <div key={workspace.id} className="registered-workspace"><div><strong>{workspace.label}</strong><span>{workspace.cwd}</span></div><Tooltip label="Remove project"><Button variant="ghost" size="icon" aria-label={`Remove ${workspace.label}`} onClick={() => { void removeWorkspace(workspace.id); }}><Trash2 size={15} /></Button></Tooltip></div>)}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent title="Rename session">
          <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void renameSession(); }}><input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus /><Button type="submit" disabled={renameValue.trim() === ""}>Save</Button></form>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function mergeSession(current: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const existing = current.findIndex((session) => session.id === next.id);
  if (existing === -1) return [next, ...current].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const copy = [...current];
  copy[existing] = { ...copy[existing], ...next };
  return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function mergeWorkspace(current: Workspace[], next: Workspace): Workspace[] {
  const existing = current.findIndex((workspace) => workspace.id === next.id);
  if (existing === -1) return [...current, next].sort((a, b) => a.label.localeCompare(b.label));
  const copy = [...current];
  copy[existing] = next;
  return copy.sort((a, b) => a.label.localeCompare(b.label));
}

function readExpandedWorkspaces(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem("jarvis.projects.expanded");
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function readDrafts(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem("jarvis.drafts");
    const parsed = raw === null ? undefined : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}
