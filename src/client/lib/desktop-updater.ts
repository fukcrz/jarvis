import { Channel, Resource, invoke } from "@tauri-apps/api/core";
import { updateNotes } from "./desktop-update";

export interface DownloadProgress {
  received: number;
  total?: number;
}

export interface AvailableUpdate {
  readonly version: string;
  readonly currentVersion: string;
  readonly notes?: string;
  readonly downloaded: boolean;
  download(onProgress: (progress: DownloadProgress) => void): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}

interface UpdateMetadata {
  rid: number;
  currentVersion: string;
  version: string;
  body?: string | null;
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** 与 tauri-plugin-updater 2.12 的 check / download / install 命令对应。 */
export async function checkDesktopUpdate(): Promise<AvailableUpdate | null> {
  const metadata = await invoke<UpdateMetadata | null>("plugin:updater|check");
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata.rid !== "number" || typeof metadata.version !== "string") throw new Error("更新信息不完整");
  return new DesktopUpdate(metadata);
}

export async function relaunchDesktop(): Promise<void> {
  await invoke("plugin:process|restart");
}

export async function desktopSessionRunCount(): Promise<number> {
  const response = await fetch("/api/health");
  if (!response.ok) throw new Error("无法确认任务状态");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("running" in body)) return 0;
  const running = body.running;
  return typeof running === "number" && running > 0 ? running : 0;
}

class DesktopUpdate implements AvailableUpdate {
  readonly version: string;
  readonly currentVersion: string;
  readonly notes?: string;
  downloaded = false;
  private readonly resource: Resource;
  private bytes?: Resource;

  constructor(metadata: UpdateMetadata) {
    this.resource = new Resource(metadata.rid);
    this.version = metadata.version;
    this.currentVersion = typeof metadata.currentVersion === "string" ? metadata.currentVersion : "";
    this.notes = updateNotes(metadata.body);
  }

  async download(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    await this.bytes?.close().catch(() => undefined);
    this.bytes = undefined;
    this.downloaded = false;
    let received = 0;
    let total: number | undefined;
    const onEvent = new Channel<DownloadEvent>((event) => {
      if (event.event === "Started") {
        const length = event.data.contentLength;
        total = length !== undefined && length > 0 ? length : undefined;
        onProgress({ received, total });
        return;
      }
      if (event.event === "Progress") {
        received += event.data.chunkLength;
        onProgress({ received, total });
      }
    });
    const bytesRid = await invoke<number>("plugin:updater|download", { rid: this.resource.rid, onEvent });
    this.bytes = new Resource(bytesRid);
    this.downloaded = true;
  }

  async install(): Promise<void> {
    if (this.bytes === undefined) throw new Error("更新包还没下载完成");
    await invoke("plugin:updater|install", { updateRid: this.resource.rid, bytesRid: this.bytes.rid });
  }

  async close(): Promise<void> {
    await this.bytes?.close().catch(() => undefined);
    this.bytes = undefined;
    this.downloaded = false;
    await this.resource.close().catch(() => undefined);
  }
}
