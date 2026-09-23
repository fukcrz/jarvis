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

/** 捕获页内外链点击，避免桌面壳把 Jarvis 窗口导航走。 */
export function installExternalLinkHandler(open: (url: string) => void): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 && event.button !== 1) return;
    const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (anchor === undefined) return;
    if (anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (href === null || href === "" || href.startsWith("#")) return;
    if (!isExternalHttpUrl(href, window.location.origin)) return;
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
