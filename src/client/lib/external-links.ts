/** 相对当前页是否为站外 http(s) 链接。 */
export function isExternalHttpUrl(href: string, pageOrigin: string): boolean {
  try {
    const url = new URL(href, pageOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.origin !== new URL(pageOrigin).origin;
  } catch {
    return false;
  }
}

export function shouldOpenExternalLink(event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">, href: string | null, hasDownload: boolean, pageOrigin: string, desktopShell = false): boolean {
  if (event.defaultPrevented || event.altKey || hasDownload) return false;
  if (href === null || href === "" || href.startsWith("#")) return false;
  if (!isExternalHttpUrl(href, pageOrigin)) return false;
  if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) return true;
  return desktopShell && (event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey);
}

/** 捕获页内外链点击，避免桌面壳把 Jarvis 窗口导航走。 */
export function installExternalLinkHandler(open: (url: string) => void, desktopShell = false): () => void {
  const onClick = (event: MouseEvent) => {
    const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (anchor === undefined) return;
    const href = anchor.getAttribute("href");
    if (!shouldOpenExternalLink(event, href, anchor.hasAttribute("download"), window.location.origin, desktopShell) || href === null) return;
    event.preventDefault();
    event.stopPropagation();
    open(new URL(href, window.location.href).href);
  };
  document.addEventListener("click", onClick, true);
  document.addEventListener("auxclick", onClick, true);
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("auxclick", onClick, true);
  };
}
