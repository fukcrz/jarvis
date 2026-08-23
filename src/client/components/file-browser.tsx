import { useEffect, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Clipboard, FileCode2, FileText, Folder, FolderOpen } from "lucide-react";
import type { Workspace, WorkspaceDirectoryListing, WorkspaceFileContent } from "../../shared/protocol";
import { api } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface FileBrowserProps {
  workspaces: Workspace[];
  workspaceId?: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onBack: () => void;
}

export function FileBrowser({ workspaces, workspaceId, onWorkspaceChange, onBack }: FileBrowserProps) {
  const [path, setPath] = useState("");
  const [directory, setDirectory] = useState<WorkspaceDirectoryListing>();
  const [file, setFile] = useState<WorkspaceFileContent>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const workspace = workspaces.find((item) => item.id === workspaceId);

  useEffect(() => {
    setPath("");
    setDirectory(undefined);
    setFile(undefined);
    setWorkspacePickerOpen(false);
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId === undefined || file !== undefined) return;
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void api.workspaceDirectory(workspaceId, path).then((next) => {
      if (!disposed) setDirectory(next);
    }).catch((reason: unknown) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "无法读取目录");
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [file, path, workspaceId]);

  const openEntry = (entry: WorkspaceDirectoryListing["entries"][number]) => {
    if (entry.kind === "directory") {
      setPath(entry.path);
      return;
    }
    setLoading(true);
    setError(undefined);
    void api.workspaceFile(workspaceId!, entry.path).then(setFile).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "无法预览文件");
    }).finally(() => setLoading(false));
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

  if (workspace === undefined) return <section className="file-browser-page"><div className="file-browser-empty"><FolderOpen size={28} /><h2>暂无工作区</h2><Button onClick={onBack}>返回会话</Button></div></section>;

  return <section className="file-browser-page">
    <header className="file-browser-header">
      <Button variant="ghost" size="icon" aria-label="返回会话" title="返回会话" onClick={onBack}><ArrowLeft size={18} /></Button>
      <div className="file-browser-heading"><h1>文件</h1></div>
      <button type="button" className="file-browser-project-trigger" aria-label="切换项目" onClick={() => setWorkspacePickerOpen(true)}><FolderOpen size={16} /><span>{workspace.label}</span><ChevronDown size={16} /></button>
    </header>
    <div className="file-browser-body">
      <div className="file-browser-toolbar">
        <div className="file-browser-breadcrumb"><button type="button" onClick={() => { setFile(undefined); setPath(""); }} className={path === "" && file === undefined ? "current" : ""}>根目录</button>{path.split("/").filter(Boolean).map((part, index, parts) => { const target = parts.slice(0, index + 1).join("/"); return <span key={target}><ChevronRight size={14} /><button type="button" className={file === undefined && target === path ? "current" : ""} onClick={() => { setFile(undefined); setPath(target); }}>{part}</button></span>; })}</div>
      </div>
      {error === undefined ? null : <div className="file-browser-error" role="alert">{error}</div>}
      {file !== undefined ? <FilePreview file={file} onBack={() => { setFile(undefined); setError(undefined); }} onCopy={(value, message) => { void copy(value, message); }} /> : <div className="file-browser-list" aria-label="文件列表">
        {loading && directory === undefined ? <p className="file-browser-status">正在读取…</p> : null}
        {(directory?.entries ?? []).map((entry) => <button type="button" className="file-browser-entry" key={entry.path} onClick={() => openEntry(entry)} disabled={loading}><span className="file-browser-entry-icon">{entry.kind === "directory" ? <Folder size={18} /> : <FileText size={18} />}</span><span className="file-browser-entry-name">{entry.name}</span>{entry.kind === "directory" ? <ChevronRight size={16} /> : null}</button>)}
        {!loading && directory !== undefined && directory.entries.length === 0 ? <p className="file-browser-status">此目录没有文件</p> : null}
      </div>}
    </div>
    <Dialog open={workspacePickerOpen} onOpenChange={setWorkspacePickerOpen}>
      <DialogContent title="选择项目" description={`${workspaces.length} 个项目`} className="file-browser-project-dialog">
        <div className="file-browser-project-list">
          {workspaces.map((item) => <button type="button" className={`file-browser-project-option ${item.id === workspace.id ? "selected" : ""}`} key={item.id} onClick={() => { onWorkspaceChange(item.id); setWorkspacePickerOpen(false); }}><Folder size={17} /><span className="file-browser-project-option-copy"><strong>{item.label}</strong><small>{item.cwd}</small></span>{item.id === workspace.id ? <Check size={16} /> : null}</button>)}
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}

function FilePreview({ file, onBack, onCopy }: { file: WorkspaceFileContent; onBack: () => void; onCopy: (value: string, message: string) => void }) {
  const lines = file.content.split("\n");
  return <article className="file-preview">
    <header className="file-preview-header"><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={15} />返回目录</Button><div className="file-preview-title"><FileCode2 size={16} /><strong>{file.name}</strong><small>{formatBytes(file.size)}{file.truncated ? " · 已截断" : ""}</small></div><Button variant="secondary" size="sm" onClick={() => onCopy(file.content, "已复制文件内容")}><Clipboard size={14} />复制</Button></header>
    {file.truncated ? <div className="file-preview-notice">文件较大，仅显示前 512 KB。</div> : null}
    <pre className="file-preview-code" aria-label={`文件内容 ${file.path}`}><code>{lines.map((line, index) => <span className="file-preview-line" key={index}><span className="file-preview-line-number">{index + 1}</span><span>{line || " "}</span>{index === lines.length - 1 ? null : "\n"}</span>)}</code></pre>
  </article>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
