import * as DialogPrimitive from "@radix-ui/react-dialog";
import { MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";

export type MobileActionTarget = { kind: "project"; workspace: Workspace } | { kind: "session"; workspaceId: string; session: SessionSummary };

interface MobileActionSheetProps {
  target?: MobileActionTarget;
  onClose: () => void;
  onCreateSession: (workspace: Workspace) => void;
  onRenameProject: (workspace: Workspace) => void;
  onRemoveProject: (workspace: Workspace) => void;
  onRenameSession: (workspaceId: string, session: SessionSummary) => void;
  onDeleteSession: (workspaceId: string, session: SessionSummary) => void;
}

export function MobileActionSheet(props: MobileActionSheetProps) {
  const target = props.target;
  return <DialogPrimitive.Root open={target !== undefined} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="action-sheet-overlay" />
      <DialogPrimitive.Content className="action-sheet" aria-label={target?.kind === "project" ? "Project actions" : "Session actions"}>
        <DialogPrimitive.Title className="action-sheet-title">{target?.kind === "project" ? target.workspace.label : target === undefined ? "" : target.session.name ?? "Session"}</DialogPrimitive.Title>
        {target?.kind === "project" ? <>
          <button type="button" className="action-sheet-item" onClick={() => props.onCreateSession(target.workspace)}><MessageSquarePlus size={18} />New session</button>
          <button type="button" className="action-sheet-item" onClick={() => props.onRenameProject(target.workspace)}><Pencil size={18} />Rename project</button>
          <button type="button" className="action-sheet-item danger" onClick={() => props.onRemoveProject(target.workspace)}><Trash2 size={18} />Remove project</button>
        </> : target?.kind === "session" ? <>
          <button type="button" className="action-sheet-item" onClick={() => props.onRenameSession(target.workspaceId, target.session)}><Pencil size={18} />Rename session</button>
          <button type="button" className="action-sheet-item danger" disabled={target.session.runState !== "idle"} onClick={() => props.onDeleteSession(target.workspaceId, target.session)}><Trash2 size={18} />Delete session</button>
        </> : null}
        <DialogPrimitive.Close asChild><button type="button" className="action-sheet-cancel">Cancel</button></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
