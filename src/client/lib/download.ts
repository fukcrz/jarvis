import { notifyUnauthorized } from "../api";
import { isDesktopShell } from "./desktop-shell";

/**
 * 下载能力的唯一出口。
 *
 * 桌面壳里浏览器自带的下载 UI 被关掉了，所有下载都由壳接管：先落临时目录，
 * 下载完成后弹原生「另存为」。组件只需要调用 `saveDownload` / `saveBlob`，
 * 不要自己拼 `<a download>`，也不要判断当前是不是桌面壳。
 */

export class DownloadError extends Error {}

const PREFLIGHT_TIMEOUT_MS = 15_000;

/**
 * 下载前确认目标真能下：401 交给登录流程，其余非 2xx、以及没有附件头的响应直接报错。
 * `/api/files` 支持 Range，只取 1 字节；其它接口用 HEAD，不会把响应体拉两遍。
 * 416 表示文件存在但是 0 字节（`bytes=0-0` 对空文件不成立），照样可以下。
 */
export async function preflightDownload(url: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!url.startsWith("/api/")) return;
  const ranged = url.startsWith("/api/files");
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, PREFLIGHT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, ranged
      ? { headers: { Range: "bytes=0-0" }, cache: "no-store", signal: controller.signal }
      : { method: "HEAD", cache: "no-store", signal: controller.signal });
  } catch (error) {
    throw new DownloadError(error instanceof Error && error.name === "AbortError" ? "下载超时" : "无法连接服务");
  } finally {
    clearTimeout(timer);
  }
  try {
    if (response.status === 401) {
      notifyUnauthorized();
      throw new DownloadError("登录已失效，请重新登录后重试");
    }
    if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
      throw new DownloadError(await failureMessage(response));
    }
    // 服务端的错误响应没有附件头，据此把「错误页」和「真的文件」区分开。
    const disposition = (response.headers.get("content-disposition") ?? "").toLowerCase();
    if (response.status !== 416 && !disposition.includes("attachment")) throw new DownloadError("这个文件没有响应内容");
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** 把服务端错误体里的说明带出来，否则用户只看到一个状态码。 */
async function failureMessage(response: Response): Promise<string> {
  const status = `无法下载（${response.status}）`;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    const message = (parsed as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" && message !== "" ? `${status}：${message}` : status;
  } catch {
    return status;
  }
}

/** 触发一次浏览器原生下载；桌面壳会把它接管成「下载完成 → 另存为」。 */
export function startNativeDownload(url: string, fileName?: string): void {
  if (typeof document === "undefined" || document.body === null) throw new DownloadError("当前环境不支持下载");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName ?? "";
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** 下载服务端的文件。桌面壳里会先预检，避免把 401/404 的错误页当文件存下来。 */
export async function saveDownload(url: string, fileName?: string): Promise<void> {
  if (isDesktopShell()) await preflightDownload(url);
  startNativeDownload(url, fileName);
}

/** 保存内存里的 Blob（导出图片等）；桌面壳同样走引擎的另存为。 */
export function saveBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  try {
    startNativeDownload(objectUrl, fileName);
  } finally {
    // 大文件在壳里要先落盘再弹另存为，释放太早会让下载中途失败。
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}
