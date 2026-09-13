/** 会自己接管点击的全屏浮层。这些还在时不能清 body 的 pointer-events。 */
const BLOCKING_OVERLAY_SELECTOR = [
  "[data-radix-dialog-overlay]",
  ".dialog-overlay",
  ".file-browser-overlay",
  ".image-lightbox",
  ".auth-operation-overlay",
  ".action-sheet-overlay",
].join(", ");
const TOUCH_FOCUS_SELECTOR = 'a, button, summary, [role="button"]';
const TEXT_ENTRY_SELECTOR = "input, textarea, select";
const TOUCH_FOCUS_RETRY_MS = 32;

export function hasBlockingOverlay(root: ParentNode = document): boolean {
  return root.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null;
}

/** Radix Dialog 卸载时可能把 body 留在 pointer-events: none。没有浮层时清掉。 */
export function restoreBodyPointerEventsIfIdle(doc: Document = document): boolean {
  if (doc.body.style.pointerEvents !== "none") return false;
  if (hasBlockingOverlay(doc)) return false;
  doc.body.style.pointerEvents = "";
  return true;
}

export function installBodyPointerEventsGuard(doc: Document = document): () => void {
  const restore = () => { restoreBodyPointerEventsIfIdle(doc); };
  const view = doc.defaultView;
  doc.addEventListener("pointerdown", restore, true);
  view?.addEventListener("focus", restore);
  doc.addEventListener("visibilitychange", restore);
  return () => {
    doc.removeEventListener("pointerdown", restore, true);
    view?.removeEventListener("focus", restore);
    doc.removeEventListener("visibilitychange", restore);
  };
}

function isTouchLikePointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

function isTextEntry(element: Element): boolean {
  return ("isContentEditable" in element && element.isContentEditable === true)
    || ("matches" in element && typeof element.matches === "function" && element.matches(TEXT_ENTRY_SELECTOR));
}

function asElement(target: EventTarget | null): Element | null {
  if (target === null || typeof target !== "object") return null;
  const candidate = target as { nodeType?: number; parentElement?: EventTarget | null; closest?: unknown };
  if (candidate.nodeType === 3) return asElement(candidate.parentElement ?? null);
  return typeof candidate.closest === "function" ? target as Element : null;
}

function resolveTouchFocusTarget(eventTarget: EventTarget | null): Element | null {
  return asElement(eventTarget)?.closest(TOUCH_FOCUS_SELECTOR) ?? null;
}

/** 触摸结束后清掉控件焦点，避免 :focus-visible / :focus-within 留下桌面态。 */
export function clearTouchFocus(target: Element | null, doc: Document = document): boolean {
  const active = doc.activeElement;
  if (active === null || !("matches" in active) || typeof active.matches !== "function") return false;
  if (typeof (active as HTMLElement).blur !== "function") return false;
  if (isTextEntry(active) || !active.matches(TOUCH_FOCUS_SELECTOR)) return false;
  // 浮层还在时只清当初点到的控件，避免抢走 Radix 刚放进对话框的焦点。
  if (hasBlockingOverlay(doc) && active !== target) return false;
  (active as HTMLElement).blur();
  return true;
}

/** 在点击和 Radix 回焦之后再清一次残留焦点。 */
export function installTouchFocusGuard(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (view === null) return () => {};
  const pending = new Map<number, Element | null>();
  let releasedTarget: Element | null = null;
  let touchClickPending = false;
  const clearTimers: number[] = [];
  const scheduleClear = (target: Element | null) => {
    for (const timer of clearTimers) view.clearTimeout(timer);
    clearTimers.length = 0;
    for (const delay of [0, TOUCH_FOCUS_RETRY_MS]) {
      clearTimers.push(view.setTimeout(() => {
        clearTouchFocus(target, doc);
      }, delay));
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!isTouchLikePointer(event.pointerType)) return;
    pending.set(event.pointerId, resolveTouchFocusTarget(event.target));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!isTouchLikePointer(event.pointerType) || !pending.has(event.pointerId)) return;
    const target = pending.get(event.pointerId) ?? null;
    pending.delete(event.pointerId);
    releasedTarget = target;
    touchClickPending = true;
    scheduleClear(target);
  };
  const onClick = () => {
    if (!touchClickPending) return;
    touchClickPending = false;
    scheduleClear(releasedTarget);
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (!isTouchLikePointer(event.pointerType)) return;
    pending.delete(event.pointerId);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("pointercancel", onPointerCancel, true);
  doc.addEventListener("click", onClick, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("pointerup", onPointerUp, true);
    doc.removeEventListener("pointercancel", onPointerCancel, true);
    doc.removeEventListener("click", onClick, true);
    for (const timer of clearTimers) view.clearTimeout(timer);
    clearTimers.length = 0;
    pending.clear();
  };
}
