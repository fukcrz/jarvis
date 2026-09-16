import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

const SIDEBAR_WIDTH_STORAGE_KEY = "jarvis.sidebar.width";
const SIDEBAR_DEFAULT_WIDTH = 316;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;

interface SidebarResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export function useSidebarResize(): {
  sidebarWidth: number;
  sidebarResizing: boolean;
  startSidebarResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  resizeSidebarWithKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  stopSidebarResize: (pointerId?: number) => void;
} {
  const [sidebarWidth, setSidebarWidth] = useState(() => readSidebarWidth());
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarResizeRef = useRef<SidebarResizeState | undefined>(undefined);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const stopSidebarResize = useCallback((pointerId?: number) => {
    const resize = sidebarResizeRef.current;
    if (resize === undefined || (pointerId !== undefined && resize.pointerId !== pointerId)) return;
    sidebarResizeRef.current = undefined;
    persistSidebarWidth(sidebarWidthRef.current);
    setSidebarResizing(false);
    document.body.classList.remove("sidebar-resizing");
  }, []);

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === "touch" || sidebarResizeRef.current !== undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebarWidthRef.current };
    setSidebarResizing(true);
    document.body.classList.add("sidebar-resizing");
  };

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = 16;
    const nextWidth = event.key === "ArrowLeft"
      ? clampSidebarWidth(sidebarWidthRef.current - step)
      : event.key === "ArrowRight"
        ? clampSidebarWidth(sidebarWidthRef.current + step)
        : event.key === "Home"
          ? SIDEBAR_MIN_WIDTH
          : event.key === "End"
            ? SIDEBAR_MAX_WIDTH
            : undefined;
    if (nextWidth === undefined) return;
    event.preventDefault();
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth((current) => current === nextWidth ? current : nextWidth);
    persistSidebarWidth(nextWidth);
  };

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const resize = sidebarResizeRef.current;
      if (resize === undefined || event.pointerId !== resize.pointerId) return;
      event.preventDefault();
      const nextWidth = clampSidebarWidth(resize.startWidth + event.clientX - resize.startX);
      sidebarWidthRef.current = nextWidth;
      setSidebarWidth((current) => current === nextWidth ? current : nextWidth);
    };
    const onPointerUp = (event: globalThis.PointerEvent) => stopSidebarResize(event.pointerId);
    const onPointerCancel = (event: globalThis.PointerEvent) => stopSidebarResize(event.pointerId);
    const onWindowBlur = () => stopSidebarResize();
    const onVisibilityChange = () => stopSidebarResize();
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopSidebarResize();
    };
  }, [stopSidebarResize]);

  return { sidebarWidth, sidebarResizing, startSidebarResize, resizeSidebarWithKeyboard, stopSidebarResize };
}

function persistSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // The sidebar still works for the current page when browser storage is unavailable.
  }
}

function readSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    const value = Number(raw);
    return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function clampSidebarWidth(value: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, value));
}
