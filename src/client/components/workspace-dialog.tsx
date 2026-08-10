import { useEffect, useState } from "react";
import { HardDrive, Folder, FolderPlus, ChevronRight } from "lucide-react";
import type { DirectoryListing } from "../../shared/protocol";
import { api } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface WorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (path: string) => Promise<void>;
}

export function WorkspaceDialog(props: WorkspaceDialogProps) {
  const [directory, setDirectory] = useState<DirectoryListing>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const browse = async (path?: string, roots = false) => {
    setPending(true);
    setError(undefined);
    try {
      setDirectory(await api.directory(path, roots));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法打开目录");
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    if (!props.open) return;
    setDirectory(undefined);
    setError(undefined);
    void browse(undefined, true);
  }, [props.open]);

  const add = async () => {
    if (directory === undefined) return;
    setPending(true);
    setError(undefined);
    try {
      await props.onAdd(directory.path);
      props.onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法添加项目");
    } finally {
      setPending(false);
    }
  };

  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent title="选择项目目录" description="请选择运行 Jarvis 的设备上的目录。" className="workspace-dialog">
      {error === undefined ? null : <div className="workspace-error" role="alert">{error}</div>}
      <section className="directory-browser">
        <div className="directory-location">
          {directory?.isRootPicker === true ? null : <Button variant="secondary" size="sm" onClick={() => { void browse(undefined, true); }} disabled={pending}>磁盘</Button>}
          {directory?.parent === undefined ? null : <Button variant="secondary" size="sm" onClick={() => { void browse(directory.parent); }} disabled={pending}>上一级</Button>}
          <span className="directory-path" title={directory?.path}>{directory?.isRootPicker === true ? "选择磁盘" : directory?.path ?? "正在打开目录…"}</span>
        </div>
        <div className="directory-list" aria-label="目录列表">
          {directory?.entries.map((entry) => <button type="button" className="directory-row" key={entry.path} onClick={() => { void browse(entry.path); }} disabled={pending}>
            {directory?.isRootPicker === true ? <HardDrive size={18} /> : <Folder size={18} />}<span>{entry.name}</span><ChevronRight size={17} />
          </button>)}
          {directory !== undefined && directory.entries.length === 0 ? <p className="directory-empty">没有子目录</p> : null}
        </div>
        <footer className="directory-selection">
          <div><strong>{directory?.name}</strong><span>{directory?.isRootPicker === true ? "选择磁盘以浏览其中的文件夹" : directory?.path}</span>{directory?.isGitRepository ? <small>Git 仓库</small> : null}</div>
          <Button onClick={() => { void add(); }} disabled={directory === undefined || directory.isRootPicker || pending}><FolderPlus size={16} /> 选择此文件夹</Button>
        </footer>
      </section>
    </DialogContent>
  </Dialog>;
}
