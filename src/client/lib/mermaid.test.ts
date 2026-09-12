import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareMermaidSvgForExport, writeDiagramClipboard } from "./mermaid";

describe("prepareMermaidSvgForExport", () => {
  it("adds svg namespaces and strips the xml declaration", () => {
    const svg = '<?xml version="1.0"?><svg viewBox="0 0 10 10"><rect /></svg>';
    expect(prepareMermaidSvgForExport(svg)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><rect /></svg>',
    );
  });

  it("keeps existing namespaces", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="8"><g /></svg>';
    expect(prepareMermaidSvgForExport(svg)).toBe(svg);
  });

  it("rejects markup without an svg root", () => {
    expect(() => prepareMermaidSvgForExport("<div />")).toThrow("invalid svg");
  });
});

describe("writeDiagramClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes png when ClipboardItem is available", async () => {
    const write = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    });
    const png = new Blob(["png"], { type: "image/png" });
    await expect(writeDiagramClipboard("<svg />", png)).resolves.toBe("png");
    expect(write).toHaveBeenCalledTimes(1);
    const payload = write.mock.calls[0]?.[0] as Array<{ items: Record<string, Blob> }>;
    expect(payload[0]?.items["image/png"]).toBe(png);
  });

  it("falls back to svg text when image write is unavailable", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("ClipboardItem", undefined);
    await expect(writeDiagramClipboard("<svg />")).resolves.toBe("svg");
    expect(writeText).toHaveBeenCalledWith("<svg />");
  });

  it("falls back to svg text when png write rejects", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      clipboard: {
        write: vi.fn(async () => { throw new Error("denied"); }),
        writeText,
      },
    });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    });
    await expect(writeDiagramClipboard("<svg />", new Blob(["png"], { type: "image/png" }))).resolves.toBe("svg");
    expect(writeText).toHaveBeenCalledWith("<svg />");
  });
});
