import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, FileCode2, FileQuestion, FileText, Folder, FolderOpen } from "lucide-react";
import type { Workspace, WorkspaceDirectoryListing, WorkspaceFileContent } from "../../shared/protocol";
import { api, ApiError, workspaceFileUrl } from "../api";
import { MAX_TABLE_ROWS, parseDelimited, previewKindForPath, type PreviewKind } from "../lib/file-preview";
import { MarkdownMessage } from "./markdown-message";
import { CodePreview } from "./code-preview";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { FileContextMenu, type FileContextMenuTarget } from "./file-context-menu";

interface FileBrowserProps {
  workspaces: Workspace[];
  workspaceId?: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onBack: () => void;
}

const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 540;
const SIDEBAR_WIDTH_KEY = "jarvis.files.sidebarWidth";

/** 当前打开的预览：文本类带内容，媒体/不支持类型经 /api/files 渲染。 */
interface FilePreviewState {
  path: string;
  name: string;
  kind: PreviewKind;
  content?: WorkspaceFileContent;
}

export function FileBrowser({ workspaces, workspaceId, onWorkspaceChange, onBack }: FileBrowserProps) {
  const [entriesByPath, setEntriesByPath] = useState<Record<string, WorkspaceDirectoryListing>>({});
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [loadingPaths, setLoadingPaths] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<FilePreviewState>();
  const [error, setError] = useState<string>();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<FileContextMenuTarget>();
  const [deleteTarget, setDeleteTarget] = useState<FileContextMenuTarget>();
  const [deletePending, setDeletePending] = useState(false);
  const [focusedPath, setFocusedPath] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth());
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef(0);
  const loadedDirectoryPathsRef = useRef(new Set<string>());
  const loadingDirectoryPathsRef = useRef(new Set<string>());
  const deleteRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const previewLoadingPathRef = useRef<string | undefined>(undefined);
  const workspaceRef = useRef(workspaceId);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  workspaceRef.current = workspaceId;

  const loadDirectory = useCallback(async (targetPath: string, options: { silent?: boolean } = {}): Promise<WorkspaceDirectoryListing | undefined> => {
    const targetWorkspaceId = workspaceRef.current;
    if (targetWorkspaceId === undefined) return undefined;
    const requestKey = `${targetWorkspaceId}:${targetPath}`;
    if (loadingDirectoryPathsRef.current.has(requestKey)) return undefined;
    const silent = options.silent === true;
    loadingDirectoryPathsRef.current.add(requestKey);
    if (!silent) setLoadingPaths((current) => current[targetPath] === true ? current : { ...current, [targetPath]: true });
    try {
      const next = await api.workspaceDirectory(targetWorkspaceId, targetPath);
      if (workspaceRef.current !== targetWorkspaceId) return next;
      loadedDirectoryPathsRef.current.delete(targetPath);
      loadedDirectoryPathsRef.current.add(next.path);
      setEntriesByPath((current) => {
        const stalePaths = [...loadedDirectoryPathsRef.current].filter((path) => path !== next.path && directoryPath(path) === next.path && next.entries.every((entry) => entry.path !== path || entry.kind !== "directory"));
        if (stalePaths.length === 0 && sameDirectoryListing(current[next.path], next) && (targetPath === next.path || current[targetPath] === undefined)) return current;
        const updated = { ...current, [next.path]: next };
        if (targetPath !== next.path) delete updated[targetPath];
        for (const stalePath of stalePaths) {
          loadedDirectoryPathsRef.current.delete(stalePath);
          for (const cachedPath of Object.keys(updated)) {
            if (cachedPath === stalePath || isPathPrefix(stalePath, cachedPath)) delete updated[cachedPath];
          }
        }
        return updated;
      });
      return next;
    } catch (reason: unknown) {
      if (!silent && workspaceRef.current === targetWorkspaceId) setError(reason instanceof Error ? reason.message : "无法读取目录");
      return undefined;
    } finally {
      loadingDirectoryPathsRef.current.delete(requestKey);
      if (!silent && workspaceRef.current === targetWorkspaceId) {
        setLoadingPaths((current) => {
          if (current[targetPath] !== true) return current;
          const next = { ...current };
          delete next[targetPath];
          return next;
        });
      }
    }
  }, []);

  useEffect(() => {
    setEntriesByPath({});
    setExpandedPaths({});
    setLoadingPaths({});
    loadedDirectoryPathsRef.current.clear();
    loadingDirectoryPathsRef.current.clear();
    setPreview(undefined);
    setError(undefined);
    setContextMenu(undefined);
    setDeleteTarget(undefined);
    deleteRequestRef.current += 1;
    previewRequestRef.current += 1;
    previewLoadingPathRef.current = undefined;
    setDeletePending(false);
    setFocusedPath("");
    setRootPath("");
    setWorkspacePickerOpen(false);
    if (workspaceId === undefined) return;
    void loadDirectory("").then((listing) => {
      if (listing === undefined) return;
      setRootPath(listing.path);
      setExpandedPaths({ [listing.path]: true });
      setFocusedPath(listing.path);
    });
  }, [loadDirectory, workspaceId]);

  useEffect(() => {
    if (workspaceId === undefined || rootPath === "") return;
    if (entriesByPath[rootPath] !== undefined || loadingPaths[rootPath] === true) return;
    void loadDirectory(rootPath);
  }, [entriesByPath, loadDirectory, loadingPaths, rootPath, workspaceId]);

  // Keep the visible tree in sync with Pi or external edits without replacing
  // the file currently open in the preview pane.
  useEffect(() => {
    if (workspaceId === undefined) return;
    const refreshLoadedDirectories = () => {
      if (document.visibilityState !== "visible") return;
      for (const path of loadedDirectoryPathsRef.current) void loadDirectory(path, { silent: true });
    };
    const timer = window.setInterval(refreshLoadedDirectories, 3_000);
    return () => window.clearInterval(timer);
  }, [loadDirectory, workspaceId]);

  useEffect(() => {
    if (workspaceId === undefined) return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth, workspaceId]);

  useEffect(() => {
    if (resizeStateRef.current === null) return;
    const onMove = (event: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (resizeState === null) return;
      const nextWidth = clampWidth(resizeState.startWidth + (event.clientX - resizeState.startX));
      setSidebarWidth(nextWidth);
    };
    const stopResize = () => {
      resizeStateRef.current = null;
      document.body.classList.remove("file-browser-resizing");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopResize, { once: true });
    window.addEventListener("pointercancel", stopResize, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, [sidebarWidth]);

  const invalidatePreviewRequest = () => {
    previewRequestRef.current += 1;
    const loadingPath = previewLoadingPathRef.current;
    previewLoadingPathRef.current = undefined;
    if (loadingPath !== undefined) {
      setLoadingPaths((current) => {
        if (current[loadingPath] !== true) return current;
        const next = { ...current };
        delete next[loadingPath];
        return next;
      });
    }
  };

  const closePreview = () => {
    invalidatePreviewRequest();
    setPreview(undefined);
    setError(undefined);
    requestAnimationFrame(() => {
      const element = treeRef.current;
      if (element !== null) element.scrollTop = treeScrollRef.current;
    });
  };

  const openFile = async (path: string) => {
    const targetWorkspaceId = workspaceRef.current;
    if (targetWorkspaceId === undefined) return;
    invalidatePreviewRequest();
    const requestId = previewRequestRef.current;
    treeScrollRef.current = treeRef.current?.scrollTop ?? 0;
    const name = path.split("/").pop() ?? path;
    const kind = previewKindForPath(path);
    // 媒体类与不支持类型不需要正文内容，直接用 /api/files 渲染或下载。
    if (kind !== "text" && kind !== "markdown" && kind !== "table") {
      if (preview?.path === path && preview.kind === kind) return;
      setPreview({ path, name, kind });
      setFocusedPath(directoryPath(path));
      setError(undefined);
      return;
    }
    if (preview?.path === path && preview.content !== undefined) return;
    previewLoadingPathRef.current = path;
    setLoadingPaths((current) => ({ ...current, [path]: true }));
    setError(undefined);
    try {
      const file = await api.workspaceFile(targetWorkspaceId, path);
      if (workspaceRef.current !== targetWorkspaceId || previewRequestRef.current !== requestId) return;
      setPreview({ path, name, kind, content: file });
      setFocusedPath(directoryPath(path));
    } catch (reason: unknown) {
      if (workspaceRef.current !== targetWorkspaceId || previewRequestRef.current !== requestId) return;
      if (reason instanceof ApiError && reason.code === "FILE_BINARY") {
        setPreview({ path, name, kind: "unsupported" });
        return;
      }
      setError(reason instanceof Error ? reason.message : "无法预览文件");
    } finally {
      if (workspaceRef.current === targetWorkspaceId && previewRequestRef.current === requestId && previewLoadingPathRef.current === path) {
        previewLoadingPathRef.current = undefined;
        setLoadingPaths((current) => {
          if (current[path] !== true) return current;
          const next = { ...current };
          delete next[path];
          return next;
        });
      }
    }
  };

  const toggleDirectory = async (path: string) => {
    const nextExpanded = expandedPaths[path] !== true;
    setFocusedPath(path);
    setExpandedPaths((current) => ({ ...current, [path]: nextExpanded }));
    if (nextExpanded && entriesByPath[path] === undefined) await loadDirectory(path);
  };

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setError(message);
      window.setTimeout(() => setError(undefined), 1_500);
    } catch {
      setError("复制失败");
    }
  };

  const removeEntry = async () => {
    const target = deleteTarget;
    const targetWorkspaceId = workspaceRef.current;
    if (target === undefined || targetWorkspaceId === undefined || deletePending) return;
    const requestId = deleteRequestRef.current + 1;
    deleteRequestRef.current = requestId;
    setDeletePending(true);
    try {
      await api.removeWorkspaceEntry(targetWorkspaceId, target.path);
      if (workspaceRef.current !== targetWorkspaceId || deleteRequestRef.current !== requestId) return;
      setDeleteTarget(undefined);
      setContextMenu(undefined);
      const pendingPreviewPath = previewLoadingPathRef.current;
      const deletesPreview = preview?.path === target.path
        || (target.kind === "directory" && preview !== undefined && isPathPrefix(target.path, preview.path));
      const deletesPendingPreview = pendingPreviewPath === target.path
        || (target.kind === "directory" && pendingPreviewPath !== undefined && isPathPrefix(target.path, pendingPreviewPath));
      if (deletesPreview || deletesPendingPreview) {
        invalidatePreviewRequest();
        setPreview(undefined);
      }
      const parentPath = directoryPath(target.path) || rootPath;
      loadedDirectoryPathsRef.current.delete(target.path);
      for (const cachedPath of [...loadedDirectoryPathsRef.current]) {
        if (isPathPrefix(target.path, cachedPath)) loadedDirectoryPathsRef.current.delete(cachedPath);
      }
      setEntriesByPath((current) => {
        const next = { ...current };
        delete next[target.path];
        for (const cachedPath of Object.keys(next)) if (isPathPrefix(target.path, cachedPath)) delete next[cachedPath];
        return next;
      });
      await loadDirectory(parentPath);
      if (workspaceRef.current !== targetWorkspaceId || deleteRequestRef.current !== requestId) return;
      setError(undefined);
    } catch (reason: unknown) {
      if (workspaceRef.current === targetWorkspaceId && deleteRequestRef.current === requestId) setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      if (deleteRequestRef.current === requestId) setDeletePending(false);
    }
  };

  const rootListing = rootPath === "" ? undefined : entriesByPath[rootPath];
  const treeEntries = rootListing?.entries ?? [];
  const parentPath = rootListing?.parent;

  const openParent = async () => {
    if (parentPath === undefined) return;
    invalidatePreviewRequest();
    setPreview(undefined);
    setError(undefined);
    setContextMenu(undefined);
    const listing = await loadDirectory(parentPath);
    if (listing === undefined) return;
    setRootPath(listing.path);
    setExpandedPaths({ [listing.path]: true });
    setFocusedPath(listing.path);
  };

  if (workspace === undefined) return <section className="file-browser-page"><div className="file-browser-empty"><FolderOpen size={28} /><h2>暂无工作区</h2><Button onClick={onBack}>返回会话</Button></div></section>;

  return <section className={`file-browser-page${preview !== undefined ? " file-browser-previewing" : ""}`} style={{ "--file-browser-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <header className="file-browser-header">
      <Button variant="ghost" size="icon" aria-label="返回会话" title="返回会话" onClick={onBack}><ArrowLeft size={18} /></Button>
      <div className="file-browser-heading"><h1>文件</h1></div>
      <button type="button" className="file-browser-project-trigger" aria-label="切换项目" onClick={() => setWorkspacePickerOpen(true)}><FolderOpen size={16} /><span>{workspace.label}</span><ChevronDown size={16} /></button>
    </header>
    <div className="file-browser-body">
      <aside className="file-browser-sidebar">
        <div className="file-browser-sidebar-header">
          {error === undefined ? null : <div className="file-browser-error" role="alert">{error}</div>}
          <div className="file-browser-location">
            {parentPath === undefined ? null : <Button variant="secondary" size="sm" onClick={() => { void openParent(); }} disabled={loadingPaths[parentPath] === true}>上一级</Button>}
            <span className="file-browser-path" title={rootListing?.path}>{rootListing?.path ?? workspace.cwd}</span>
          </div>
        </div>
        <div className="file-browser-tree" ref={treeRef} aria-label="文件树">
          {rootListing === undefined ? <p className="file-browser-status">正在读取…</p> : treeEntries.map((entry) => renderTreeNode(entry, 0, { entriesByPath, expandedPaths, focusedPath, loadingPaths, selectedFilePath: preview?.path, onToggleDirectory: (path) => { void toggleDirectory(path); }, onOpenFile: (path) => { void openFile(path); }, onContextMenu: (entry, event) => { event.preventDefault(); setFocusedPath(entry.path); setContextMenu({ ...entry, x: event.clientX, y: event.clientY }); } }))}
          {rootListing !== undefined && treeEntries.length === 0 ? <p className="file-browser-status">此项目没有文件</p> : null}
        </div>
      </aside>
      <div className="file-browser-divider" role="separator" aria-orientation="vertical" aria-label="调整目录宽度" onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };
        document.body.classList.add("file-browser-resizing");
      }} />
      <main className="file-browser-main">
        {preview !== undefined ? <FilePreview state={preview} onBack={closePreview} onCopy={(value, message) => { void copy(value, message); }} /> : <div className="file-browser-empty file-browser-preview-empty"><FileCode2 size={30} /><h2>选择一个文件</h2><p>左侧目录中的文件会在这里预览。</p></div>}
      </main>
    </div>
    <Dialog open={workspacePickerOpen} onOpenChange={setWorkspacePickerOpen}>
      <DialogContent title="选择项目" description={`${workspaces.length} 个项目`} className="file-browser-project-dialog">
        <div className="file-browser-project-list">
          {workspaces.map((item) => <button type="button" className={`file-browser-project-option ${item.id === workspace.id ? "selected" : ""}`} key={item.id} onClick={() => { onWorkspaceChange(item.id); setWorkspacePickerOpen(false); }}><Folder size={17} /><span className="file-browser-project-option-copy"><strong>{item.label}</strong><small>{item.cwd}</small></span>{item.id === workspace.id ? <Check size={16} /> : null}</button>)}
        </div>
      </DialogContent>
    </Dialog>
    {contextMenu === undefined ? null : <FileContextMenu target={contextMenu} fullPath={nativePath(contextMenu.path)} onClose={() => setContextMenu(undefined)} onCopy={(value, message) => { setContextMenu(undefined); void copy(value, message); }} onDelete={(target) => { setContextMenu(undefined); setDeleteTarget(target); }} />}
    <Dialog open={deleteTarget !== undefined} onOpenChange={(open) => { if (!open && !deletePending) setDeleteTarget(undefined); }}>
      <DialogContent title={deleteTarget?.kind === "directory" ? "删除目录" : "删除文件"}>
        <p className="delete-session-message"><strong>{deleteTarget?.name ?? ""}</strong>{deleteTarget?.kind === "directory" ? "及其全部内容将被递归删除。" : "将被永久删除。"}</p>
        <div className="dialog-actions"><Button variant="secondary" onClick={() => setDeleteTarget(undefined)} disabled={deletePending}>取消</Button><Button variant="danger" onClick={() => { void removeEntry(); }} disabled={deletePending}>{deletePending ? "删除中…" : "删除"}</Button></div>
      </DialogContent>
    </Dialog>
  </section>;
}

