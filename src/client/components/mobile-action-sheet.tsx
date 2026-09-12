import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Eraser, GitBranch, Pencil, Trash2 } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { sessionLabel } from "../lib/utils";

export type MobileActionTarget = { kind: "project"; workspace: Workspace } | { kind: "session"; workspaceId: string; workspaceLabel: string; session: SessionSummary };

interface MobileActionSheetProps {
  target?: MobileActionTarget;
  onClose: () => void;
  onRenameProject: (workspace: Workspace) => void;
  onCleanupSessions: (workspace: Workspace) => void;
  onRemoveProject: (workspace: Workspace) => void;
  onRenameSession: (workspaceId: string, session: SessionSummary) => void;
  onForkSession: (workspaceId: string, session: SessionSummary) => void;
  onDeleteSession: (workspaceId: string, session: SessionSummary) => void;
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
          <button type="button" className="action-sheet-item" onClick={() => props.onRenameProject(target.workspace)}><Pencil size={18} />重命名项目</button>
          <button type="button" className="action-sheet-item danger" disabled={props.cleanupDisabled === true} onClick={() => props.onCleanupSessions(target.workspace)}><Eraser size={18} />清理会话</button>
          <button type="button" className="action-sheet-item danger" onClick={() => props.onRemoveProject(target.workspace)}><Trash2 size={18} />移除项目</button>
        </> : target?.kind === "session" ? <>
          <button type="button" className="action-sheet-item" onClick={() => props.onRenameSession(target.workspaceId, target.session)}><Pencil size={18} />重命名会话</button>
          <button type="button" className="action-sheet-item" onClick={() => props.onForkSession(target.workspaceId, target.session)}><GitBranch size={18} />创建分支</button>
          <button type="button" className="action-sheet-item danger" disabled={target.session.runState !== "idle"} onClick={() => props.onDeleteSession(target.workspaceId, target.session)}><Trash2 size={18} />删除会话</button>
        </> : null}
        <DialogPrimitive.Close asChild><button type="button" className="action-sheet-cancel">取消</button></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
