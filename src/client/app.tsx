import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowLeft, ChevronDown, FolderPlus, MoreVertical, Pencil, Plus } from "lucide-react";
import type { ComposerCommand, ImageAttachment, ModelDescriptor, SessionRef, SessionSummary, ThinkingLevel, Workspace, WorkspaceFile } from "../shared/protocol";
import { workspaceEventSchema } from "../shared/protocol";
import { api, isSessionConflict, socketUrl } from "./api";
import { PromptEditor } from "./components/prompt-editor";
import { ModelSelector } from "./components/model-selector";
import { ThinkingSelector } from "./components/thinking-selector";
import { Sidebar } from "./components/sidebar";
import { SessionContextMenu, type SessionContextMenuTarget } from "./components/session-context-menu";
import { ProjectContextMenu, type ProjectContextMenuTarget } from "./components/project-context-menu";
import { MobileActionSheet, type MobileActionTarget } from "./components/mobile-action-sheet";
import { MobileProjectsPage, MobileSessionsPage, MobileSessionSwitcher } from "./components/mobile-navigation";
import { Timeline } from "./components/timeline";
import type { ExtensionPanelState } from "./hooks/use-session-stream";
import { ContextButton } from "./components/context-button";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { WorkspaceDialog } from "./components/workspace-dialog";
import { Tooltip } from "./components/ui/tooltip";
import { randomUUID, parseBashCommand, sessionLabel } from "./lib/utils";
import { useSessionStream } from "./hooks/use-session-stream";

/** Extract the entity ids carried by the current hash route. */
function pathParams(pathname: string): { workspaceId?: string; sessionId?: string } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "chat" && parts.length >= 3) return { workspaceId: parts[1], sessionId: parts[2] };
  if (parts[0] === "sessions" && parts.length >= 2) return { workspaceId: parts[1] };
  return {};
}

