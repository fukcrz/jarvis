import { useEffect, useRef } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { SessionSummary } from "../../shared/protocol";

export interface SessionContextMenuTarget {
  workspaceId: string;
  session: SessionSummary;
  x: number;
  y: number;
}

interface SessionContextMenuProps {
  target: SessionContextMenuTarget;
  onClose: () => void;
  onRename: (target: SessionContextMenuTarget) => void;
  onDelete: (target: SessionContextMenuTarget) => void;
}

const MENU_WIDTH = 196;
const MENU_HEIGHT = 78;
const VIEWPORT_GUTTER = 8;

export function SessionContextMenu({ target, onClose, onRename, onDelete }: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(VIEWPORT_GUTTER, Math.min(target.x, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER));
  const top = Math.max(VIEWPORT_GUTTER, Math.min(target.y, window.innerHeight - MENU_HEIGHT - VIEWPORT_GUTTER));
  const busy = target.session.runState !== "idle";

  useEffect(() => {
    menuRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
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

  return (
    <div ref={menuRef} className="context-menu" role="menu" aria-label="会话操作" tabIndex={-1} style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
      <button className="context-menu-item" type="button" role="menuitem" onClick={() => onRename(target)}><Pencil size={14} /><span>重命名会话</span></button>
      <button className="context-menu-item danger" type="button" role="menuitem" disabled={busy} title={busy ? "请先停止此会话再删除" : undefined} onClick={() => onDelete(target)}>
        <Trash2 size={14} />
        <span>删除会话</span>
      </button>
    </div>
  );
}
