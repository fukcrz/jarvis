import { useEffect, useRef } from "react";
import { GitBranch, Pencil, Star, Trash2 } from "lucide-react";
import type { SessionSummary } from "../../shared/protocol";
import { isEmptySession } from "../lib/utils";

export interface SessionContextMenuTarget {
  workspaceId: string;
  session: SessionSummary;
  x: number;
  y: number;
}

interface SessionContextMenuProps {
  target: SessionContextMenuTarget;
  onClose: () => void;
  onStar: (target: SessionContextMenuTarget) => void;
  onFork: (target: SessionContextMenuTarget) => void;
  onRename: (target: SessionContextMenuTarget) => void;
  onDelete: (target: SessionContextMenuTarget) => void;
}

const MENU_WIDTH = 196;
const MENU_ITEM_HEIGHT = 37;
const MENU_PADDING = 8;
const VIEWPORT_GUTTER = 8;

export function SessionContextMenu({ target, onClose, onStar, onFork, onRename, onDelete }: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const empty = isEmptySession(target.session);
  const itemCount = empty ? 1 : 4;
  const menuHeight = MENU_PADDING + itemCount * MENU_ITEM_HEIGHT;
  const left = Math.max(VIEWPORT_GUTTER, Math.min(target.x, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER));
  const top = Math.max(VIEWPORT_GUTTER, Math.min(target.y, window.innerHeight - menuHeight - VIEWPORT_GUTTER));
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
      {empty ? null : <button className="context-menu-item" type="button" role="menuitem" onClick={() => onStar(target)}><Star size={14} fill={target.session.starred === true ? "currentColor" : "none"} /><span>{target.session.starred === true ? "取消收藏" : "收藏"}</span></button>}
      {empty ? null : <button className="context-menu-item" type="button" role="menuitem" onClick={() => onFork(target)}><GitBranch size={14} /><span>创建分支</span></button>}
      {empty ? null : <button className="context-menu-item" type="button" role="menuitem" onClick={() => onRename(target)}><Pencil size={14} /><span>重命名会话</span></button>}
      <button className="context-menu-item danger" type="button" role="menuitem" disabled={busy} title={busy ? "请先停止此会话再删除" : undefined} onClick={() => onDelete(target)}>
        <Trash2 size={14} />
        <span>删除会话</span>
      </button>
    </div>
  );
}
