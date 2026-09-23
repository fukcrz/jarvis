import { isDesktopShell } from "./lib/desktop-shell";

export { isDesktopShell };

export async function setDesktopNotificationEnabled(enabled: boolean): Promise<void> {
  if (!isDesktopShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_notifications_enabled", { enabled });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isDesktopShell()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external_url", { url });
      return;
    } catch {
      // 旧桌面壳没有该命令时，退回新窗口。
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function listenDesktopOpenSession(handler: (workspaceId: string, sessionId: string) => void): () => void {
  if (!isDesktopShell()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    if (disposed) return undefined;
    return listen<{ workspaceId: string; sessionId: string }>("jarvis://open-session", (event) => {
      handler(event.payload.workspaceId, event.payload.sessionId);
    });
  }).then((fn) => {
    if (fn === undefined) return;
    if (disposed) {
      fn();
      return;
    }
    unlisten = fn;
  }).catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}
