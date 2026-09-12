import { useEffect, useRef } from "react";
import { Copy, FileText, Folder, Trash2 } from "lucide-react";

export interface FileContextMenuTarget {
  name: string;
  path: string;
  kind: "directory" | "file";
  x: number;
  y: number;
}

interface FileContextMenuProps {
  target: FileContextMenuTarget;
  onClose: () => void;
  onCopy: (value: string, message: string) => void;
  onDelete: (target: FileContextMenuTarget) => void;
  fullPath: string;
}

const MENU_WIDTH = 210;
const MENU_HEIGHT = 176;
const VIEWPORT_GUTTER = 8;

export function FileContextMenu({ target, onClose, onCopy, onDelete, fullPath }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const left = Math.max(VIEWPORT_GUTTER, Math.min(target.x, window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER));
  const top = Math.max(VIEWPORT_GUTTER, Math.min(target.y, window.innerHeight - MENU_HEIGHT - VIEWPORT_GUTTER));
  const Icon = target.kind === "directory" ? Folder : FileText;

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

  return <div ref={menuRef} className="context-menu file-context-menu" role="menu" aria-label="文件操作" tabIndex={-1} style={{ left, top }} onContextMenu={(event) => event.preventDefault()}>
    <div className="file-context-menu-target"><Icon size={14} /><span title={target.path}>{target.name}</span></div>
    <button className="context-menu-item" type="button" role="menuitem" onClick={() => onCopy(target.name, "已复制文件名")}><Copy size={14} /><span>复制文件名</span></button>
    <button className="context-menu-item" type="button" role="menuitem" onClick={() => onCopy(target.path, "已复制路径")}><Copy size={14} /><span>复制路径</span></button>
    <button className="context-menu-item" type="button" role="menuitem" onClick={() => onCopy(fullPath, "已复制全路径")}><Copy size={14} /><span>复制全路径</span></button>
    <button className="context-menu-item danger" type="button" role="menuitem" onClick={() => onDelete(target)}><Trash2 size={14} /><span>{target.kind === "directory" ? "删除目录" : "删除文件"}</span></button>
  </div>;
}
