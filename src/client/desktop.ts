import { isDesktopShell } from "./lib/desktop-shell";

export { isDesktopShell };

export async function setDesktopNotificationEnabled(enabled: boolean): Promise<void> {
  if (!isDesktopShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_notifications_enabled", { enabled });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isDesktopShell()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_external_url", { url });
    return;
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

export function listenDesktopCheckUpdate(handler: () => void): { stop: () => void; ready: Promise<void> } {
  if (!isDesktopShell()) return { stop: () => undefined, ready: Promise.resolve() };
  let disposed = false;
  let unlisten: (() => void) | undefined;
  const ready = import("@tauri-apps/api/event").then(async ({ listen }) => {
    if (disposed) return;
    const fn = await listen("jarvis://check-update", () => handler());
    if (disposed) {
      fn();
      return;
    }
    unlisten = fn;
  }).then(() => undefined, () => undefined);
  return {
    ready,
    stop: () => {
      disposed = true;
      unlisten?.();
    },
  };
}

export async function showDesktopWindow(): Promise<void> {
  if (!isDesktopShell()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  await window.show();
  await window.unminimize();
  await window.setFocus();
}