function renderTreeNode(
  entry: WorkspaceDirectoryListing["entries"][number],
  depth: number,
  state: {
    entriesByPath: Record<string, WorkspaceDirectoryListing>;
    expandedPaths: Record<string, boolean>;
    focusedPath: string;
    loadingPaths: Record<string, boolean>;
    selectedFilePath?: string;
    onToggleDirectory: (path: string) => void;
    onOpenFile: (path: string) => void;
    onContextMenu: (entry: WorkspaceDirectoryListing["entries"][number], event: MouseEvent<HTMLButtonElement>) => void;
  },
): ReactNode {
  const isDirectory = entry.kind === "directory";
  const expanded = isDirectory && state.expandedPaths[entry.path] === true;
  const active = isPathInBranch(state.focusedPath, entry.path) || state.selectedFilePath === entry.path;
  const childListing = state.entriesByPath[entry.path];
  return <div className="file-browser-tree-node" key={entry.path}>
    <button
      type="button"
      className={`file-browser-entry ${isDirectory ? "directory" : "file"} ${state.selectedFilePath === entry.path ? "selected" : ""} ${active ? "active" : ""}`}
      style={{ paddingInlineStart: `${13 + depth * 16}px` }}
      onClick={() => isDirectory ? state.onToggleDirectory(entry.path) : state.onOpenFile(entry.path)}
      onContextMenu={(event) => state.onContextMenu(entry, event)}
      disabled={state.loadingPaths[entry.path] === true}
      aria-expanded={isDirectory ? expanded : undefined}
    >
      <span className="file-browser-entry-icon">{isDirectory ? expanded ? <FolderOpen size={18} /> : <Folder size={18} /> : <FileText size={18} />}</span>
      <span className="file-browser-entry-name">{entry.name}</span>
      {isDirectory ? expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} /> : null}
    </button>
    {isDirectory && expanded ? <div className="file-browser-tree-branch">
      {state.loadingPaths[entry.path] === true && childListing === undefined ? <p className="file-browser-status file-browser-tree-loading">正在读取…</p> : null}
      {(childListing?.entries ?? []).map((child) => renderTreeNode(child, depth + 1, state))}
      {childListing !== undefined && childListing.entries.length === 0 ? <p className="file-browser-status file-browser-tree-empty">此文件夹没有文件</p> : null}
    </div> : null}
  </div>;
}

