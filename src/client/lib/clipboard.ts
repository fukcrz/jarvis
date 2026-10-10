/**
 * 文本复制：优先使用 Clipboard API，失败时回退到 execCommand。
 * 回退文本框保持在视口内但完全透明，兼容 Firefox 对屏外元素的处理差异。
 */
export function copyText(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  const writeText = clipboard?.writeText;
  if (writeText !== undefined) {
    try {
      return Promise.resolve(writeText.call(clipboard, text)).catch((reason: unknown) => {
        if (copyTextWithExecCommand(text)) return;
        throw asClipboardError(reason);
      });
    } catch (reason: unknown) {
      if (copyTextWithExecCommand(text)) return Promise.resolve();
      return Promise.reject(asClipboardError(reason));
    }
  }
  if (copyTextWithExecCommand(text)) return Promise.resolve();
  return Promise.reject(new Error("clipboard"));
}

function asClipboardError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("clipboard");
}

function copyTextWithExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function" || document.body === null) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;outline:none;box-shadow:none;background:transparent;color:transparent;opacity:0;pointer-events:none;";
  try {
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
