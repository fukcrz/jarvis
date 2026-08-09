import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
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
  onDelete: (target: SessionContextMenuTarget) => void;
}

const MENU_WIDTH = 196;
const MENU_HEIGHT = 42;
const VIEWPORT_GUTTER = 8;

export function SessionContextMenu({ target, onClose, onDelete }: SessionContextMenuProps) {
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
    <div ref={menuRef} className="session-context-menu" role="menu" aria-label="Session actions" tabIndex={-1} style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
      <button className="session-context-menu-item danger" type="button" role="menuitem" disabled={busy} title={busy ? "Stop this session before deleting" : undefined} onClick={() => onDelete(target)}>
        <Trash2 size={14} />
        <span>Delete session</span>
      </button>
    </div>
  );
}
