import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

const SIDE_CHAT_WIDTH_STORAGE_KEY = "jarvis.side-chat.width";
const SIDE_CHAT_DEFAULT_WIDTH = 440;
export const SIDE_CHAT_MIN_WIDTH = 280;
export const SIDE_CHAT_MAX_WIDTH = 720;

interface SideChatResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export function useSideChatResize(): {
  sideChatWidth: number;
  sideChatResizing: boolean;
  startSideChatResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  resizeSideChatWithKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  stopSideChatResize: (pointerId?: number) => void;
} {
  const [sideChatWidth, setSideChatWidth] = useState(() => readSideChatWidth());
  const [sideChatResizing, setSideChatResizing] = useState(false);
  const resizeRef = useRef<SideChatResizeState | undefined>(undefined);
  const widthRef = useRef(sideChatWidth);
  widthRef.current = sideChatWidth;

  const stopSideChatResize = useCallback((pointerId?: number) => {
    const resize = resizeRef.current;
    if (resize === undefined || (pointerId !== undefined && resize.pointerId !== pointerId)) return;
    resizeRef.current = undefined;
    persistSideChatWidth(widthRef.current);
    setSideChatResizing(false);
    document.body.classList.remove("side-chat-resizing");
  }, []);

  const startSideChatResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType === "touch" || resizeRef.current !== undefined) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: widthRef.current };
    setSideChatResizing(true);
    document.body.classList.add("side-chat-resizing");
  };

  const resizeSideChatWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = 16;
    const nextWidth = event.key === "ArrowLeft"
      ? clampSideChatWidth(widthRef.current + step)
      : event.key === "ArrowRight"
        ? clampSideChatWidth(widthRef.current - step)
        : event.key === "Home"
          ? SIDE_CHAT_MIN_WIDTH
          : event.key === "End"
            ? SIDE_CHAT_MAX_WIDTH
            : undefined;
    if (nextWidth === undefined) return;
    event.preventDefault();
    widthRef.current = nextWidth;
    setSideChatWidth((current) => current === nextWidth ? current : nextWidth);
    persistSideChatWidth(nextWidth);
  };

  useEffect(() => {
    const onPointerMove = (event: globalThis.PointerEvent) => {
      const resize = resizeRef.current;
      if (resize === undefined || event.pointerId !== resize.pointerId) return;
      event.preventDefault();
      const nextWidth = clampSideChatWidth(resize.startWidth - event.clientX + resize.startX);
      widthRef.current = nextWidth;
      setSideChatWidth((current) => current === nextWidth ? current : nextWidth);
    };
    const onPointerUp = (event: globalThis.PointerEvent) => stopSideChatResize(event.pointerId);
    const onPointerCancel = (event: globalThis.PointerEvent) => stopSideChatResize(event.pointerId);
    const onWindowBlur = () => stopSideChatResize();
    const onVisibilityChange = () => stopSideChatResize();
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
      stopSideChatResize();
    };
  }, [stopSideChatResize]);

  return { sideChatWidth, sideChatResizing, startSideChatResize, resizeSideChatWithKeyboard, stopSideChatResize };
}

function persistSideChatWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDE_CHAT_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // The panel still works for the current page when browser storage is unavailable.
  }
}

function readSideChatWidth(): number {
  try {
    const raw = window.localStorage.getItem(SIDE_CHAT_WIDTH_STORAGE_KEY);
    if (raw === null) return SIDE_CHAT_DEFAULT_WIDTH;
    const value = Number(raw);
    return Number.isFinite(value) ? clampSideChatWidth(value) : SIDE_CHAT_DEFAULT_WIDTH;
  } catch {
    return SIDE_CHAT_DEFAULT_WIDTH;
  }
}

function clampSideChatWidth(value: number): number {
  return Math.max(SIDE_CHAT_MIN_WIDTH, Math.min(SIDE_CHAT_MAX_WIDTH, value));
}
