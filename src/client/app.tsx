import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowLeft, Bell, ChevronDown, CircleAlert, FolderPlus, MoreVertical, Pencil, Plus, Puzzle, X } from "lucide-react";
import type { ComposerCommand, ImageAttachment, ModelDescriptor, SessionFileReference, SessionRef, SessionSummary, ThinkingLevel, Workspace, WorkspaceFile } from "../shared/protocol";
import { workspaceEventSchema } from "../shared/protocol";
import { api, isSessionConflict, notifyUnauthorized, socketUrl } from "./api";
import { PromptEditor } from "./components/prompt-editor";
import { ModelSelector } from "./components/model-selector";
import { ThinkingSelector } from "./components/thinking-selector";
import { Sidebar } from "./components/sidebar";
import { SessionContextMenu, type SessionContextMenuTarget } from "./components/session-context-menu";
import { ProjectContextMenu, type ProjectContextMenuTarget } from "./components/project-context-menu";
import { MobileActionSheet, type MobileActionTarget } from "./components/mobile-action-sheet";
import { MobileSessionSwitcher } from "./components/mobile-navigation";
import { SessionSearchDialog } from "./components/session-search-dialog";
import { Timeline } from "./components/timeline";
import { SettingsPage } from "./components/settings-page";
import { FileBrowser } from "./components/file-browser";
import type { ExtensionPanelState } from "./hooks/use-session-stream";
import { ContextButton } from "./components/context-button";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { WorkspaceDialog } from "./components/workspace-dialog";
import { Tooltip } from "./components/ui/tooltip";
import { installBodyPointerEventsGuard, installTouchFocusGuard } from "./lib/pointer-events";
import { isSessionInFocusWindow, randomUUID, parseBashCommand, reorderById, sessionCleanupTargets, sessionLabel, sortSessionSummaries } from "./lib/utils";
import { useSessionStream } from "./hooks/use-session-stream";
import { extensionToastDuration, extensionToastSourceLabel, mergeExtensionToast, type ExtensionToast, type ExtensionToastInput } from "./extension-notifications";

/** Extract the entity ids carried by the current hash route. */
function pathParams(pathname: string): { workspaceId?: string; sessionId?: string } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "chat" && parts.length >= 3) return { workspaceId: parts[1], sessionId: parts[2] };
  if (parts[0] === "sessions" && parts.length >= 2) return { workspaceId: parts[1] };
  if (parts[0] === "files" && parts.length >= 2) return { workspaceId: parts[1] };
  return {};
}

const COMMAND_RETRY_BASE_DELAY_MS = 750;
const COMMAND_RETRY_MAX_DELAY_MS = 10_000;
const EMPTY_COMPOSER_COMMANDS: ComposerCommand[] = [];
const SESSION_FOCUS_STORAGE_KEY = "jarvis.sessions.focus";
const SIDEBAR_WIDTH_STORAGE_KEY = "jarvis.sidebar.width";
const SIDEBAR_DEFAULT_WIDTH = 316;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 480;