const COMMAND_RETRY_BASE_DELAY_MS = 750;
const COMMAND_RETRY_MAX_DELAY_MS = 10_000;
const EMPTY_COMPOSER_COMMANDS: ComposerCommand[] = [];

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialPath = pathParams(location.pathname);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() => initialPath.workspaceId ?? window.localStorage.getItem("jarvis.workspace") ?? undefined);
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, SessionSummary[]>>({});
  const [sessionId, setSessionId] = useState<string | undefined>(() => initialPath.sessionId ?? window.localStorage.getItem("jarvis.session") ?? undefined);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Record<string, boolean>>(() => readExpandedWorkspaces());
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | undefined>();
  const [sessionNotice, setSessionNotice] = useState<string | undefined>();
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ workspaceId: string; session: SessionSummary } | undefined>();
  const [renameValue, setRenameValue] = useState("");
  const [projectRenameTarget, setProjectRenameTarget] = useState<Workspace | undefined>();
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [projectRemoveTarget, setProjectRemoveTarget] = useState<Workspace | undefined>();
  const [projectRemovePending, setProjectRemovePending] = useState(false);
  // The mobile page stack is the hash route: #/projects, #/sessions/:workspaceId, #/chat/:workspaceId/:sessionId.
  const mobilePage: "projects" | "sessions" | "chat" = location.pathname.startsWith("/chat") ? "chat" : location.pathname.startsWith("/sessions") ? "sessions" : "projects";
  // The session switcher lives in the query string so the back key closes it first.
  const mobileSwitcherOpen = new URLSearchParams(location.search).get("overlay") === "switcher";
  const closeMobileSwitcher = useCallback(() => {
    navigate(location.pathname, { replace: true });
  }, [location.pathname, navigate]);
  // When switching sessions from the switcher we pop the overlay entry and then
  // replace the entry that first entered chat, so the back key goes straight to
  // the session list instead of walking back through previously viewed sessions.
  const pendingSessionSwitchRef = useRef<string | undefined>(undefined);
  // Prevent repeated clicks from creating several unused sessions in the same workspace.
  const creatingSessionWorkspacesRef = useRef(new Set<string>());
  useEffect(() => {
    const target = pendingSessionSwitchRef.current;
    if (target === undefined) return;
    pendingSessionSwitchRef.current = undefined;
    navigate(target, { replace: true });
  }, [location.pathname, location.search, navigate]);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  // The URL is the source of truth for the selected workspace/session.
  useEffect(() => {
    const { workspaceId: pathWorkspaceId, sessionId: pathSessionId } = pathParams(location.pathname);
    if (pathWorkspaceId !== undefined && pathWorkspaceId !== workspaceId) setWorkspaceId(pathWorkspaceId);
    if (pathSessionId !== undefined && pathSessionId !== sessionId) setSessionId(pathSessionId);
  }, [location.pathname, workspaceId, sessionId]);

  // First visit (empty hash): restore from localStorage or land on the project list.
  useEffect(() => {
    if (location.pathname !== "/") return;
    const restoredWorkspace = window.localStorage.getItem("jarvis.workspace");
    const restoredSession = window.localStorage.getItem("jarvis.session");
    if (restoredWorkspace !== null && restoredSession !== null) navigate(`/chat/${restoredWorkspace}/${restoredSession}`, { replace: true });
    else if (restoredWorkspace !== null) navigate(`/sessions/${restoredWorkspace}`, { replace: true });
    else navigate("/projects", { replace: true });
  }, [location.pathname, navigate]);

  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [thinkingLevelPending, setThinkingLevelPending] = useState(false);
  const [compactionPending, setCompactionPending] = useState(false);
  const [compactionRequest, setCompactionRequest] = useState<{ runId: string; baselineSeq: number }>();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readDrafts());
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, ImageAttachment[]>>({});
  const [forkTarget, setForkTarget] = useState<Extract<import("../shared/protocol").TimelineItem, { kind: "message" }>>();
  const [forkPending, setForkPending] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<SessionContextMenuTarget | undefined>();
  const [projectMenu, setProjectMenu] = useState<ProjectContextMenuTarget | undefined>();
  const [mobileActionTarget, setMobileActionTarget] = useState<MobileActionTarget | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<Pick<SessionContextMenuTarget, "workspaceId" | "session"> | undefined>();
  const [deletePending, setDeletePending] = useState(false);
  const [composerCommands, setComposerCommands] = useState<{ sessionKey: string; items: ComposerCommand[] } | undefined>();

  const activeRunStateByWorkspace = useMemo(() => {
    const result: Record<string, "running" | "stopping"> = {};
    for (const [id, sessions] of Object.entries(sessionsByWorkspace)) {
      const active = sessions.find((session): session is SessionSummary & { runState: "running" | "stopping" } => session.runState !== "idle");
      if (active !== undefined) result[id] = active.runState;
    }
    return result;
  }, [sessionsByWorkspace]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedSession = selectedWorkspace === undefined
    ? undefined
    : (sessionsByWorkspace[selectedWorkspace.id] ?? []).find((session) => session.id === sessionId);
  const selectedRef = useMemo<SessionRef | undefined>(() => selectedWorkspace === undefined || selectedSession === undefined
    ? undefined
    : { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id }, [selectedWorkspace?.id, selectedSession?.id]);
  const selectedSessionId = selectedRef?.sessionId;
  const selectedRefKey = selectedRef === undefined ? undefined : `${selectedRef.workspaceId}:${selectedRef.sessionId}`;
  const selectedComposerCommands = composerCommands !== undefined && composerCommands.sessionKey === selectedRefKey ? composerCommands.items : EMPTY_COMPOSER_COMMANDS;
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

  const recoverSessionConflict = useCallback(async (error: unknown): Promise<boolean> => {
    if (!isSessionConflict(error)) return false;
    setSessionNotice("会话状态已同步");
    await stream.refresh().catch(() => undefined);
    return true;
  }, [stream.refresh]);

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
    setCompactionRequest(undefined);
    setForkTarget(undefined);
    setForkPending(false);
    setSessionNotice(undefined);
  }, [selectedRef?.workspaceId, selectedRef?.sessionId]);

  useEffect(() => {
    if (sessionNotice === undefined) return;
    const timer = window.setTimeout(() => setSessionNotice(undefined), 4_000);
    return () => window.clearTimeout(timer);
  }, [sessionNotice]);

  useEffect(() => {
    if (selectedRef === undefined || selectedRefKey === undefined || stream.connection !== "live") return;
    const ref = selectedRef;
    const sessionKey = selectedRefKey;
    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const loadCommands = async () => {
      try {
        const commands = await api.commands(ref);
        if (disposed) return;
        attempt = 0;
        setComposerCommands({ sessionKey, items: commands });
      } catch {
        if (disposed) return;
        const delay = Math.min(COMMAND_RETRY_BASE_DELAY_MS * 2 ** attempt, COMMAND_RETRY_MAX_DELAY_MS);
        attempt += 1;
        retryTimer = window.setTimeout(() => { void loadCommands(); }, delay);
      }
    };
    void loadCommands();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [selectedRef, selectedRefKey, stream.connection]);

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
    const { workspaceId: pathWorkspaceId, sessionId: pathSessionId } = pathParams(location.pathname);
    if (workspaces.length === 0) {
      if (!loading) {
        if (workspaceId !== undefined) setWorkspaceId(undefined);
        if (sessionId !== undefined) setSessionId(undefined);
        // A stale URL (e.g. the last workspace was deleted) must not pin the app.
        if (pathWorkspaceId !== undefined || pathSessionId !== undefined) navigate("/projects", { replace: true });
      }
      return;
    }
    const workspace = workspaceId === undefined ? undefined : workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace === undefined) {
      const fallback = workspaces[0]?.id;
      if (fallback === undefined) return;
      if (pathWorkspaceId === undefined) {
        // Desktop: expanding a project in the sidebar does not navigate.
        setWorkspaceId(fallback);
      } else {
        navigate(`/sessions/${fallback}`, { replace: true });
      }
      return;
    }
    const sessions = sessionsByWorkspace[workspace.id];
    if (sessions === undefined) return;
    if (sessionId !== undefined && sessions.some((session) => session.id === sessionId)) return;
    if (window.innerWidth <= 760) {
      if (pathSessionId !== undefined && !sessions.some((session) => session.id === pathSessionId)) {
        // The chat URL carries a stale session id (deleted, other workspace).
        setSessionId(undefined);
        navigate(`/sessions/${workspace.id}`, { replace: true });
      } else if (pathSessionId === undefined && sessionId !== undefined && !sessions.some((session) => session.id === sessionId)) {
        // Mobile has no implicit first-session fallback; clear a stale pick.
        setSessionId(undefined);
      }
      return;
    }
    const first = sessions[0]?.id;
    if (first === undefined) return;
    if (pathWorkspaceId === workspace.id && pathSessionId !== undefined) {
      // The URL points at this workspace with a stale session id: fix the URL.
      navigate(`/chat/${workspace.id}/${first}`, { replace: true });
    } else {
      // Desktop sidebar expansion is UI-only; never navigate for it.
      setSessionId(first);
    }
  }, [workspaces, sessionsByWorkspace, workspaceId, sessionId, loading, location.pathname, navigate]);

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
    if (targetWorkspaceId === undefined || creatingSessionWorkspacesRef.current.has(targetWorkspaceId)) return;

    // An empty session is already a valid target for the next "new session"
    // action. Reuse it instead of accumulating blank sessions on repeated clicks.
    const existingEmpty = (sessionsByWorkspace[targetWorkspaceId] ?? []).find((session) => session.preview === null);
    if (existingEmpty !== undefined) {
      chooseSession(targetWorkspaceId, existingEmpty.id);
      return;
    }

    creatingSessionWorkspacesRef.current.add(targetWorkspaceId);
    try {
      const session = await api.createSession(targetWorkspaceId);
      setSessionsByWorkspace((current) => ({ ...current, [targetWorkspaceId]: mergeSession(current[targetWorkspaceId] ?? [], session) }));
      setExpandedWorkspaceIds((current) => ({ ...current, [targetWorkspaceId]: true }));
      setPageError(undefined);
      const target = `/chat/${targetWorkspaceId}/${session.id}`;
      if (!isMobile) {
        navigate(target, { replace: true });
      } else if (mobileSwitcherOpen) {
        pendingSessionSwitchRef.current = target;
        navigate(-1);
      } else if (mobilePage === "sessions") {
        // Mobile page-level move: session list -> chat.
        navigate(target);
      } else {
        navigate(target, { replace: true });
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法创建会话");
    } finally {
      creatingSessionWorkspacesRef.current.delete(targetWorkspaceId);
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
        // Back out of the chat/session page; the guard effect fixes up the rest.
        navigate("/projects", { replace: true });
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
        // Mobile: back to the session list; desktop: the guard picks the next session.
        navigate(`/sessions/${target.workspaceId}`, { replace: true });
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
    // !cmd / !!cmd：直接执行命令而不是发给模型（与 Pi TUI 一致）。
    if (attachments.length === 0) {
      const bash = parseBashCommand(text);
      if (bash !== undefined) return submitBash(bash.command, bash.excludeFromContext);
    }
    const clientRequestId = randomUUID();
    stream.addOptimisticUser(clientRequestId, text, attachments);
    try {
      await api.prompt(selectedRef, text, clientRequestId, attachments);
      setSessionsByWorkspace((current) => ({
        ...current,
        [selectedRef.workspaceId]: current[selectedRef.workspaceId]?.map((session) => session.id === selectedRef.sessionId
          ? { ...session, runState: "running", updatedAt: new Date().toISOString() }
          : session) ?? [],
      }));
      setPageError(undefined);
      return true;
    } catch (error) {
      stream.discardOptimisticUser(clientRequestId);
      if (await recoverSessionConflict(error)) return false;
      setPageError(error instanceof Error ? error.message : "无法发送消息");
      return false;
    }
  };

  const editUserMessage = async (message: Extract<import("../shared/protocol").TimelineItem, { kind: "message" }>, text: string): Promise<boolean> => {
    if (selectedRef === undefined || stream.transcript.status.runState !== "idle") return false;
    const clientRequestId = randomUUID();
    const images = message.images ?? [];
    stream.replaceUserMessage(message.id, clientRequestId, text, images);
    try {
      await api.editAndResend(selectedRef, message.id, text, clientRequestId, images);
      setSessionsByWorkspace((current) => ({
        ...current,
        [selectedRef.workspaceId]: current[selectedRef.workspaceId]?.map((session) => session.id === selectedRef.sessionId
          ? { ...session, runState: "running", updatedAt: new Date().toISOString() }
          : session) ?? [],
      }));
      setPageError(undefined);
      return true;
    } catch (error) {
      stream.discardOptimisticUser(clientRequestId);
      await stream.refresh().catch(() => undefined);
      if (await recoverSessionConflict(error)) return false;
      setPageError(error instanceof Error ? error.message : "无法重新生成消息");
      return false;
    }
  };

  const requestForkMessage = (message: Extract<import("../shared/protocol").TimelineItem, { kind: "message" }>) => {
    if (selectedRef === undefined || stream.transcript.status.runState !== "idle") return;
    setForkTarget(message);
  };

  const confirmForkMessage = async () => {
    const message = forkTarget;
    if (message === undefined || selectedRef === undefined || forkPending || stream.transcript.status.runState !== "idle") return;
    setForkPending(true);
    try {
      const session = await api.forkSession(selectedRef, message.id);
      setSessionsByWorkspace((current) => ({ ...current, [selectedRef.workspaceId]: mergeSession(current[selectedRef.workspaceId] ?? [], session) }));
      setForkTarget(undefined);
      setPageError(undefined);
      chooseSession(selectedRef.workspaceId, session.id);
    } catch (error) {
      if (!(await recoverSessionConflict(error))) setPageError(error instanceof Error ? error.message : "无法创建分支");
    } finally {
      setForkPending(false);
    }
  };

  const submitBash = async (command: string, excludeFromContext: boolean): Promise<boolean> => {
    if (selectedRef === undefined) return false;
    if (stream.transcript.status.runState !== "idle" || compactionPending) {
      setPageError("当前有任务正在执行，请先停止后再运行命令");
      return false;
    }
    try {
      await api.bash(selectedRef, command, excludeFromContext, randomUUID());
      setSessionsByWorkspace((current) => ({
        ...current,
        [selectedRef.workspaceId]: current[selectedRef.workspaceId]?.map((session) => session.id === selectedRef.sessionId
          ? { ...session, runState: "running", updatedAt: new Date().toISOString() }
          : session) ?? [],
      }));
      setPageError(undefined);
      return true;
    } catch (error) {
      if (await recoverSessionConflict(error)) return false;
      setPageError(error instanceof Error ? error.message : "无法执行命令");
      return false;
    }
  };

  const abort = async () => {
    if (selectedRef === undefined) return;
    try {
      await api.abort(selectedRef, stream.transcript.status.activeRun?.id);
    } catch (error) {
      if (await recoverSessionConflict(error)) return;
      setPageError(error instanceof Error ? error.message : "无法停止执行");
    }
  };

  // ESC 停止当前任务（模型运行 / !cmd 命令 / 压缩）。对话框、菜单和输入框
  // 自动补全打开时不拦截，让它们优先消费 Esc；在捕获阶段检查弹层，避免
  // 弹层自身的 Esc 处理器先一步把 DOM 移除导致误判。
  const abortRef = useRef(abort);
  const statusRef = useRef(stream.transcript.status);
  useEffect(() => { abortRef.current = abort; });
  useEffect(() => { statusRef.current = stream.transcript.status; });
  useEffect(() => {
    if (selectedRefKey === undefined) return;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [role="menu"], .extension-operation.pending, .composer-completions, .cm-tooltip-autocomplete, [data-radix-popper-content-wrapper]') !== null) return;
      if (statusRef.current.runState === "idle") return;
      event.preventDefault();
      event.stopPropagation();
      void abortRef.current();
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [selectedRefKey]);

  const compact = async () => {
    if (selectedRef === undefined || compactionPending) return;
    const baselineSeq = stream.transcript.seq;
    setCompactionPending(true);
    try {
      const accepted = await api.compact(selectedRef, undefined, randomUUID());
      setCompactionRequest({ runId: accepted.runId, baselineSeq });
      setPageError(undefined);
    } catch (error) {
      setCompactionPending(false);
      setCompactionRequest(undefined);
      if (await recoverSessionConflict(error)) return;
      setPageError(error instanceof Error ? error.message : "无法压缩上下文");
    }
  };

  useEffect(() => {
    if (!compactionPending || compactionRequest === undefined || selectedRefKey === undefined) return;
    const status = stream.transcript.status;
    const terminal = status.runState === "idle"
      && status.activeRun === undefined
      && status.compacting === undefined
      && stream.transcript.seq > compactionRequest.baselineSeq;
    if (!terminal) return;
    setCompactionPending(false);
    setCompactionRequest(undefined);
  }, [compactionPending, compactionRequest, selectedRefKey, stream.transcript.seq, stream.transcript.status.activeRun?.id, stream.transcript.status.runState]);

  const selectModel = async (model: ModelDescriptor) => {
    if (selectedRef === undefined || modelSwitchPending) return;
    setModelSwitchPending(true);
    try {
      await stream.selectModel(model);
      setPageError(undefined);
    } catch (error) {
      if (!(await recoverSessionConflict(error))) setPageError(error instanceof Error ? error.message : "无法切换模型");
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
      if (!(await recoverSessionConflict(error))) setPageError(error instanceof Error ? error.message : "无法切换思考等级");
    } finally {
      setThinkingLevelPending(false);
    }
  };

  const chooseSession = (nextWorkspaceId: string, nextSessionId: string) => {
    setExpandedWorkspaceIds((current) => ({ ...current, [nextWorkspaceId]: true }));
    const target = `/chat/${nextWorkspaceId}/${nextSessionId}`;
    if (!isMobile) {
      // Desktop: session selection never enters the history.
      navigate(target, { replace: true });
      return;
    }
    if (mobileSwitcherOpen) {
      // Pop the switcher overlay entry; the effect above replaces the
      // chat-entry entry with the new session.
      pendingSessionSwitchRef.current = target;
      navigate(-1);
      return;
    }
    if (mobilePage === "sessions") {
      // Mobile page-level move: session list -> chat.
      navigate(target);
      return;
    }
    navigate(target, { replace: true });
  };

  const openMobileProject = (workspace: Workspace) => {
    // Mobile page-level move: project list -> session list.
    navigate(`/sessions/${workspace.id}`);
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
      <Timeline items={stream.transcript.items} streamingMessageId={stream.transcript.streamingMessageId} hasMore={stream.transcript.hasMore} loadingMore={stream.loadingEarlier} onLoadMore={stream.loadEarlier} error={stream.error} notice={sessionNotice} onDismissNotice={() => setSessionNotice(undefined)} status={stream.transcript.status} onRetryCompaction={() => { void compact(); }} onEditUserMessage={stream.transcript.status.runState === "idle" ? editUserMessage : undefined} onForkMessage={stream.transcript.status.runState === "idle" ? requestForkMessage : undefined} onExtensionUiRespond={stream.respondExtensionUi} />
      <ExtensionPanels panels={stream.extensionPanels} />
      <PromptEditor key={selectedRef.sessionId} initialValue={selectedDraft} busy={stream.transcript.status.runState !== "idle" || compactionPending} commands={selectedComposerCommands} searchFiles={searchWorkspaceFiles} onDraftChange={updateSelectedDraft} onSubmit={submitPrompt} onStop={() => { void abort(); }} attachments={selectedAttachments} onAttachmentsChange={updateSelectedAttachments} onAttachmentError={reportAttachmentError} attachDisabled={stream.transcript.model.current?.vision === false} injectedText={stream.extensionPanels.editorText} extensionStatuses={stream.extensionPanels.statuses} controls={selectedSession === undefined ? undefined : <>
        <ModelSelector model={stream.transcript.model} disabled={stream.connection !== "live" || thinkingLevelPending || compactionPending} pending={modelSwitchPending} onSelect={(model) => { void selectModel(model); }} />
        <ThinkingSelector thinking={stream.transcript.thinking} disabled={stream.connection !== "live" || modelSwitchPending || compactionPending} pending={thinkingLevelPending} onSelect={(level) => { void selectThinkingLevel(level); }} />
        <ContextButton contextUsage={stream.transcript.contextUsage} disabled={stream.connection !== "live"} busy={stream.transcript.status.runState !== "idle" || compactionPending} onCompact={() => { void compact(); }} />
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
        {mobilePage === "projects" ? <MobileProjectsPage workspaces={workspaces} activeRunStateByWorkspace={activeRunStateByWorkspace} onAddProject={() => setWorkspaceDialogOpen(true)} onOpenProject={openMobileProject} onOpenProjectMenu={openMobileProjectMenu} /> : mobilePage === "sessions" ? <MobileSessionsPage workspace={selectedWorkspace} sessions={sessionsByWorkspace[workspaceId ?? ""] ?? []} onBack={() => navigate("/projects", { replace: true })} onCreateSession={() => { void createSession(workspaceId); }} onSelectSession={(id) => { if (workspaceId !== undefined) chooseSession(workspaceId, id); }} onOpenProjectMenu={openMobileProjectMenu} onOpenSessionMenu={(session) => { if (workspaceId !== undefined) openMobileSessionMenu(workspaceId, session); }} /> : <section className="mobile-chat-page">
          <header className="mobile-chat-header">
            <Button variant="ghost" size="icon" aria-label="返回会话列表" onClick={() => navigate(`/sessions/${workspaceId ?? ""}`, { replace: true })}><ArrowLeft size={19} /></Button>
            <button type="button" className="mobile-chat-session" onClick={() => navigate("?overlay=switcher")}>{selectedSession === undefined ? "新会话" : sessionLabel(selectedSession.name, selectedSession.preview)}<ChevronDown size={15} /></button>
            {selectedSession === undefined || selectedWorkspace === undefined ? null : <Button variant="ghost" size="icon" aria-label="当前会话操作" onClick={() => openMobileSessionMenu(selectedWorkspace.id, selectedSession)}><MoreVertical size={18} /></Button>}
          </header>
          <div className="mobile-chat-content">{renderChatContent()}</div>
          {mobileSwitcherOpen ? <MobileSessionSwitcher workspaces={workspaces} sessionsByWorkspace={sessionsByWorkspace} selectedWorkspaceId={workspaceId} selectedSessionId={sessionId} onClose={closeMobileSwitcher} onCreateSession={() => { void createSession(workspaceId); }} onSelectSession={(nextWorkspaceId, id) => chooseSession(nextWorkspaceId, id)} onOpenSessionMenu={openMobileSessionMenu} /> : null}
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

      <Dialog open={forkTarget !== undefined} onOpenChange={(open) => { if (!open && !forkPending) setForkTarget(undefined); }}>
        <DialogContent title="创建会话分支" description="将从选中的消息处复制上下文并创建一个新的会话。">
          <p className="delete-session-message">确定要从这条消息创建分支吗？原会话不会受到影响。</p>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setForkTarget(undefined)} disabled={forkPending}>取消</Button>
            <Button className="fork-confirm-button" onClick={() => { void confirmForkMessage(); }} disabled={forkPending}>{forkPending ? "正在创建…" : "创建分支"}</Button>
          </div>
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

function ExtensionPanels({ panels }: { panels: ExtensionPanelState }) {
  const widgets = Object.entries(panels.widgets);
  if (widgets.length === 0) return null;
  return <aside className="extension-panels" aria-label="扩展内容">
    <div className="extension-widget-track">
      {widgets.map(([key, widget]) => <section key={`widget:${key}`} className="extension-widget" title={key}>
        <pre className="extension-widget-body">{widget.lines.join("\n")}</pre>
      </section>)}
    </div>
  </aside>;
}
