/**
 * 文本复制。Firefox / 局域网 HTTP 没有 Clipboard API（非安全上下文），
 * writeText 会直接失败；execCommand 仍能在点击手势里工作。
 * 先同步 execCommand，失败再走 writeText。
 */
export function copyText(text: string): Promise<void> {
  if (copyTextWithExecCommand(text)) return Promise.resolve();
  const writeText = globalThis.navigator?.clipboard?.writeText;
  if (writeText === undefined) return Promise.reject(new Error("clipboard"));
  return writeText.call(globalThis.navigator.clipboard, text);
}

function copyTextWithExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function" || document.body === null) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;padding:0;border:0;outline:none;box-shadow:none;background:transparent;";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    // 部分浏览器会直接抛错
  }
  textarea.remove();
  return ok;
}