interface SidebarResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialPath = pathParams(location.pathname);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // 会话列表基准快照可能晚于会话事件返回：快照在途时创建/删除的会话以事件流
  // 为准，应用快照时合并而非整体覆盖，避免新建的会话被陈旧快照抹掉。
  const deletedSessionsRef = useRef<Record<string, Set<string>>>({});
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() => initialPath.workspaceId ?? window.localStorage.getItem("jarvis.workspace") ?? undefined);
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, SessionSummary[]>>({});
  const [sessionId, setSessionId] = useState<string | undefined>(() => initialPath.sessionId ?? window.localStorage.getItem("jarvis.session") ?? undefined);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Record<string, boolean>>(() => readExpandedWorkspaces());
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth());
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarResizeRef = useRef<SidebarResizeState | undefined>(undefined);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const [focusMode, setFocusMode] = useState(readSessionFocusMode);
  const [focusNow, setFocusNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [assistantName, setAssistantName] = useState("Jarvis");
  const [pageError, setPageError] = useState<string | undefined>();
  const [globalExtensionToasts, setGlobalExtensionToasts] = useState<ExtensionToast[]>([]);
  const [sessionNotice, setSessionNotice] = useState<string | undefined>();
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ workspaceId: string; session: SessionSummary } | undefined>();
  const [renameValue, setRenameValue] = useState("");
  const [projectRenameTarget, setProjectRenameTarget] = useState<Workspace | undefined>();
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [projectRemoveTarget, setProjectRemoveTarget] = useState<Workspace | undefined>();
  const [projectRemovePending, setProjectRemovePending] = useState(false);
  const [sessionCleanupTarget, setSessionCleanupTarget] = useState<Workspace | undefined>();
  const [sessionCleanupPending, setSessionCleanupPending] = useState(false);
  const [workspaceOrderPending, setWorkspaceOrderPending] = useState(false);
  const workspaceOrderRequestRef = useRef<number | undefined>(undefined);
  const workspaceOrderSequenceRef = useRef(0);
  // Mobile uses the global session list as its home: #/projects and #/chat/:workspaceId/:sessionId.
  const isSettingsPage = location.pathname === "/settings";
  const isFilesPage = location.pathname.startsWith("/files");
  const mobilePage: "sessions" | "chat" | "files" | "settings" = isSettingsPage ? "settings" : isFilesPage ? "files" : location.pathname.startsWith("/chat") ? "chat" : "sessions";
  // Prevent repeated clicks from creating several unused sessions in the same workspace.
  const creatingSessionWorkspacesRef = useRef(new Set<string>());
  const previousSessionStatusRef = useRef<{ key?: string; runState?: string }>({});
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);

  const stopSidebarResize = useCallback((pointerId?: number) => {
    const resize = sidebarResizeRef.current;
    if (resize === undefined || (pointerId !== undefined && resize.pointerId !== pointerId)) return;
    sidebarResizeRef.current = undefined;
    persistSidebarWidth(sidebarWidthRef.current);
    setSidebarResizing(false);
    document.body.classList.remove("sidebar-resizing");
  }, []);

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === "touch" || sidebarResizeRef.current !== undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidthRef.current };
    setSidebarResizing(true);
    document.body.classList.add("sidebar-resizing");
  };

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = 16;
    const nextWidth = event.key === "ArrowLeft"
      ? clampSidebarWidth(sidebarWidthRef.current - step)
      : event.key === "ArrowRight"
        ? clampSidebarWidth(sidebarWidthRef.current + step)
        : event.key === "Home"
          ? SIDEBAR_MIN_WIDTH
          : event.key === "End"
            ? SIDEBAR_MAX_WIDTH
            : undefined;
    if (nextWidth === undefined) return;
    event.preventDefault();
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth((current) => current === nextWidth ? current : nextWidth);
    persistSidebarWidth(nextWidth);
  };

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const resize = sidebarResizeRef.current;
      if (resize === undefined || event.pointerId !== resize.pointerId) return;
      event.preventDefault();
      const nextWidth = clampSidebarWidth(resize.startWidth + event.clientX - resize.startX);
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth((current) => current === nextWidth ? current : nextWidth);
    };
    const onPointerUp = (event: globalThis.PointerEvent) => stopSidebarResize(event.pointerId);
    const onPointerCancel = (event: globalThis.PointerEvent) => stopSidebarResize(event.pointerId);
    const onWindowBlur = () => stopSidebarResize();
    const onVisibilityChange = () => stopSidebarResize();
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopSidebarResize();
    };
  }, [stopSidebarResize]);

  // The URL is the source of truth for the selected workspace/session.
  useEffect(() => {
    const { workspaceId: pathWorkspaceId, sessionId: pathSessionId } = pathParams(location.pathname);
    if (pathWorkspaceId !== undefined && pathWorkspaceId !== workspaceId) setWorkspaceId(pathWorkspaceId);
    if (pathSessionId !== undefined && pathSessionId !== sessionId) setSessionId(pathSessionId);
  }, [location.pathname, workspaceId, sessionId]);

  // First visit (empty hash): mobile lands on the global session list; desktop restores its previous workspace.
  useEffect(() => {
    if (location.pathname !== "/") return;
    if (window.innerWidth <= 760) {
      navigate("/projects", { replace: true });
      return;
    }
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
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [draftNonce, setDraftNonce] = useState(0);
  const [attachmentsBySession, setAttachmentsBySession] = useState<Record<string, ImageAttachment[]>>({});
  const [forkTarget, setForkTarget] = useState<Extract<import("../shared/protocol").TimelineItem, { kind: "message" }>>();
  const [forkPending, setForkPending] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<SessionContextMenuTarget | undefined>();
  const [projectMenu, setProjectMenu] = useState<ProjectContextMenuTarget | undefined>();
  const [mobileActionTarget, setMobileActionTarget] = useState<MobileActionTarget | undefined>();
  const [userNavigatorOpen, setUserNavigatorOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [composerCommands, setComposerCommands] = useState<{ sessionKey: string; items: ComposerCommand[] } | undefined>();
  // 移动端：非底部输入框聚焦时，输入栏折叠为紧凑按钮（见 PromptEditor）。
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const composerFocusRef = useRef<(() => void) | undefined>(undefined);
  // 桌面端：新建会话（含复用空会话、创建分支）后自动聚焦输入框，PromptEditor 挂载时消费。
  const [newSessionFocusId, setNewSessionFocusId] = useState<string | undefined>();

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const selectedSession = selectedWorkspace === undefined
    ? undefined
    : (sessionsByWorkspace[selectedWorkspace.id] ?? []).find((session) => session.id === sessionId);
  const selectedRef = useMemo<SessionRef | undefined>(() => selectedWorkspace === undefined || selectedSession === undefined
    ? undefined
    : { workspaceId: selectedWorkspace.id, sessionId: selectedSession.id }, [selectedWorkspace?.id, selectedSession?.id]);
  const selectedSessionId = selectedRef?.sessionId;
  const selectedRefKey = selectedRef === undefined ? undefined : `${selectedRef.workspaceId}:${selectedRef.sessionId}`;
  const visibleSessionsByWorkspace = useMemo<Record<string, SessionSummary[]>>(() => {
    if (!focusMode) return sessionsByWorkspace;
    return Object.fromEntries(Object.entries(sessionsByWorkspace).map(([id, sessions]) => [id, sessions.filter((session) => isSessionInFocusWindow(session, focusNow))]));
  }, [focusMode, focusNow, sessionsByWorkspace]);
  const selectedComposerCommands = composerCommands !== undefined && composerCommands.sessionKey === selectedRefKey ? composerCommands.items : EMPTY_COMPOSER_COMMANDS;
  const selectedDraft = selectedSessionId === undefined ? "" : drafts[selectedSessionId] ?? "";
  const updateDraft = useCallback((id: string, value: string, external = false) => {
    if (draftsRef.current[id] === value) return;
    setDrafts((current) => current[id] === value ? current : { ...current, [id]: value });
    if (external) setDraftNonce((nonce) => nonce + 1);
  }, []);
  const updateSelectedDraft = useCallback((value: string, external = false) => {
    if (selectedSessionId !== undefined) updateDraft(selectedSessionId, value, external);
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
  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_FOCUS_STORAGE_KEY, String(focusMode));
    } catch {
      // The current view still works when browser storage is unavailable.
    }
  }, [focusMode]);
  useEffect(() => {
    if (!focusMode) return;
    setFocusNow(Date.now());
    const timer = window.setInterval(() => setFocusNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [focusMode]);
  // The stream owns the authoritative runtime model snapshot and realtime changes.
  const stream = useSessionStream(isSettingsPage || isFilesPage ? undefined : selectedRef, assistantName, selectedSession?.name ?? undefined);

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
  useEffect(() => {
    const restoreBodyPointerEvents = installBodyPointerEventsGuard();
    const removeTouchFocusGuard = installTouchFocusGuard();
    return () => {
      restoreBodyPointerEvents();
      removeTouchFocusGuard();
    };
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

  // 移动端：其他输入框（历史消息编辑、扩展输入等）聚焦时把底部输入栏折叠为
  // 紧凑按钮，避免键盘顶起后两个输入框竞争垂直空间；失焦或回到输入栏时恢复。
  useEffect(() => {
    if (!isMobile) {
      setComposerCollapsed(false);
      return;
    }
    const isEditable = (element: Element | null): boolean =>
      element !== null && (element instanceof HTMLElement && element.isContentEditable || element.matches("input, textarea"));
    const inComposer = (element: Element | null): boolean =>
      element !== null && element.closest(".composer") !== null;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !isEditable(target) || inComposer(target)) return;
      // 仅当聊天页输入栏存在时折叠（会话列表页没有输入栏）。
      if (document.querySelector(".composer") === null) return;
      setComposerCollapsed(true);
    };
    const onFocusOut = () => {
      const active = document.activeElement;
      if (!isEditable(active) || inComposer(active)) setComposerCollapsed(false);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [isMobile]);

  /** 折叠按钮：收起当前输入焦点，展开输入栏并聚焦编辑器。 */
  const expandComposer = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".composer") === null) active.blur();
    setComposerCollapsed(false);
    // 等展开态渲染完成（编辑器脱离 display:none）后再聚焦，rAF 保证已提交。
    window.requestAnimationFrame(() => composerFocusRef.current?.());
  }, []);

  useEffect(() => {
    setModelSwitchPending(false);
    setThinkingLevelPending(false);
    setCompactionPending(false);
    setCompactionRequest(undefined);
    setForkTarget(undefined);
    setForkPending(false);
    setSessionNotice(undefined);
    setComposerCollapsed(false);
    setNewSessionFocusId(undefined);
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

  const reorderWorkspaces = useCallback((sourceId: string, targetId: string, placeAfter: boolean): void => {
    if (workspaceOrderRequestRef.current !== undefined) return;
    const previous = workspaces;
    const next = reorderById(previous, sourceId, targetId, placeAfter);
    if (next === undefined) return;
    const requestId = ++workspaceOrderSequenceRef.current;
    workspaceOrderRequestRef.current = requestId;
    setWorkspaceOrderPending(true);
    setWorkspaces(next);
    void api.reorderWorkspaces(next.map((workspace) => workspace.id)).then((saved) => {
      if (workspaceOrderRequestRef.current !== requestId) return;
      setWorkspaces(saved);
    }).catch((error: unknown) => {
      if (workspaceOrderRequestRef.current !== requestId) return;
      setWorkspaces((current) => current.map((workspace) => workspace.id).join() === next.map((workspace) => workspace.id).join() ? previous : current);
      setPageError(error instanceof Error ? error.message : "工作区排序失败");
    }).finally(() => {
      if (workspaceOrderRequestRef.current !== requestId) return;
      workspaceOrderRequestRef.current = undefined;
      setWorkspaceOrderPending(false);
    });
  }, [workspaces]);

  const loadProjectSessions = useCallback(async (projects: Workspace[]): Promise<Record<string, SessionSummary[]>> => {
    const entries = await Promise.all(projects.map(async (workspace) => [workspace.id, await api.listSessions(workspace.id)] as const));
    return Object.fromEntries(entries);
  }, []);

  // 移动端全文搜索：跨项目并行查询，服务端对会话正文做全文匹配。
  const searchSessions = useCallback(async (query: string): Promise<Record<string, SessionSummary[]>> => {
    const entries = await Promise.all(workspaces.map(async (workspace) => [workspace.id, await api.listSessions(workspace.id, query)] as const));
    return Object.fromEntries(entries);
  }, [workspaces]);

  useEffect(() => {
    void Promise.all([loadWorkspaces(), api.settings().then((settings) => { setAssistantName(settings.assistantName); })]).catch((error: unknown) => setPageError(error instanceof Error ? error.message : "无法加载应用设置")).finally(() => setLoading(false));
  }, [loadWorkspaces]);

  useEffect(() => {
    if (workspaces.length === 0) {
      setSessionsByWorkspace({});
      return;
    }
    let disposed = false;
    void loadProjectSessions(workspaces).then((sessions) => {
      if (disposed) return;
      setSessionsByWorkspace((current) => {
        const next: Record<string, SessionSummary[]> = {};
        for (const workspace of workspaces) {
          const byId = new Map<string, SessionSummary>();
          // 先保留当前列表（含事件流新增的会话，如刚创建的新会话）。
          for (const session of current[workspace.id] ?? []) byId.set(session.id, session);
          // 再补上快照里缺失的会话，但跳过事件流已删除的。
          const deleted = deletedSessionsRef.current[workspace.id];
          for (const session of sessions[workspace.id] ?? []) {
            if (!byId.has(session.id) && deleted?.has(session.id) !== true) byId.set(session.id, session);
          }
          next[workspace.id] = sortSessionSummaries([...byId.values()]);
        }
        return next;
      });
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
        navigate(isMobile ? "/projects" : `/sessions/${fallback}`, { replace: true });
      }
      return;
    }
    if (isFilesPage) return;
    const sessions = sessionsByWorkspace[workspace.id];
    if (sessions === undefined) return;
    if (sessionId !== undefined && sessions.some((session) => session.id === sessionId)) return;
    if (window.innerWidth <= 760) {
      if (pathSessionId !== undefined && !sessions.some((session) => session.id === pathSessionId)) {
        // The chat URL carries a stale session id (deleted, other workspace).
        setSessionId(undefined);
        navigate("/projects", { replace: true });
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
  }, [workspaces, sessionsByWorkspace, workspaceId, sessionId, loading, location.pathname, navigate, isFilesPage]);

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
    if (globalExtensionToasts.length === 0) return;
    const timers = globalExtensionToasts.map((toast) => window.setTimeout(() => {
      setGlobalExtensionToasts((current) => current.filter((candidate) => candidate.id !== toast.id));
    }, extensionToastDuration(toast.tone)));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [globalExtensionToasts]);

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
            if (workspaceEvent.type === "extension.notify") {
              const { notification } = workspaceEvent;
              const tone: "info" | "warning" | "error" = notification.notifyType === "warning" || notification.notifyType === "error" ? notification.notifyType : "info";
              const incoming: ExtensionToastInput = { id: notification.id, workspaceId: workspaceEvent.workspaceId, sessionId: notification.sessionId, message: notification.message, tone };
              setGlobalExtensionToasts((current) => {
                const merged = mergeExtensionToast(current[0], incoming);
                return merged === current[0] ? current : [merged];
              });
              return;
            }
            if (workspaceEvent.type === "session.deleted") {
              (deletedSessionsRef.current[workspace.id] ??= new Set()).add(workspaceEvent.sessionId);
              setSessionsByWorkspace((current) => {
                const sessions = current[workspace.id] ?? [];
                const next = withoutSession(sessions, workspaceEvent.sessionId);
                return next === sessions ? current : { ...current, [workspace.id]: next };
              });
              setDrafts((current) => withoutDraft(current, workspaceEvent.sessionId));
              setSessionMenu((current) => current?.workspaceId === workspace.id && current.session.id === workspaceEvent.sessionId ? undefined : current);
              return;
            }
            setSessionsByWorkspace((current) => ({ ...current, [workspace.id]: mergeSession(current[workspace.id] ?? [], workspaceEvent.session) }));
          } catch {
            // A malformed workspace event does not invalidate the active view.
          }
        });
        connection.addEventListener("close", (event) => {
          if (disposed || socket !== connection) return;
          // 4401：服务端因未登录拒绝，AuthGate 会切回登录页，不再重连。
          if (event.code === 4401) {
            notifyUnauthorized();
            return;
          }
          reconnect = window.setTimeout(connect, 1_500);
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
    if (selectedRef === undefined || selectedRefKey === undefined) return;
    let disposed = false;
    void api.markSessionViewed(selectedRef).then((session) => {
      if (disposed) return;
      setSessionsByWorkspace((current) => ({ ...current, [selectedRef.workspaceId]: mergeSession(current[selectedRef.workspaceId] ?? [], session) }));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [selectedRefKey]);

  useEffect(() => {
    setUserNavigatorOpen(false);
  }, [selectedRefKey]);

  useEffect(() => {
    const status = stream.transcript.status;
    const key = selectedRefKey;
    const previous = previousSessionStatusRef.current;
    previousSessionStatusRef.current = key === undefined ? {} : { key, runState: status.runState };
    if (status.sessionId === "" || selectedRef === undefined || key === undefined) return;
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
    // Only clear completed/unread attention on an actual transition to idle.
    // session.updated itself changes the status object and must not re-enter this loop.
    if (status.runState !== "idle" || previous.key !== key || previous.runState === undefined || previous.runState === "idle") return;
    const ref = selectedRef;
    let disposed = false;
    void api.markSessionViewed(ref).then((session) => {
      if (disposed) return;
      setSessionsByWorkspace((current) => ({ ...current, [ref.workspaceId]: mergeSession(current[ref.workspaceId] ?? [], session) }));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [stream.transcript.status, selectedRef, selectedRefKey]);

  const createSession = async (targetWorkspaceId = workspaceId) => {
    if (targetWorkspaceId === undefined || creatingSessionWorkspacesRef.current.has(targetWorkspaceId)) return;

    // An empty session is already a valid target for the next "new session"
    // action. Reuse it instead of accumulating blank sessions on repeated clicks.
    const existingEmpty = (sessionsByWorkspace[targetWorkspaceId] ?? []).find((session) => session.preview === null);
    if (existingEmpty !== undefined) {
      if (selectedRefKey === `${targetWorkspaceId}:${existingEmpty.id}`) {
        // 已在该空会话上：无需导航，直接聚焦。
        composerFocusRef.current?.();
      } else {
        setNewSessionFocusId(existingEmpty.id);
        chooseSession(targetWorkspaceId, existingEmpty.id);
      }
      return;
    }

    creatingSessionWorkspacesRef.current.add(targetWorkspaceId);
    try {
      const session = await api.createSession(targetWorkspaceId);
      setSessionsByWorkspace((current) => ({ ...current, [targetWorkspaceId]: mergeSession(current[targetWorkspaceId] ?? [], session) }));
      setExpandedWorkspaceIds((current) => ({ ...current, [targetWorkspaceId]: true }));
      setPageError(undefined);
      setNewSessionFocusId(session.id);
      const target = `/chat/${targetWorkspaceId}/${session.id}`;
      if (!isMobile) {
        navigate(target, { replace: true });
      } else if (mobilePage === "sessions") {
        // Mobile page-level move: global session list -> chat.
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

  const removeWorkspaceFromSettings = async (target: Workspace) => {
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
    }
  };

  const deleteSession = async (target: { workspaceId: string; session: SessionSummary }) => {
    if (deletePending) return;
    setDeletePending(true);
    try {
      await api.removeSession({ workspaceId: target.workspaceId, sessionId: target.session.id });
      setSessionsByWorkspace((current) => ({ ...current, [target.workspaceId]: withoutSession(current[target.workspaceId] ?? [], target.session.id) }));
      setDrafts((current) => withoutDraft(current, target.session.id));
      if (workspaceId === target.workspaceId && sessionId === target.session.id) {
        setSessionId(undefined);
        // Mobile: back to the session list; desktop: the guard picks the next session.
        navigate(isMobile ? "/projects" : `/sessions/${target.workspaceId}`, { replace: true });
      }
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法删除会话");
    } finally {
      setDeletePending(false);
    }
  };

  const keepSessionIdFor = (projectId: string): string | undefined => selectedRef?.workspaceId === projectId ? selectedRef.sessionId : undefined;

  const openSessionCleanup = (workspace: Workspace) => {
    if (sessionCleanupTargets(sessionsByWorkspace[workspace.id] ?? [], keepSessionIdFor(workspace.id)).length === 0) return;
    setSessionCleanupTarget(workspace);
  };

  const cleanupProjectSessions = async () => {
    const target = sessionCleanupTarget;
    if (target === undefined || sessionCleanupPending) return;
    setSessionCleanupPending(true);
    const keepSessionId = keepSessionIdFor(target.id);
    try {
      const result = await api.cleanupSessions(target.id, keepSessionId);
      setSessionsByWorkspace((current) => {
        let sessions = current[target.id] ?? [];
        for (const id of result.removed) sessions = withoutSession(sessions, id);
        return sessions === (current[target.id] ?? []) ? current : { ...current, [target.id]: sessions };
      });
      setDrafts((current) => {
        let next = current;
        for (const id of result.removed) next = withoutDraft(next, id);
        return next;
      });
      setSessionCleanupTarget(undefined);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法清理会话");
    } finally {
      setSessionCleanupPending(false);
    }
  };

  /** 会话级分支：从该会话最新一条 user 消息处复制上下文。 */
  const forkSessionFromTarget = async (target: { workspaceId: string; sessionId: string }) => {
    try {
      const session = await api.forkSession(target);
      setSessionsByWorkspace((current) => ({ ...current, [target.workspaceId]: mergeSession(current[target.workspaceId] ?? [], session) }));
      setPageError(undefined);
      setNewSessionFocusId(session.id);
      chooseSession(target.workspaceId, session.id);
    } catch (error) {
      if (!(await recoverSessionConflict(error))) setPageError(error instanceof Error ? error.message : "无法创建分支");
    }
  };

  const searchWorkspaceFiles = useCallback(async (query: string): Promise<WorkspaceFile[]> => {
    if (selectedRef === undefined) return [];
    return api.searchFiles(selectedRef.workspaceId, query);
  }, [selectedRef]);

  const searchSessionFiles = useCallback(async (query: string): Promise<SessionFileReference[]> => {
    if (selectedRef === undefined) return [];
    return (await api.searchSessionFiles(selectedRef.workspaceId, query)).filter((session) => session.id !== selectedRef.sessionId);
  }, [selectedRef]);

  // Stable reference so PromptEditor's paste extension never changes identity
  // (a changing extensions array makes useCodeMirror reconfigure the editor).
  const reportAttachmentError = useCallback((message: string) => { setPageError(message); }, []);

  const submitPrompt = async (text: string, attachments: ImageAttachment[], behavior?: "steer" | "followUp"): Promise<boolean> => {
    if (selectedRef === undefined) return false;
    // !cmd / !!cmd：直接执行命令而不是发给模型（与 Pi TUI 一致），
    // busy 时也会走 bash 路径（会话忙则明确报错，不误排成消息）。
    if (attachments.length === 0) {
      const bash = parseBashCommand(text);
      if (bash !== undefined) return submitBash(bash.command, bash.excludeFromContext);
    }
    const clientRequestId = randomUUID();
    stream.addOptimisticUser(clientRequestId, text, attachments);
    try {
      const result = await api.prompt(selectedRef, text, clientRequestId, attachments, behavior);
      if (result.queued === true) {
        // 会话忙：消息已进入排队（steering/follow-up），由 queue.updated
        // 事件驱动排队条展示；乐观消息等投递后由 message.created 落定。
        stream.discardOptimisticUser(clientRequestId);
        setPageError(undefined);
        return true;
      }
      setSessionsByWorkspace((current) => ({
        ...current,
        [selectedRef.workspaceId]: markSessionUserActivity(current[selectedRef.workspaceId] ?? [], selectedRef.sessionId),
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

  /** 全部取回排队消息并合并进当前草稿（对齐 Pi TUI 的 Alt+Up）。 */
  const dequeueAll = useCallback(async (): Promise<void> => {
    if (selectedRef === undefined) return;
    try {
      const { steering, followUp } = await api.dequeueQueue(selectedRef);
      const texts = [...steering, ...followUp].map((message) => message.text);
      if (texts.length === 0) return;
      updateSelectedDraft([texts.join("\n\n"), selectedDraft].filter((value) => value.trim() !== "").join("\n\n"), true);
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法取回排队消息");
    }
  }, [selectedRef, selectedDraft, updateSelectedDraft]);

  /** 单条排队消息：移除；restore=true 时文本合并回草稿（取回）。 */
  const removeQueuedMessage = useCallback(async (messageId: string, restore: boolean): Promise<void> => {
    if (selectedRef === undefined) return;
    try {
      const { removed } = await api.removeQueued(selectedRef, messageId);
      if (restore && removed !== undefined) {
        updateSelectedDraft([removed.text, selectedDraft].filter((value) => value.trim() !== "").join("\n\n"), true);
      }
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法移除该排队消息");
    }
  }, [selectedRef, selectedDraft, updateSelectedDraft]);

  /** 切换排队消息的投递方式：后续 ↔ 紧急（插队）。 */
  const toggleQueuedKind = useCallback(async (messageId: string): Promise<void> => {
    if (selectedRef === undefined) return;
    const message = [...stream.transcript.queue.steering, ...stream.transcript.queue.followUp].find((item) => item.id === messageId);
    if (message === undefined) return;
    try {
      await api.setQueuedKind(selectedRef, messageId, message.kind === "steer" ? "followUp" : "steer");
      setPageError(undefined);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法切换排队方式");
    }
  }, [selectedRef, stream.transcript.queue]);

  const editUserMessage = async (message: Extract<import("../shared/protocol").TimelineItem, { kind: "message" }>, text: string): Promise<boolean> => {
    if (selectedRef === undefined || stream.transcript.status.runState !== "idle") return false;
    const clientRequestId = randomUUID();
    const images = message.images ?? [];
    stream.replaceUserMessage(message.id, clientRequestId, text, images);
    try {
      await api.editAndResend(selectedRef, message.id, text, clientRequestId, images);
      setSessionsByWorkspace((current) => ({
        ...current,
        [selectedRef.workspaceId]: markSessionUserActivity(current[selectedRef.workspaceId] ?? [], selectedRef.sessionId),
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
    if (selectedRef === undefined) return;
    setForkTarget(message);
  };

  const confirmForkMessage = async () => {
    const message = forkTarget;
    if (message === undefined || selectedRef === undefined || forkPending) return;
    setForkPending(true);
    try {
      const session = await api.forkSession(selectedRef, message.id);
      setSessionsByWorkspace((current) => ({ ...current, [selectedRef.workspaceId]: mergeSession(current[selectedRef.workspaceId] ?? [], session) }));
      setForkTarget(undefined);
      setPageError(undefined);
      setNewSessionFocusId(session.id);
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
        [selectedRef.workspaceId]: markSessionUserActivity(current[selectedRef.workspaceId] ?? [], selectedRef.sessionId),
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
      const result = await api.abort(selectedRef, stream.transcript.status.activeRun?.id);
      // 停止时取回排队消息（对齐 Pi TUI 的 Escape 行为）。
      const dequeued = result.dequeued;
      if (dequeued !== undefined && (dequeued.steering.length > 0 || dequeued.followUp.length > 0)) {
        const texts = [...dequeued.steering, ...dequeued.followUp].map((message) => message.text);
        updateSelectedDraft([...texts, selectedDraft].filter((value) => value.trim() !== "").join("\n\n"), true);
      }
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
    if (mobilePage === "sessions") {
      // Mobile page-level move: session list -> chat.
      navigate(target);
      return;
    }
    navigate(target, { replace: true });
  };

  const openMobileSessionMenu = (workspaceId: string, session: SessionSummary) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (workspace !== undefined) setMobileActionTarget({ kind: "session", workspaceId, workspaceLabel: workspace.label, session });
  };

  const sidebar = <Sidebar
    workspaces={workspaces}
    sessionsByWorkspace={visibleSessionsByWorkspace}
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
    onLongPressSession={openMobileSessionMenu}
    onOpenSearch={() => setSearchOpen(true)}
    focusMode={focusMode}
    onToggleFocusMode={() => setFocusMode((current) => !current)}
    assistantName={assistantName}
    onOpenSettings={() => navigate("/settings")}
    onOpenFiles={() => navigate(`/files/${workspaceId ?? workspaces[0]?.id ?? ""}`)}
    onReorderWorkspaces={reorderWorkspaces}
    workspaceOrderPending={workspaceOrderPending}
  />;

  if (loading) return <main className="app-loading">正在打开工作区…</main>;

  const renderChatContent = () => <>
    {pageError === undefined ? null : <div className="page-error" role="alert"><span>{pageError}</span><button type="button" aria-label="关闭错误提示" onClick={() => setPageError(undefined)}>关闭</button></div>}
    {selectedRef === undefined ? <section className="empty-workspace"><FolderPlus size={28} /><h2>未选择会话</h2><Button onClick={() => { void createSession(); }} disabled={workspaceId === undefined}><Plus size={16} /> 新建会话</Button></section> : <>
      <Timeline key={selectedRefKey} items={stream.transcript.items} streamingMessageId={stream.transcript.streamingMessageId} hasMore={stream.transcript.hasMore} loadingMore={stream.loadingEarlier} onLoadMore={stream.loadEarlier} error={stream.error} notice={sessionNotice} onDismissNotice={() => setSessionNotice(undefined)} status={stream.transcript.status} onRetryCompaction={() => { void compact(); }} onEditUserMessage={stream.transcript.status.runState === "idle" ? editUserMessage : undefined} onForkMessage={requestForkMessage} onExtensionUiRespond={stream.respondExtensionUi} workspaceCwd={selectedWorkspace?.cwd} navigatorOpen={userNavigatorOpen} onNavigatorOpenChange={setUserNavigatorOpen} />
      <ExtensionPanels panels={stream.extensionPanels} />
      <PromptEditor key={selectedRef.sessionId} initialValue={selectedDraft} draftNonce={draftNonce} busy={stream.transcript.status.runState !== "idle" || compactionPending} commands={selectedComposerCommands} searchFiles={searchWorkspaceFiles} searchSessionFiles={searchSessionFiles} onDraftChange={updateSelectedDraft} onSubmit={submitPrompt} onStop={() => { void abort(); }} attachments={selectedAttachments} onAttachmentsChange={updateSelectedAttachments} onAttachmentError={reportAttachmentError} attachDisabled={stream.transcript.model.current?.vision === false} injectedText={stream.extensionPanels.editorText} queue={stream.transcript.queue} onDequeueAll={() => { void dequeueAll(); }} onRemoveQueued={removeQueuedMessage} onToggleKind={toggleQueuedKind} collapsed={isMobile && composerCollapsed} onCollapsedClick={expandComposer} focusRequestRef={composerFocusRef} autoFocus={newSessionFocusId === selectedSessionId} onAutoFocusConsumed={() => setNewSessionFocusId(undefined)} controls={selectedSession === undefined ? undefined : <>
        <ModelSelector model={stream.transcript.model} disabled={stream.connection !== "live" || thinkingLevelPending || compactionPending} pending={modelSwitchPending} onSelect={(model) => { void selectModel(model); }} />
        <ThinkingSelector thinking={stream.transcript.thinking} disabled={stream.connection !== "live" || modelSwitchPending || compactionPending} pending={thinkingLevelPending} onSelect={(level) => { void selectThinkingLevel(level); }} />
        <ContextButton contextUsage={stream.transcript.contextUsage} disabled={stream.connection !== "live"} busy={stream.transcript.status.runState !== "idle" || compactionPending} onCompact={() => { void compact(); }} />
      </>} />
    </>}
  </>;

  return (
    <main className="app-shell" style={{ gridTemplateColumns: `${String(sidebarWidth)}px minmax(0, 1fr)` }}>
      <ExtensionToasts toasts={globalExtensionToasts} sessionsByWorkspace={sessionsByWorkspace} onOpenSession={(workspaceId, sessionId) => navigate(`/chat/${workspaceId}/${sessionId}`)} onDismiss={(id) => setGlobalExtensionToasts((current) => current.filter((toast) => toast.id !== id))} />
      <div className={`desktop-sidebar${sidebarResizing ? " sidebar-resizing" : ""}`}>
        {sidebar}
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="调整侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onKeyDown={resizeSidebarWithKeyboard}
          onLostPointerCapture={() => stopSidebarResize()}
          onPointerDown={startSidebarResize}
        />
      </div>
      {!isMobile ? <section className={isSettingsPage ? "main-pane settings-main-pane" : isFilesPage ? "main-pane files-main-pane" : "main-pane"}>
        {isSettingsPage || isFilesPage ? null : <header className="chat-header">
          <div className="chat-title-wrap">
            <div className="chat-title">
              <div><h1>{selectedSession === undefined ? "新会话" : sessionLabel(selectedSession.name, selectedSession.preview)}</h1>{selectedSession === undefined || selectedWorkspace === undefined ? null : <Tooltip label="重命名会话"><Button variant="ghost" size="icon" aria-label="重命名会话" onClick={() => { setRenameTarget({ workspaceId: selectedWorkspace.id, session: selectedSession }); setRenameValue(selectedSession.name ?? sessionLabel(selectedSession.name, selectedSession.preview)); }}><Pencil size={15} /></Button></Tooltip>}</div>
            </div>
          </div>
                  </header>}
        {isSettingsPage ? <SettingsPage assistantName={assistantName} onAssistantNameChange={setAssistantName} workspaces={workspaces} onWorkspacesChange={setWorkspaces} onAddWorkspace={addWorkspace} onRemoveWorkspace={removeWorkspaceFromSettings} onBack={() => navigate("/projects", { replace: true })} /> : isFilesPage ? <FileBrowser workspaces={workspaces} workspaceId={workspaceId} onWorkspaceChange={(id) => navigate(`/files/${id}`, { replace: true })} onBack={() => navigate("/projects", { replace: true })} /> : renderChatContent()}
      </section> : null}
      {isMobile ? <div className="mobile-app">
        {mobilePage === "settings" ? <SettingsPage assistantName={assistantName} onAssistantNameChange={setAssistantName} workspaces={workspaces} onWorkspacesChange={setWorkspaces} onAddWorkspace={addWorkspace} onRemoveWorkspace={removeWorkspaceFromSettings} onBack={() => navigate("/projects", { replace: true })} /> : mobilePage === "files" ? <FileBrowser workspaces={workspaces} workspaceId={workspaceId} onWorkspaceChange={(id) => navigate(`/files/${id}`, { replace: true })} onBack={() => navigate("/projects", { replace: true })} /> : mobilePage === "sessions" ? <MobileSessionSwitcher workspaces={workspaces} sessionsByWorkspace={visibleSessionsByWorkspace} selectedSessionId={sessionId} onCreateSession={(targetWorkspaceId) => { void createSession(targetWorkspaceId); }} onSelectSession={chooseSession} onOpenSessionMenu={openMobileSessionMenu} onRenameSession={(targetWorkspaceId, session) => { setRenameTarget({ workspaceId: targetWorkspaceId, session }); setRenameValue(session.name ?? sessionLabel(session.name, session.preview)); }} onForkSession={(targetWorkspaceId, session) => { void forkSessionFromTarget({ workspaceId: targetWorkspaceId, sessionId: session.id }); }} onDeleteSession={(targetWorkspaceId, session) => { void deleteSession({ workspaceId: targetWorkspaceId, session }); }} onOpenProjectMenu={(workspace) => setMobileActionTarget({ kind: "project", workspace })} onOpenSearch={() => setSearchOpen(true)} focusMode={focusMode} onToggleFocusMode={() => setFocusMode((current) => !current)} onAddProject={() => { setWorkspaceDialogOpen(true); }} assistantName={assistantName} onOpenSettings={() => navigate("/settings")} onOpenFiles={() => navigate(`/files/${workspaceId ?? workspaces[0]?.id ?? ""}`)} /> : <section className="mobile-chat-page">
          <header className="mobile-chat-header">
            <Button variant="ghost" size="icon" aria-label="返回会话列表" onClick={() => navigate("/projects", { replace: true })}><ArrowLeft size={16} /></Button>
            <button type="button" className="mobile-chat-session" aria-haspopup="dialog" aria-expanded={userNavigatorOpen} onClick={() => setUserNavigatorOpen(true)}><span>{selectedSession === undefined ? "新会话" : sessionLabel(selectedSession.name, selectedSession.preview)}</span><ChevronDown size={14} /></button>
            {selectedSession === undefined || selectedWorkspace === undefined ? null : <Button variant="ghost" size="icon" aria-label="当前会话操作" onClick={() => openMobileSessionMenu(selectedWorkspace.id, selectedSession)}><MoreVertical size={16} /></Button>}
          </header>
          <div className="mobile-chat-content">{renderChatContent()}</div>
        </section>}
      </div> : null}

      {sessionMenu === undefined ? null : <SessionContextMenu target={sessionMenu} onClose={closeSessionMenu} onFork={(target) => {
        setSessionMenu(undefined);
        void forkSessionFromTarget({ workspaceId: target.workspaceId, sessionId: target.session.id });
      }} onRename={(target) => {
        setSessionMenu(undefined);
        setRenameTarget({ workspaceId: target.workspaceId, session: target.session });
        setRenameValue(target.session.name ?? sessionLabel(target.session.name, target.session.preview));
      }} onDelete={(target) => {
        setSessionMenu(undefined);
        void deleteSession({ workspaceId: target.workspaceId, session: target.session });
      }} />}
      {projectMenu === undefined ? null : <ProjectContextMenu target={projectMenu} onClose={closeProjectMenu} onCreateSession={(workspace) => {
        setProjectMenu(undefined);
        void createSession(workspace.id);
      }} onCleanupSessions={(workspace) => {
        setProjectMenu(undefined);
        openSessionCleanup(workspace);
      }} onRename={(workspace) => {
        setProjectMenu(undefined);
        setProjectRenameTarget(workspace);
        setProjectRenameValue(workspace.label);
      }} onRemove={(workspace) => {
        setProjectMenu(undefined);
        setProjectRemoveTarget(workspace);
      }} cleanupDisabled={sessionCleanupTargets(sessionsByWorkspace[projectMenu.workspace.id] ?? [], keepSessionIdFor(projectMenu.workspace.id)).length === 0} />}
      <SessionSearchDialog open={searchOpen} onOpenChange={setSearchOpen} workspaces={workspaces} searchSessions={searchSessions} onSelectSession={(workspaceId, sessionId) => { chooseSession(workspaceId, sessionId); }} />
      <MobileActionSheet target={mobileActionTarget} onClose={() => setMobileActionTarget(undefined)} onRenameProject={(workspace) => {
        setMobileActionTarget(undefined);
        setProjectRenameTarget(workspace);
        setProjectRenameValue(workspace.label);
      }} onCleanupSessions={(workspace) => {
        setMobileActionTarget(undefined);
        openSessionCleanup(workspace);
      }} onRemoveProject={(workspace) => {
        setMobileActionTarget(undefined);
        setProjectRemoveTarget(workspace);
      }} cleanupDisabled={mobileActionTarget?.kind === "project" && sessionCleanupTargets(sessionsByWorkspace[mobileActionTarget.workspace.id] ?? [], keepSessionIdFor(mobileActionTarget.workspace.id)).length === 0} onRenameSession={(targetWorkspaceId, session) => {
        setMobileActionTarget(undefined);
        setRenameTarget({ workspaceId: targetWorkspaceId, session });
        setRenameValue(session.name ?? sessionLabel(session.name, session.preview));
      }} onForkSession={(targetWorkspaceId, session) => {
        setMobileActionTarget(undefined);
        void forkSessionFromTarget({ workspaceId: targetWorkspaceId, sessionId: session.id });
      }} onDeleteSession={(targetWorkspaceId, session) => {
        setMobileActionTarget(undefined);
        void deleteSession({ workspaceId: targetWorkspaceId, session });
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
      <Dialog open={sessionCleanupTarget !== undefined} onOpenChange={(open) => { if (!open && !sessionCleanupPending) setSessionCleanupTarget(undefined); }}>
        <DialogContent title="清理会话">
          <p className="delete-session-message">{sessionCleanupConfirmMessage(sessionCleanupTarget, sessionsByWorkspace[sessionCleanupTarget?.id ?? ""] ?? [], sessionCleanupTarget === undefined ? undefined : keepSessionIdFor(sessionCleanupTarget.id))}</p>
          <div className="dialog-actions"><Button variant="secondary" onClick={() => setSessionCleanupTarget(undefined)} disabled={sessionCleanupPending}>取消</Button><Button variant="danger" onClick={() => { void cleanupProjectSessions(); }} disabled={sessionCleanupPending}>{sessionCleanupPending ? "正在清理…" : "清理会话"}</Button></div>
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
    </main>
  );
}

function withoutSession(current: SessionSummary[], sessionId: string): SessionSummary[] {
  const next = current.filter((session) => session.id !== sessionId);
  return next.length === current.length ? current : next;
}

function sessionCleanupConfirmMessage(workspace: Workspace | undefined, sessions: SessionSummary[], keepSessionId?: string): string {
  const count = sessionCleanupTargets(sessions, keepSessionId).length;
  const label = workspace?.label ?? "";
  if (keepSessionId !== undefined) return `「${label}」将永久删除 ${String(count)} 个闲置会话，当前会话与执行中的会话会保留。不可恢复。`;
  return `「${label}」将永久删除 ${String(count)} 个闲置会话，执行中的会话会保留。不可恢复。`;
}

function withoutDraft(current: Record<string, string>, sessionId: string): Record<string, string> {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}

function markSessionUserActivity(sessions: SessionSummary[], sessionId: string): SessionSummary[] {
  const at = new Date().toISOString();
  return sortSessionSummaries(sessions.map((session) => session.id === sessionId
    ? { ...session, runState: "running" as const, attentionState: "running" as const, attentionAt: at, lastUserMessageAt: at, updatedAt: at }
    : session));
}

function mergeSession(current: SessionSummary[], next: SessionSummary): SessionSummary[] {
  const existing = current.findIndex((session) => session.id === next.id);
  if (existing === -1) return sortSessionSummaries([next, ...current]);
  const copy = [...current];
  copy[existing] = { ...copy[existing], ...next };
  return sortSessionSummaries(copy);
}

function mergeWorkspace(current: Workspace[], next: Workspace): Workspace[] {
  const existing = current.findIndex((workspace) => workspace.id === next.id);
  if (existing === -1) return [...current, next].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  const copy = [...current];
  copy[existing] = next;
  return copy.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

function persistSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // The sidebar still works for the current page when browser storage is unavailable.
  }
}

function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    const value = Number(raw);
    return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function clampSidebarWidth(value: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, value));
}

function readSessionFocusMode(): boolean {
  try {
    return window.localStorage.getItem(SESSION_FOCUS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
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
  const statuses = Object.entries(panels.statuses);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (widgets.length === 0 && statuses.length === 0) return null;
  return <aside className="extension-panels" aria-label="扩展内容">
    <div className="extension-widget-track">
      {statuses.map(([key, text]) => <span className="extension-status" key={`status:${key}`} title={key}><Puzzle size={11} /><span>{text}</span></span>)}
      {widgets.map(([key, widget]) => <section key={`widget:${key}`} className={`extension-widget ${collapsed[key] === true ? "collapsed" : ""}`} title={key}>
        <button type="button" className="extension-widget-heading" onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))} aria-expanded={collapsed[key] !== true}>
          <span>{key}</span><small>{collapsed[key] === true ? "展开" : "收起"}</small>
        </button>
        {collapsed[key] === true ? null : <pre className="extension-widget-body">{widget.lines.join("\n")}</pre>}
      </section>)}
    </div>
  </aside>;
}

function ExtensionToasts({ toasts, sessionsByWorkspace, onOpenSession, onDismiss }: { toasts: ExtensionToast[]; sessionsByWorkspace: Record<string, SessionSummary[]>; onOpenSession: (workspaceId: string, sessionId: string) => void; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return <div className="extension-toast-stack" aria-label="扩展通知" aria-live="polite">
    {toasts.map((toast) => {
      const Icon = toast.tone === "info" ? Bell : CircleAlert;
      const session = toast.sessionId === undefined ? undefined : sessionsByWorkspace[toast.workspaceId]?.find((candidate) => candidate.id === toast.sessionId);
      const sourceLabel = extensionToastSourceLabel(session?.name);
      return <div key={toast.id} className={`toast-surface extension-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
        <Icon size={14} className="toast-surface-icon" /><div className="extension-toast-copy">{toast.count > 1 || toast.sessionId === undefined || sourceLabel === undefined ? null : <button type="button" className="extension-toast-source" onClick={() => onOpenSession(toast.workspaceId, toast.sessionId!)}>{sourceLabel}</button>}{toast.count > 1 ? <strong className="extension-toast-count">收到 {toast.count} 条扩展通知</strong> : <span className="extension-toast-message">{toast.message}</span>}</div><button type="button" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}><X size={14} /></button>
      </div>;
    })}
  </div>;
}