function FilePreview({ state, onBack, onCopy }: { state: FilePreviewState; onBack: () => void; onCopy: (value: string, message: string) => void }) {
  const url = workspaceFileUrl("", state.path);
  const downloadUrl = workspaceFileUrl("", state.path, { download: true });
  const copyable = state.content !== undefined && (state.kind === "text" || state.kind === "markdown" || state.kind === "table");
  return <article className={`file-preview file-preview-${state.kind}`}>
    <header className="file-preview-header"><Button variant="ghost" size="sm" className="file-preview-back" title={state.content === undefined ? kindLabel(state.kind) : `${formatBytes(state.content.size)}${state.content.truncated ? " · 已截断" : ""}`} onClick={onBack}><ArrowLeft size={15} /><span className="file-preview-back-name">{state.name}</span></Button><div className="file-preview-actions">{copyable ? <Button variant="ghost" size="sm" onClick={() => onCopy(state.content!.content, "已复制文件内容")}>复制</Button> : null}<a className="button button-ghost button-sm" href={url} target="_blank" rel="noreferrer">打开</a><a className="button button-ghost button-sm" href={downloadUrl} download>下载</a></div></header>
    {state.content?.truncated === true ? <div className="file-preview-notice">文件较大，仅显示前 512 KB。</div> : null}
    <div className="file-preview-body"><FilePreviewBody state={state} url={url} /></div>
  </article>;
}

