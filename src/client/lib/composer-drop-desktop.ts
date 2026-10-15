import { isFileDrag } from "./composer-drop";
import { isDesktopShell } from "./desktop-shell";

interface DropTarget {
  element: HTMLElement;
  acceptPaths: (paths: string[]) => void;
  setDropHighlight: (active: boolean) => void;
}

interface DragPosition {
  x: number;
  y: number;
  toLogical?: (scaleFactor: number) => { x: number; y: number };
}

const targets = new Set<DropTarget>();
let unlisten: (() => void) | undefined;
let listening = false;
let guardInstalled = false;

function installFileDragGuard(): void {
  if (guardInstalled || typeof document === "undefined") return;
  guardInstalled = true;
  const preventNavigation = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (types === undefined || !isFileDrag(types)) return;
    event.preventDefault();
  };
  document.addEventListener("dragover", preventNavigation, true);
  document.addEventListener("drop", preventNavigation, true);
}

export function registerComposerDropTarget(element: HTMLElement, target: Omit<DropTarget, "element">): () => void {
  installFileDragGuard();
  const registered: DropTarget = { element, ...target };
  targets.add(registered);
  if (isDesktopShell()) void ensureDesktopListener();
  return () => {
    targets.delete(registered);
    registered.setDropHighlight(false);
    if (targets.size === 0) stopDesktopListener();
  };
}

function highlight(active: DropTarget | undefined): void {
  for (const target of targets) target.setDropHighlight(target === active);
}

function targetAt(x: number, y: number): DropTarget | undefined {
  const hit = document.elementFromPoint(x, y)?.closest(".composer-editor");
  if (hit instanceof HTMLElement) {
    for (const target of targets) if (target.element === hit) return target;
  }
  for (const target of targets) {
    const rect = target.element.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return target;
  }
  return undefined;
}

function logicalPoint(position: DragPosition): { x: number; y: number } {
  const scale = window.devicePixelRatio || 1;
  return position.toLogical?.(scale) ?? { x: position.x / scale, y: position.y / scale };
}

async function ensureDesktopListener(): Promise<void> {
  if (listening || unlisten !== undefined || !isDesktopShell()) return;
  listening = true;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    if (targets.size === 0) return;
    unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") {
        highlight(undefined);
        return;
      }
      const point = logicalPoint(payload.position);
      const hit = targetAt(point.x, point.y);
      if (payload.type === "drop") {
        highlight(undefined);
        if (hit !== undefined && payload.paths.length > 0) hit.acceptPaths(payload.paths);
        return;
      }
      highlight(hit);
    });
  } catch {
    unlisten = undefined;
  } finally {
    listening = false;
    if (targets.size === 0) stopDesktopListener();
  }
}

function stopDesktopListener(): void {
  unlisten?.();
  unlisten = undefined;
}
