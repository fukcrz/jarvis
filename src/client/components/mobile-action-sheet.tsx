import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Eraser, Folder, GitBranch, Pencil, Star, Trash2 } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { isEmptySession, sessionLabel } from "../lib/utils";

export type MobileActionTarget = { kind: "project"; workspace: Workspace } | { kind: "session"; workspaceId: string; workspaceLabel: string; session: SessionSummary };

interface MobileActionSheetProps {
  target?: MobileActionTarget;
  onClose: () => void;
  onRenameProject: (workspace: Workspace) => void;
  onCleanupSessions: (workspace: Workspace) => void;
  onRemoveProject: (workspace: Workspace) => void;
  onStarSession: (workspaceId: string, session: SessionSummary) => void;
  onRenameSession: (workspaceId: string, session: SessionSummary) => void;
  onForkSession: (workspaceId: string, session: SessionSummary) => void;
  onDeleteSession: (workspaceId: string, session: SessionSummary) => void;
  onOpenFiles?: (workspaceId: string) => void;
  cleanupDisabled?: boolean;
}

export function MobileActionSheet(props: MobileActionSheetProps) {
  const target = props.target;
  return <DialogPrimitive.Root open={target !== undefined} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="action-sheet-overlay" />
      <DialogPrimitive.Content className="action-sheet" aria-label={target?.kind === "project" ? "项目操作" : "会话操作"}>
        <DialogPrimitive.Title className="action-sheet-title">{target?.kind === "project" ? <span className="action-sheet-title-main">{target.workspace.label}</span> : target === undefined ? "" : <><span className="action-sheet-title-main">{sessionLabel(target.session.name, target.session.preview)}</span><span className="action-sheet-title-subtitle">{target.workspaceLabel}</span></>}</DialogPrimitive.Title>
        {target?.kind === "project" ? <>
          <button type="button" className="action-sheet-item" onClick={() => props.onRenameProject(target.workspace)}><Pencil size={16} />重命名项目</button>
          <button type="button" className="action-sheet-item danger" disabled={props.cleanupDisabled === true} onClick={() => props.onCleanupSessions(target.workspace)}><Eraser size={16} />清理会话</button>
          <button type="button" className="action-sheet-item danger" onClick={() => props.onRemoveProject(target.workspace)}><Trash2 size={16} />移除项目</button>
        </> : target?.kind === "session" ? <>
          {isEmptySession(target.session) ? null : <button type="button" className="action-sheet-item" onClick={() => props.onStarSession(target.workspaceId, target.session)}><Star size={16} fill={target.session.starred === true ? "currentColor" : "none"} />{target.session.starred === true ? "取消收藏" : "收藏"}</button>}
          {isEmptySession(target.session) ? null : <button type="button" className="action-sheet-item" onClick={() => props.onRenameSession(target.workspaceId, target.session)}><Pencil size={16} />重命名会话</button>}
          {isEmptySession(target.session) ? null : <button type="button" className="action-sheet-item" onClick={() => props.onForkSession(target.workspaceId, target.session)}><GitBranch size={16} />创建分支</button>}
          {props.onOpenFiles === undefined ? null : <button type="button" className="action-sheet-item" onClick={() => props.onOpenFiles?.(target.workspaceId)}><Folder size={16} />文件</button>}
          <button type="button" className="action-sheet-item danger" disabled={target.session.runState !== "idle"} onClick={() => props.onDeleteSession(target.workspaceId, target.session)}><Trash2 size={16} />删除会话</button>
        </> : null}
        <DialogPrimitive.Close asChild><button type="button" className="action-sheet-cancel">取消</button></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