function FilePreviewBody({ state, url }: { state: FilePreviewState; url: string }) {
  switch (state.kind) {
    case "image":
      return <div className="file-preview-media"><img src={url} alt={state.name} /></div>;
    case "pdf":
      return <div className="file-preview-media"><iframe src={url} title={state.name} /></div>;
    case "audio":
      return <div className="file-preview-media file-preview-audio"><audio controls src={url} /></div>;
    case "video":
      return <div className="file-preview-media"><video controls playsInline src={url} /></div>;
    case "markdown":
      return <div className="message-content file-preview-markdown"><MarkdownMessage text={state.content?.content ?? ""} baseDir={directoryPath(state.path)} /></div>;
    case "table":
      return <TablePreview text={state.content?.content ?? ""} name={state.name} />;
    case "unsupported":
      return <div className="file-browser-empty file-preview-unsupported"><FileQuestion size={30} /><h2>暂不支持预览</h2><p>该文件类型无法在浏览器中直接展示，可以下载后使用本机应用打开。</p></div>;
    default:
      return <CodePreview text={state.content?.content ?? ""} path={state.path} className="file-preview-code" lineClassName="file-preview-line" />;
  }
}

function TablePreview({ text, name }: { text: string; name: string }) {
  const rows = useMemo(() => parseDelimited(text, name.toLowerCase().endsWith(".tsv") ? "\t" : ","), [text, name]);
  const visible = rows.slice(0, MAX_TABLE_ROWS);
  const header = rows.length > 1 ? rows[0] : undefined;
  const columnCount = visible.reduce((max, row) => Math.max(max, row.length), 0);
  return <div className="file-preview-table-wrap">
    <table className="file-preview-table" aria-label={`表格内容 ${name}`}>
      {header === undefined ? null : <thead><tr>{header.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>}
      <tbody>{visible.slice(header === undefined ? 0 : 1).map((row, rowIndex) => <tr key={rowIndex}>{Array.from({ length: columnCount }, (_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ""}</td>)}</tr>)}</tbody>
    </table>
    {rows.length > MAX_TABLE_ROWS ? <p className="file-preview-table-notice">表格较大，仅显示前 {MAX_TABLE_ROWS} 行（共 {rows.length} 行）。</p> : null}
  </div>;
}

function nativePath(path: string): string {
  return path.includes("/") && !path.startsWith("/") ? path.replaceAll("/", "\\") : path;
}

function isPathPrefix(prefix: string, path: string): boolean {
  const normalized = prefix.endsWith("/") && prefix !== "/" ? prefix.slice(0, -1) : prefix;
  return path === prefix || path === normalized || path.startsWith(`${normalized}/`) || (normalized === "/" && path.startsWith("/"));
}

function kindLabel(kind: PreviewKind): string {
  switch (kind) {
    case "image": return "图片";
    case "pdf": return "PDF";
    case "audio": return "音频";
    case "video": return "视频";
    case "markdown": return "Markdown";
    case "table": return "表格";
    case "unsupported": return "文件";
    default: return "文本";
  }
}

function sameDirectoryListing(current: WorkspaceDirectoryListing | undefined, next: WorkspaceDirectoryListing): boolean {
  if (current === undefined || current.path !== next.path || current.name !== next.name || current.parent !== next.parent || current.isGitRepository !== next.isGitRepository || current.entries.length !== next.entries.length) return false;
  return current.entries.every((entry, index) => {
    const candidate = next.entries[index];
    return candidate !== undefined && entry.name === candidate.name && entry.path === candidate.path && entry.kind === candidate.kind;
  });
}

function isPathInBranch(current: string, ancestor: string): boolean {
  return ancestor !== "" && isPathPrefix(ancestor, current);
}

function directoryPath(path: string): string {
  if (/^[a-zA-Z]:$/.test(path) || path === "/") return path;
  const index = path.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : "";
  const parent = path.slice(0, index);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent;
}

function readSidebarWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(value) ? clampWidth(value) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function clampWidth(value: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, value));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
