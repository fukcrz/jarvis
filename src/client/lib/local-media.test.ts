import { describe, expect, it } from "vitest";
import { localMediaUrl } from "./local-media";

describe("localMediaUrl", () => {
  it("adds a stable version without changing the file path, directory, or fragment", () => {
    const source = "/api/files?path=C%3A%5Cshots%5Chello%20world.png&cwd=D%3A%5Cworkspace#preview";
    const refreshed = localMediaUrl(source, "opened");
    const url = new URL(refreshed, "http://jarvis.local");
    expect(url.searchParams.get("path")).toBe("C:\\shots\\hello world.png");
    expect(url.searchParams.get("cwd")).toBe("D:\\workspace");
    expect(url.hash).toBe("#preview");
    expect(url.searchParams.get("v")).toBe("opened");
    expect(localMediaUrl(refreshed, "opened")).toBe(refreshed);
  });

  it("replaces the old version while preserving other query parameters", () => {
    const url = new URL(localMediaUrl("/api/files?path=shot.png&download=1&v=old", "new"), "http://jarvis.local");
    expect(url.searchParams.getAll("v")).toEqual(["new"]);
    expect(url.searchParams.get("download")).toBe("1");
    expect(url.searchParams.get("path")).toBe("shot.png");
  });

  it("leaves unversioned URLs, remote images, embedded media, and snapshots unchanged", () => {
    expect(localMediaUrl("/api/files?path=shot.png", undefined)).toBe("/api/files?path=shot.png");
    for (const source of [
      "https://example.com/shot.png?version=1",
      "//example.com/api/files?path=shot.png",
      "data:image/png;base64,AAAA",
      "blob:http://localhost/image",
      "/api/workspaces/ws/sessions/session/media/tool/0",
      "/api/files-extra?path=shot.png",
    ]) {
      expect(localMediaUrl(source, "refresh")).toBe(source);
    }
  });
});
