/**
 * 文本复制。默认走 Clipboard API。
 * 仅 Linux Firefox 先用 execCommand：该环境 writeText 经常不可用。
 */
export function copyText(text: string): Promise<void> {
  if (isLinuxFirefox() && copyTextWithExecCommand(text)) return Promise.resolve();
  const writeText = globalThis.navigator?.clipboard?.writeText;
  if (writeText === undefined) return Promise.reject(new Error("clipboard"));
  return writeText.call(globalThis.navigator.clipboard, text);
}

function isLinuxFirefox(): boolean {
  const nav = globalThis.navigator;
  if (nav === undefined) return false;
  const ua = nav.userAgent ?? "";
  if (!ua.includes("Firefox/") || /Android/i.test(ua)) return false;
  return /Linux/i.test(nav.platform ?? "") || /Linux/i.test(ua);
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
