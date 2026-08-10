import { useEffect, useRef } from "react";
import { MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import type { Workspace } from "../../shared/protocol";

export interface ProjectContextMenuTarget {
  workspace: Workspace;
  x: number;
  y: number;
}

interface ProjectContextMenuProps {
  target: ProjectContextMenuTarget;
  onClose: () => void;
  onCreateSession: (workspace: Workspace) => void;
  onRename: (workspace: Workspace) => void;
  onRemove: (workspace: Workspace) => void;
}

const MENU_WIDTH = 196;
const MENU_HEIGHT = 114;
const VIEWPORT_GUTTER = 8;

export function ProjectContextMenu({ target, onClose, onCreateSession, onRename, onRemove }: ProjectContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(VIEWPORT_GUTTER, Math.min(target.x, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER));
  const top = Math.max(VIEWPORT_GUTTER, Math.min(target.y, window.innerHeight - MENU_HEIGHT - VIEWPORT_GUTTER));

  useEffect(() => {
    menuRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return <div ref={menuRef} className="context-menu" role="menu" aria-label="Project actions" tabIndex={-1} style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
    <button className="context-menu-item" type="button" role="menuitem" onClick={() => onCreateSession(target.workspace)}><MessageSquarePlus size={14} /><span>New session</span></button>
    <button className="context-menu-item" type="button" role="menuitem" onClick={() => onRename(target.workspace)}><Pencil size={14} /><span>Rename project</span></button>
    <button className="context-menu-item danger" type="button" role="menuitem" onClick={() => onRemove(target.workspace)}><Trash2 size={14} /><span>Remove project</span></button>
  </div>;
}
