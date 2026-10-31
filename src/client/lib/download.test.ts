import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadError, preflightDownload } from "./download";
import { UNAUTHORIZED_EVENT } from "../api";

function response(body: string, init: { status: number; headers?: Record<string, string> }): Response {
  return new Response(body, { status: init.status, headers: init.headers });
}

describe("preflightDownload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("附件响应直接通过", async () => {
    const fetchImpl = vi.fn(async () => response("x", { status: 206, headers: { "content-disposition": "attachment; filename*=UTF-8''a.md" } }));
    await expect(preflightDownload("/api/files?path=a.md&download=1", fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it("401 触发重新登录并给出提示", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const fetchImpl = vi.fn(async () => response("{}", { status: 401 }));
    await expect(preflightDownload("/api/files?path=a.md&download=1", fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(DownloadError);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0]![0] as Event).type).toBe(UNAUTHORIZED_EVENT);
  });

  it("404 不弹登录，直接报错", async () => {
    const fetchImpl = vi.fn(async () => response("{}", { status: 404 }));
    await expect(preflightDownload("/api/files?path=missing&download=1", fetchImpl as unknown as typeof fetch)).rejects.toThrow("404");
  });

  it("没有附件头的错误页不当文件存", async () => {
    const fetchImpl = vi.fn(async () => response("{\"error\":1}", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(preflightDownload("/api/files?path=a&download=1", fetchImpl as unknown as typeof fetch)).rejects.toThrow("没有响应内容");
  });

  it("站外链接不做预检", async () => {
    const fetchImpl = vi.fn();
    await preflightDownload("https://example.com/a.zip", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("0 字节文件的 416 不算失败", async () => {
    // /api/files 对空文件回 416（bytes=0-0 不成立），这种文件照样能下。
    const fetchImpl = vi.fn(async () => response("", { status: 416 }));
    await expect(preflightDownload("/api/files?path=empty.md&download=1", fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it("/api/files 之外的接口用 HEAD 预检，不拉整个响应体", async () => {
    const fetchImpl = vi.fn(async () => response("", { status: 200, headers: { "content-disposition": "attachment; filename=d.zip" } }));
    await preflightDownload("/api/system/diagnostics", fetchImpl as unknown as typeof fetch);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("HEAD");
    expect(init.headers).toBeUndefined();
  });

  it("错误里带上服务端说明", async () => {
    const fetchImpl = vi.fn(async () => response(JSON.stringify({ error: { code: "FILE_NOT_FOUND", message: "文件不存在" } }), { status: 404 }));
    await expect(preflightDownload("/api/files?path=missing&download=1", fetchImpl as unknown as typeof fetch)).rejects.toThrow("文件不存在");
  });
});
