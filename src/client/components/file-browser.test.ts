import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FilePreviewBody, parentDirectoryWithinRoot, pathBaseName } from "./file-browser";

describe("FilePreviewBody", () => {
  it("wraps images in ImagePreview without mounting the lightbox", () => {
    const markup = renderToStaticMarkup(createElement(FilePreviewBody, {
      state: { path: "/tmp/shot.png", name: "shot.png", kind: "image" },
      url: "/api/files?path=shot.png",
    }));

    expect(markup).toContain('class="file-preview-media file-preview-image"');
    expect(markup).toContain('src="/api/files?path=shot.png"');
    expect(markup).toContain('alt="shot.png"');
    expect(markup).not.toContain("image-lightbox");
  });

  it("keeps pdf, video, and audio on the media url", () => {
    const pdf = renderToStaticMarkup(createElement(FilePreviewBody, {
      state: { path: "/tmp/doc.pdf", name: "doc.pdf", kind: "pdf" },
      url: "/api/files?path=doc.pdf",
    }));
    const video = renderToStaticMarkup(createElement(FilePreviewBody, {
      state: { path: "/tmp/clip.mp4", name: "clip.mp4", kind: "video" },
      url: "/api/files?path=clip.mp4",
    }));
    const audio = renderToStaticMarkup(createElement(FilePreviewBody, {
      state: { path: "/tmp/track.mp3", name: "track.mp3", kind: "audio" },
      url: "/api/files?path=track.mp3",
    }));

    expect(pdf).toContain("<iframe");
    expect(pdf).toContain('src="/api/files?path=doc.pdf"');
    expect(video).toContain("<video");
    expect(video).toContain('src="/api/files?path=clip.mp4"');
    expect(audio).toContain("<audio");
    expect(audio).toContain('src="/api/files?path=track.mp3"');
  });
});

describe("parentDirectoryWithinRoot", () => {
  it("stays inside the project root", () => {
    expect(parentDirectoryWithinRoot("/ws/src/app.ts", "/ws")).toBe("/ws/src");
    expect(parentDirectoryWithinRoot("/ws/src", "/ws")).toBe("/ws");
    expect(parentDirectoryWithinRoot("/ws", "/ws")).toBeUndefined();
    expect(parentDirectoryWithinRoot("/other/app.ts", "/ws")).toBeUndefined();
    expect(parentDirectoryWithinRoot("/ws-other/app.ts", "/ws")).toBeUndefined();
  });
});

describe("pathBaseName", () => {
  it("returns the last path segment", () => {
    expect(pathBaseName("/ws/docs")).toBe("docs");
    expect(pathBaseName("/ws/docs/")).toBe("docs");
    expect(pathBaseName("C:\\ws\\docs\\")).toBe("docs");
    expect(pathBaseName("docs")).toBe("docs");
    expect(pathBaseName("/")).toBe("/");
    expect(pathBaseName("")).toBe("");
  });
});
