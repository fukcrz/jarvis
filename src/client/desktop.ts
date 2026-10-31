import { isDesktopShell } from "./lib/desktop-shell";

export { isDesktopShell };

export async function setDesktopNotificationEnabled(enabled: boolean): Promise<void> {
  if (!isDesktopShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_notifications_enabled", { enabled });
}

export type DesktopUpdateChannel = "stable" | "beta";

export function isDesktopUpdateChannel(value: unknown): value is DesktopUpdateChannel {
  return value === "stable" || value === "beta";
}

export async function getDesktopUpdateChannel(): Promise<DesktopUpdateChannel | undefined> {
  if (!isDesktopShell()) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  const channel = await invoke<unknown>("get_update_channel");
  return isDesktopUpdateChannel(channel) ? channel : "stable";
}

export async function setDesktopUpdateChannel(channel: DesktopUpdateChannel): Promise<void> {
  if (!isDesktopShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_update_channel", { channel });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isDesktopShell()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_external_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** 用系统默认程序打开本地文件（桌面壳里唯一的外部打开入口）。 */
export async function openLocalPath(path: string): Promise<void> {
  if (!isDesktopShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_path", { path });
}

/** 领取桌面壳「检查更新」的结果（更新提示里用）。 */
export async function takeDesktopUpdateCheck(): Promise<boolean> {
  if (!isDesktopShell()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<boolean>("take_update_check");
}

/** 在资源管理器里定位本地文件。 */
export async function revealLocalPath(path: string, cwd?: string): Promise<void> {
  if (!isDesktopShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_file_in_folder", { path, cwd });
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
