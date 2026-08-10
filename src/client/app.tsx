import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArrowLeft, ChevronDown, FolderPlus, MoreVertical, Pencil, Plus } from "lucide-react";
import type { ComposerCommand, ImageAttachment, ModelDescriptor, SessionRef, SessionSummary, ThinkingLevel, Workspace, WorkspaceFile } from "../shared/protocol";
import { workspaceEventSchema } from "../shared/protocol";
import { api, socketUrl } from "./api";
import { PromptEditor } from "./components/prompt-editor";
import { ModelSelector } from "./components/model-selector";
import { ThinkingSelector } from "./components/thinking-selector";
import { Sidebar } from "./components/sidebar";
import { SessionContextMenu, type SessionContextMenuTarget } from "./components/session-context-menu";
import { ProjectContextMenu, type ProjectContextMenuTarget } from "./components/project-context-menu";
import { MobileActionSheet, type MobileActionTarget } from "./components/mobile-action-sheet";
import { MobileProjectsPage, MobileSessionsPage, MobileSessionSwitcher } from "./components/mobile-navigation";
import { Timeline } from "./components/timeline";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { WorkspaceDialog } from "./components/workspace-dialog";
import { Tooltip } from "./components/ui/tooltip";
import { randomUUID, sessionLabel } from "./lib/utils";
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
  const [renameTarget, setRenameTarget] = useState<{ workspaceId: string; session: SessionSummary } | undefined>();
  const [renameValue, setRenameValue] = useState("");
  const [projectRenameTarget, setProjectRenameTarget] = useState<Workspace | undefined>();
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [projectRemoveTarget, setProjectRemoveTarget] = useState<Workspace | undefined>();
  const [projectRemovePending, setProjectRemovePending] = useState(false);
  const [mobilePage, setMobilePage] = useState<"projects" | "sessions" | "chat">(() => window.localStorage.getItem("jarvis.session") === null ? "projects" : "chat");
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [mobileSwitcherOpen, setMobileSwitcherOpen] = useState(false);
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [thinkingLevelPending, setThinkingLevelPending] = useState(false);
  const [compactionPending, setCompactionPending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readDrafts());
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, ImageAttachment[]>>({});
  const [sessionMenu, setSessionMenu] = useState<SessionContextMenuTarget | undefined>();
  const [projectMenu, setProjectMenu] = useState<ProjectContextMenuTarget | undefined>();
  const [mobileActionTarget, setMobileActionTarget] = useState<MobileActionTarget | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Pick<SessionContextMenuTarget, "workspaceId" | "session"> | undefined>();
  const [deletePending, setDeletePending] = useState(false);
  const [composerCommands, setComposerCommands] = useState<ComposerCommand[]>([]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedSession = selectedWorkspace === undefined
    ? undefined
    : (sessionsByWorkspace[selectedWorkspace.id] ?? []).find((session) => session.id === sessionId);
  const selectedRef = useMemo<SessionRef | undefined>(() => selectedWorkspace === undefined || selectedSession === undefined
    ? undefined
    : { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id }, [selectedWorkspace?.id, selectedSession?.id]);
  const selectedSessionId = selectedRef?.sessionId;
  const selectedDraft = selectedSessionId === undefined ? "" : drafts[selectedSessionId] ?? "";
  const updateDraft = useCallback((id: string, value: string) => {
    setDrafts((current) => current[id] === value ? current : { ...current, [id]: value });
  }, []);
  const updateSelectedDraft = useCallback((value: string) => {
    if (selectedSessionId !== undefined) updateDraft(selectedSessionId, value);
  }, [selectedSessionId, updateDraft]);
  const selectedAttachments = selectedSessionId === undefined ? [] : attachmentsBySession[selectedSessionId] ?? [];
  const updateSelectedAttachments = useCallback((value: ImageAttachment[]) => {
    if (selectedSessionId === undefined) return;
    setAttachmentsBySession((current) => {
      const existing = current[selectedSessionId] ?? [];
      if (existing.length === 0 && value.length === 0) return current;
      return { ...current, [selectedSessionId]: value };
    });
  }, [selectedSessionId]);
  const closeSessionMenu = useCallback(() => { setSessionMenu(undefined); }, []);
  const closeProjectMenu = useCallback(() => { setProjectMenu(undefined); }, []);
  // The stream owns the authoritative runtime model snapshot and realtime changes.
  const stream = useSessionStream(selectedRef);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Track the visual viewport so mobile layouts can shrink below the on-screen
  // keyboard (dvh does not include it on iOS/Android). Sets --vvh on the root;
  // CSS falls back to 100dvh when this runs in a browser without visualViewport.
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (visualViewport === null) return;
    const root = document.documentElement;
    const update = () => { root.style.setProperty("--vvh", `${String(visualViewport.height)}px`); };
    update();
    visualViewport.addEventListener("resize", update);
    visualViewport.addEventListener("scroll", update);
    return () => {
      visualViewport.removeEventListener("resize", update);
      visualViewport.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    setModelSwitchPending(false);
    setThinkingLevelPending(false);
    setCompactionPending(false);
  }, [selectedRef?.workspaceId, selectedRef?.sessionId]);

  useEffect(() => {
    if (selectedRef === undefined) {
      setComposerCommands([]);
      return;
    }
    let disposed = false;
    void api.commands(selectedRef).then((commands) => {
      if (!disposed) setComposerCommands(commands);
    }).catch(() => {
      if (!disposed) setComposerCommands([]);
    });
    return () => { disposed = true; };
  }, [selectedRef]);

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
    void loadWorkspaces().catch((error: unknown) => setPageError(error instanceof Error ? error.message : "无法加载项目")).finally(() => setLoading(false));
  }, [loadWorkspaces]);

  useEffect(() => {
    if (workspaces.length === 0) {
      setSessionsByWorkspace({});
      if (window.innerWidth <= 760) setMobilePage("projects");
      return;
    }
    let disposed = false;
    void loadProjectSessions(workspaces).then((sessions) => {
      if (!disposed) setSessionsByWorkspace(sessions);
    }).catch((error: unknown) => {
      if (!disposed) setPageError(error instanceof Error ? error.message : "无法加载会话");
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
    if (window.innerWidth <= 760) {
      setSessionId(undefined);
      if (mobilePage === "chat") setMobilePage("sessions");
      return;
    }
    setSessionId(sessions[0]?.id);
  }, [workspaces, sessionsByWorkspace, workspaceId, sessionId, loading, mobilePage]);

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
            const workspaceEvent = parsed.data;
            if (workspaceEvent.type === "session.deleted") {
              setSessionsByWorkspace((current) => {
                const sessions = current[workspace.id] ?? [];
                const next = withoutSession(sessions, workspaceEvent.sessionId);
                return next === sessions ? current : { ...current, [workspace.id]: next };
              });
              setDrafts((current) => withoutDraft(current, workspaceEvent.sessionId));
              setSessionMenu((current) => current?.workspaceId === workspace.id && current.session.id === workspaceEvent.sessionId ? undefined : current);
              setDeleteTarget((current) => current?.workspaceId === workspace.id && current.session.id === workspaceEvent.sessionId ? undefined : current);
              return;
            }
            setSessionsByWorkspace((current) => ({ ...current, [workspace.id]: mergeSession(current[workspace.id] ?? [], workspaceEvent.session) }));
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
      setPageError(error instanceof Error ? error.message : "无法创建会话");
    }
  };

  const addWorkspace = async (path: string, label?: string) => {
    const workspace = await api.addWorkspace(path, label);
    setWorkspaces((current) => mergeWorkspace(current, workspace));
    setSessionsByWorkspace((current) => current[workspace.id] === undefined ? { ...current, [workspace.id]: [] } : current);
    setExpandedWorkspaceIds((current) => ({ ...current, [workspace.id]: true }));
    setWorkspaceId(workspace.id);
    setSessionId(undefined);
    setPageError(undefined);
  };

  const renameSession = async () => {
    const target = renameTarget;
    if (target === undefined) return;
    try {
      const session = await api.renameSession({ workspaceId: target.workspaceId, sessionId: target.session.id }, renameValue);
      setSessionsByWorkspace((current) => ({ ...current, [target.workspaceId]: mergeSession(current[target.workspaceId] ?? [], session) }));
      setRenameTarget(undefined);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法重命名会话");
    }
  };

  const renameProject = async () => {
    const target = projectRenameTarget;
    if (target === undefined) return;
    try {
      const workspace = await api.renameWorkspace(target.id, projectRenameValue);
      setWorkspaces((current) => mergeWorkspace(current, workspace));
      setProjectRenameTarget(undefined);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法重命名项目");
    }
  };

  const removeProject = async () => {
    const target = projectRemoveTarget;
    if (target === undefined || projectRemovePending) return;
    setProjectRemovePending(true);
    try {
      await api.removeWorkspace(target.id);
      const remaining = workspaces.filter((workspace) => workspace.id !== target.id);
      setWorkspaces(remaining);
      setSessionsByWorkspace((current) => {
        const next = { ...current };
        delete next[target.id];
        return next;
      });
      setExpandedWorkspaceIds((current) => {
        const next = { ...current };
        delete next[target.id];
        return next;
      });
      if (workspaceId === target.id) {
        setWorkspaceId(remaining[0]?.id);
        setSessionId(undefined);
        setMobilePage("projects");
      }
      setProjectRemoveTarget(undefined);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法移除项目");
    } finally {
      setProjectRemovePending(false);
    }
  };

  const deleteSession = async () => {
    const target = deleteTarget;
    if (target === undefined || deletePending) return;
    setDeletePending(true);
    try {
      await api.removeSession({ workspaceId: target.workspaceId, sessionId: target.session.id });
      setSessionsByWorkspace((current) => ({ ...current, [target.workspaceId]: withoutSession(current[target.workspaceId] ?? [], target.session.id) }));
      setDrafts((current) => withoutDraft(current, target.session.id));
      if (workspaceId === target.workspaceId && sessionId === target.session.id) {
        setSessionId(undefined);
        setMobilePage("sessions");
        setMobileSwitcherOpen(false);
      }
      setDeleteTarget(undefined);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法删除会话");
    } finally {
      setDeletePending(false);
    }
  };

  const searchWorkspaceFiles = useCallback(async (query: string): Promise<WorkspaceFile[]> => {
    if (selectedRef === undefined) return [];
    return api.searchFiles(selectedRef.workspaceId, query);
  }, [selectedRef]);

  // Stable reference so PromptEditor's paste extension never changes identity
  // (a changing extensions array makes useCodeMirror reconfigure the editor).
  const reportAttachmentError = useCallback((message: string) => { setPageError(message); }, []);

  const submitPrompt = async (text: string, attachments: ImageAttachment[]): Promise<boolean> => {
    if (selectedRef === undefined) return false;
    try {
      await api.prompt(selectedRef, text, randomUUID(), attachments);
      setSessionsByWorkspace((current) => ({
        ...current,
        [selectedRef.workspaceId]: current[selectedRef.workspaceId]?.map((session) => session.id === selectedRef.sessionId
          ? { ...session, runState: "running", updatedAt: new Date().toISOString() }
          : session) ?? [],
      }));
      setPageError(undefined);
      return true;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法发送消息");
      return false;
    }
  };

  const abort = async () => {
    if (selectedRef === undefined) return;
    try {
      await api.abort(selectedRef, stream.transcript.status.activeRun?.id);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法停止执行");
    }
  };

  const compact = async () => {
    if (selectedRef === undefined || compactionPending) return;
    setCompactionPending(true);
    try {
      await api.compact(selectedRef);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法压缩上下文");
      setCompactionPending(false);
    }
  };

  useEffect(() => {
    if (stream.transcript.status.compacting === undefined) setCompactionPending(false);
  }, [stream.transcript.status.compacting]);

  const selectModel = async (model: ModelDescriptor) => {
    if (selectedRef === undefined || modelSwitchPending) return;
    setModelSwitchPending(true);
    try {
      await stream.selectModel(model);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法切换模型");
    } finally {
      setModelSwitchPending(false);
    }
  };

  const selectThinkingLevel = async (level: ThinkingLevel) => {
    if (selectedRef === undefined || thinkingLevelPending) return;
    setThinkingLevelPending(true);
    try {
      await stream.setThinkingLevel(level);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法切换思考等级");
    } finally {
      setThinkingLevelPending(false);
    }
  };

  const chooseSession = (nextWorkspaceId: string, nextSessionId: string) => {
    setWorkspaceId(nextWorkspaceId);
    setSessionId(nextSessionId);
    setExpandedWorkspaceIds((current) => ({ ...current, [nextWorkspaceId]: true }));
    setMobilePage("chat");
    setMobileSwitcherOpen(false);
  };

  const openMobileProject = (workspace: Workspace) => {
    setWorkspaceId(workspace.id);
    setSessionId(undefined);
    setMobilePage("sessions");
    setMobileSwitcherOpen(false);
  };

  const openMobileProjectMenu = (workspace: Workspace) => {
    setMobileActionTarget({ kind: "project", workspace });
  };

  const openMobileSessionMenu = (workspaceId: string, session: SessionSummary) => {
    setMobileActionTarget({ kind: "session", workspaceId, session });
  };

  const sidebar = <Sidebar
    workspaces={workspaces}
    sessionsByWorkspace={sessionsByWorkspace}
    workspaceId={workspaceId}
    selectedSessionId={sessionId}
    expandedWorkspaceIds={expandedWorkspaceIds}
    onToggleWorkspace={(id) => setExpandedWorkspaceIds((current) => ({ ...current, [id]: !current[id] }))}
    onOpenWorkspaceDialog={() => { setWorkspaceDialogOpen(true); }}
    onCreateSession={(id) => { void createSession(id); }}
    onSelectSession={chooseSession}
    onOpenProjectMenu={(workspace, position) => setProjectMenu({ workspace, ...position })}
    onOpenSessionMenu={(targetWorkspaceId, session, position) => setSessionMenu({ workspaceId: targetWorkspaceId, session, ...position })}
    onLongPressProject={(workspace) => setMobileActionTarget({ kind: "project", workspace })}
    onLongPressSession={(targetWorkspaceId, session) => setMobileActionTarget({ kind: "session", workspaceId: targetWorkspaceId, session })}
  />;

  if (loading) return <main className="app-loading">正在打开工作区…</main>;

  const renderChatContent = () => <>
    {pageError === undefined ? null : <div className="page-error" role="alert"><span>{pageError}</span><button type="button" aria-label="关闭错误提示" onClick={() => setPageError(undefined)}>关闭</button></div>}
    {selectedRef === undefined ? <section className="empty-workspace"><FolderPlus size={28} /><h2>未选择会话</h2><Button onClick={() => { void createSession(); }} disabled={workspaceId === undefined}><Plus size={16} /> 新建会话</Button></section> : <>
      <Timeline items={stream.transcript.items} streamingMessageId={stream.transcript.streamingMessageId} hasMore={stream.transcript.hasMore} loadingMore={stream.loadingEarlier} onLoadMore={stream.loadEarlier} error={stream.error ?? stream.transcript.status.lastError?.message} status={stream.transcript.status} />
      <PromptEditor key={selectedRef.sessionId} initialValue={selectedDraft} busy={stream.transcript.status.runState !== "idle" || compactionPending} commands={composerCommands} searchFiles={searchWorkspaceFiles} onDraftChange={updateSelectedDraft} onSubmit={submitPrompt} onStop={() => { void abort(); }} attachments={selectedAttachments} onAttachmentsChange={updateSelectedAttachments} onAttachmentError={reportAttachmentError} attachDisabled={stream.transcript.model.current?.vision === false} controls={selectedSession === undefined ? undefined : <>
        <ModelSelector model={stream.transcript.model} disabled={stream.connection !== "live" || thinkingLevelPending || compactionPending} pending={modelSwitchPending} onSelect={(model) => { void selectModel(model); }} />
        <ThinkingSelector thinking={stream.transcript.thinking} disabled={stream.connection !== "live" || modelSwitchPending || compactionPending} pending={thinkingLevelPending} onSelect={(level) => { void selectThinkingLevel(level); }} />
        <Tooltip label="压缩上下文"><Button variant="ghost" size="icon" aria-label="压缩上下文" disabled={stream.connection !== "live" || stream.transcript.status.runState !== "idle" || compactionPending} onClick={() => { void compact(); }}><Archive size={15} /></Button></Tooltip>
      </>} />
    </>}
  </>;

  return (
    <main className="app-shell">
      <div className="desktop-sidebar">{sidebar}</div>
      {!isMobile ? <section className="main-pane">
        <header className="chat-header">
          <div className="chat-title-wrap">
            <div className="chat-title">
              <div><h1>{selectedSession === undefined ? "新会话" : sessionLabel(selectedSession.name, selectedSession.preview)}</h1>{selectedSession === undefined || selectedWorkspace === undefined ? null : <Tooltip label="重命名会话"><Button variant="ghost" size="icon" aria-label="重命名会话" onClick={() => { setRenameTarget({ workspaceId: selectedWorkspace.id, session: selectedSession }); setRenameValue(selectedSession.name ?? sessionLabel(selectedSession.name, selectedSession.preview)); }}><Pencil size={15} /></Button></Tooltip>}</div>
            </div>
          </div>
        </header>
        {renderChatContent()}
      </section> : null}
      {isMobile ? <div className="mobile-app">
        {mobilePage === "projects" ? <MobileProjectsPage workspaces={workspaces} onAddProject={() => setWorkspaceDialogOpen(true)} onOpenProject={openMobileProject} onOpenProjectMenu={openMobileProjectMenu} /> : mobilePage === "sessions" ? <MobileSessionsPage workspace={selectedWorkspace} sessions={sessionsByWorkspace[workspaceId ?? ""] ?? []} onBack={() => setMobilePage("projects")} onCreateSession={() => { void createSession(workspaceId); }} onSelectSession={(id) => { if (workspaceId !== undefined) chooseSession(workspaceId, id); }} onOpenProjectMenu={openMobileProjectMenu} onOpenSessionMenu={(session) => { if (workspaceId !== undefined) openMobileSessionMenu(workspaceId, session); }} /> : <section className="mobile-chat-page">
          <header className="mobile-chat-header">
            <Button variant="ghost" size="icon" aria-label="返回会话列表" onClick={() => setMobilePage("sessions")}><ArrowLeft size={19} /></Button>
            <button type="button" className="mobile-chat-session" onClick={() => setMobileSwitcherOpen(true)}>{selectedSession === undefined ? "新会话" : sessionLabel(selectedSession.name, selectedSession.preview)}<ChevronDown size={15} /></button>
            {selectedSession === undefined || selectedWorkspace === undefined ? null : <Button variant="ghost" size="icon" aria-label="当前会话操作" onClick={() => openMobileSessionMenu(selectedWorkspace.id, selectedSession)}><MoreVertical size={18} /></Button>}
          </header>
          <div className="mobile-chat-content">{renderChatContent()}</div>
          {mobileSwitcherOpen ? <MobileSessionSwitcher workspace={selectedWorkspace} sessions={sessionsByWorkspace[workspaceId ?? ""] ?? []} selectedSessionId={sessionId} onClose={() => setMobileSwitcherOpen(false)} onCreateSession={() => { void createSession(workspaceId); }} onSelectSession={(id) => { if (workspaceId !== undefined) chooseSession(workspaceId, id); }} /> : null}
        </section>}
      </div> : null}

      {sessionMenu === undefined ? null : <SessionContextMenu target={sessionMenu} onClose={closeSessionMenu} onRename={(target) => {
        setSessionMenu(undefined);
        setRenameTarget({ workspaceId: target.workspaceId, session: target.session });
        setRenameValue(target.session.name ?? sessionLabel(target.session.name, target.session.preview));
      }} onDelete={(target) => {
        setSessionMenu(undefined);
        setDeleteTarget({ workspaceId: target.workspaceId, session: target.session });
      }} />}
      {projectMenu === undefined ? null : <ProjectContextMenu target={projectMenu} onClose={closeProjectMenu} onCreateSession={(workspace) => {
        setProjectMenu(undefined);
        void createSession(workspace.id);
      }} onRename={(workspace) => {
        setProjectMenu(undefined);
        setProjectRenameTarget(workspace);
        setProjectRenameValue(workspace.label);
      }} onRemove={(workspace) => {
        setProjectMenu(undefined);
        setProjectRemoveTarget(workspace);
      }} />}
      <MobileActionSheet target={mobileActionTarget} onClose={() => setMobileActionTarget(undefined)} onRenameProject={(workspace) => {
        setMobileActionTarget(undefined);
        setProjectRenameTarget(workspace);
        setProjectRenameValue(workspace.label);
      }} onRemoveProject={(workspace) => {
        setMobileActionTarget(undefined);
        setProjectRemoveTarget(workspace);
      }} onRenameSession={(targetWorkspaceId, session) => {
        setMobileActionTarget(undefined);
        setRenameTarget({ workspaceId: targetWorkspaceId, session });
        setRenameValue(session.name ?? sessionLabel(session.name, session.preview));
      }} onDeleteSession={(targetWorkspaceId, session) => {
        setMobileActionTarget(undefined);
        setDeleteTarget({ workspaceId: targetWorkspaceId, session });
      }} />

      <WorkspaceDialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen} onAdd={addWorkspace} />

      <Dialog open={renameTarget !== undefined} onOpenChange={(open) => { if (!open) setRenameTarget(undefined); }}>
        <DialogContent title="重命名会话">
          <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void renameSession(); }}><input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus /><Button type="submit" disabled={renameValue.trim() === ""}>保存</Button></form>
        </DialogContent>
      </Dialog>
      <Dialog open={projectRenameTarget !== undefined} onOpenChange={(open) => { if (!open) setProjectRenameTarget(undefined); }}>
        <DialogContent title="重命名项目">
          <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void renameProject(); }}><input value={projectRenameValue} onChange={(event) => setProjectRenameValue(event.target.value)} autoFocus /><Button type="submit" disabled={projectRenameValue.trim() === ""}>保存</Button></form>
        </DialogContent>
      </Dialog>
      <Dialog open={projectRemoveTarget !== undefined} onOpenChange={(open) => { if (!open && !projectRemovePending) setProjectRemoveTarget(undefined); }}>
        <DialogContent title="移除项目" description="此操作只会将项目从 Jarvis 中移除。">
          <p className="delete-session-message"><strong>{projectRemoveTarget?.label ?? ""}</strong>及其会话历史将保留在磁盘上。</p>
          <div className="dialog-actions"><Button variant="secondary" onClick={() => setProjectRemoveTarget(undefined)} disabled={projectRemovePending}>取消</Button><Button variant="danger" onClick={() => { void removeProject(); }} disabled={projectRemovePending}>{projectRemovePending ? "正在移除…" : "移除项目"}</Button></div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== undefined} onOpenChange={(open) => { if (!open && !deletePending) setDeleteTarget(undefined); }}>
        <DialogContent title="删除会话" description="此操作将永久删除 Pi 会话历史。">
          <p className="delete-session-message"><strong>{deleteTarget === undefined ? "" : sessionLabel(deleteTarget.session.name, deleteTarget.session.preview)}</strong>将被永久删除。</p>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setDeleteTarget(undefined)} disabled={deletePending}>取消</Button>
            <Button variant="danger" onClick={() => { void deleteSession(); }} disabled={deletePending}>{deletePending ? "正在删除…" : "删除会话"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function withoutSession(current: SessionSummary[], sessionId: string): SessionSummary[] {
  const next = current.filter((session) => session.id !== sessionId);
  return next.length === current.length ? current : next;
}

function withoutDraft(current: Record<string, string>, sessionId: string): Record<string, string> {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
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
