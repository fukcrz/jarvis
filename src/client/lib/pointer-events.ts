/** 会自己接管点击的全屏浮层。这些还在时不能清 body 的 pointer-events。 */
const BLOCKING_OVERLAY_SELECTOR = [
  "[data-radix-dialog-overlay]",
  ".dialog-overlay",
  ".image-lightbox",
  ".auth-operation-overlay",
  ".action-sheet-overlay",
].join(", ");

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
