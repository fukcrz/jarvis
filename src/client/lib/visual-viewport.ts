/** 超过这个差值才当成键盘 inset；地址栏收起通常远小于此。 */
export const KEYBOARD_INSET_THRESHOLD_PX = 100;

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url", "password", "number"]);
const RESUME_RETRY_MS = [50, 250];

let keyboardInsetLocked = false;
const viewportListeners = new Set<() => void>();

export function isTextEditingElement(element: unknown): boolean {
  if (element === null || typeof element !== "object") return false;
  const candidate = element as {
    isContentEditable?: boolean;
    tagName?: string;
    type?: string;
    readOnly?: boolean;
    disabled?: boolean;
  };
  if (candidate.isContentEditable === true) return true;
  if (candidate.readOnly === true || candidate.disabled === true) return false;
  const tag = typeof candidate.tagName === "string" ? candidate.tagName.toUpperCase() : "";
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = typeof candidate.type === "string" && candidate.type !== "" ? candidate.type.toLowerCase() : "text";
  return TEXT_INPUT_TYPES.has(type);
}

export function resolveVisualViewportHeight(input: {
  visualHeight: number;
  innerHeight: number;
  editing: boolean;
  locked?: boolean;
  closedHeight?: number;
}): { height: number; closedHeight: number } {
  const visualHeight = finiteHeight(input.visualHeight);
  const innerHeight = finiteHeight(input.innerHeight);
  const height = visualHeight ?? innerHeight ?? 0;
  const closed = finiteHeight(input.closedHeight ?? 0) ?? 0;
  const layout = Math.max(closed, innerHeight ?? 0, height);
  const inset = layout - height;
  if (inset <= KEYBOARD_INSET_THRESHOLD_PX) {
    return { height, closedHeight: Math.max(closed, height, innerHeight ?? 0) };
  }
  if (!input.editing || input.locked === true) return { height: layout, closedHeight: closed };
  return { height, closedHeight: closed };
}

function finiteHeight(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function emitViewportListeners() {
  for (const listener of viewportListeners) listener();
}

/** 选图期间锁定：即便 iOS 把焦点还回编辑器，也不再用残留的键盘高度。 */
export function lockVisualViewportKeyboardInset() {
  keyboardInsetLocked = true;
  emitViewportListeners();
}

/** 用户再次点输入框准备打字时解除锁定，让键盘 inset 重新生效。 */
export function unlockVisualViewportKeyboardInset() {
  if (!keyboardInsetLocked) return;
  keyboardInsetLocked = false;
  emitViewportListeners();
}

export function isVisualViewportKeyboardInsetLocked(): boolean {
  return keyboardInsetLocked;
}

/** 把可见视口高度写到 :root 的 --vvh。iOS 选图后 visualViewport 常停在键盘高度。 */
export function installVisualViewportHeight(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (view === null) return () => {};
  const visualViewport = view.visualViewport;
  if (visualViewport === null) return () => {};
  const root = doc.documentElement;
  const retryTimers: number[] = [];
  let closedHeight = 0;

  const update = () => {
    const resolved = resolveVisualViewportHeight({
      visualHeight: visualViewport.height,
      innerHeight: view.innerHeight,
      editing: isTextEditingElement(doc.activeElement),
      locked: keyboardInsetLocked,
      closedHeight,
    });
    closedHeight = resolved.closedHeight;
    root.style.setProperty("--vvh", `${String(resolved.height)}px`);
  };

  const clearRetries = () => {
    for (const timer of retryTimers) view.clearTimeout(timer);
    retryTimers.length = 0;
  };

  const updateAndRetry = () => {
    update();
    clearRetries();
    for (const delay of RESUME_RETRY_MS) {
      retryTimers.push(view.setTimeout(update, delay));
    }
  };

  const onWindowResize = () => {
    closedHeight = 0;
    update();
  };

  update();
  viewportListeners.add(update);
  visualViewport.addEventListener("resize", update);
  visualViewport.addEventListener("scroll", update);
  view.addEventListener("resize", onWindowResize);
  view.addEventListener("focus", updateAndRetry);
  view.addEventListener("pageshow", updateAndRetry);
  doc.addEventListener("visibilitychange", updateAndRetry);
  doc.addEventListener("focusin", update);
  doc.addEventListener("focusout", update);
  return () => {
    viewportListeners.delete(update);
    visualViewport.removeEventListener("resize", update);
    visualViewport.removeEventListener("scroll", update);
    view.removeEventListener("resize", onWindowResize);
    view.removeEventListener("focus", updateAndRetry);
    view.removeEventListener("pageshow", updateAndRetry);
    doc.removeEventListener("visibilitychange", updateAndRetry);
    doc.removeEventListener("focusin", update);
    doc.removeEventListener("focusout", update);
    clearRetries();
  };
}
