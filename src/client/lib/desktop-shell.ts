/** Tauri 桌面壳会在 webview 注入该标记。 */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
