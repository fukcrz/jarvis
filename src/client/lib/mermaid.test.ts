import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { canCopyDiagramImage, copyMermaidDiagram, downloadDiagramPng, normalizeMermaidSvg, prepareMermaidSvgForExport, renderMermaidDiagram, writeDiagramClipboard } from "./mermaid";

const mermaid = vi.hoisted(() => ({
  startOnLoad: true,
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaid,
}));

describe("normalizeMermaidSvg", () => {
  it("replaces percentage width with viewBox pixel size", () => {
    const svg = '<svg id="x" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 248.03px;" viewBox="0 0 248.03 167.61"><g /></svg>';
    expect(normalizeMermaidSvg(svg)).toBe(
      '<svg id="x" width="248.03" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 248.03 167.61" height="167.61"><g /></svg>',
    );
  });

  it("keeps other inline styles after stripping max-width", () => {
    const svg = '<svg width="100%" style="max-width: 10px; background: #111;" viewBox="0 0 10 8"><g /></svg>';
    expect(normalizeMermaidSvg(svg)).toBe(
      '<svg width="10" style="background: #111;" viewBox="0 0 10 8" height="8"><g /></svg>',
    );
  });

  it("leaves pixel-sized svg unchanged", () => {
    const svg = '<svg width="10" height="8" viewBox="0 0 10 8"><g /></svg>';
    expect(normalizeMermaidSvg(svg)).toBe(svg);
  });

  it("returns markup without an svg root unchanged", () => {
    expect(normalizeMermaidSvg("<div />")).toBe("<div />");
  });
});

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
    const write: Mock<(items: Array<{ items: Record<string, Blob | Promise<Blob>> }>) => Promise<void>> = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    });
    const png = new Blob(["png"], { type: "image/png" });
    await expect(writeDiagramClipboard(png)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    const payload = write.mock.calls[0]?.[0];
    expect(payload?.[0]?.items["image/png"]).toBe(png);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("writes a png promise without waiting for the blob first", async () => {
    const write: Mock<(items: Array<{ items: Record<string, Blob | Promise<Blob>> }>) => Promise<void>> = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    });
    const blob = new Blob(["png"], { type: "image/png" });
    const png = Promise.resolve(blob);
    await expect(writeDiagramClipboard(png)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    const payload = write.mock.calls[0]?.[0];
    expect(payload?.[0]?.items["image/png"]).toBe(png);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("throws when image write is unavailable", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("ClipboardItem", undefined);
    await expect(writeDiagramClipboard(new Blob(["png"], { type: "image/png" }))).rejects.toThrow("clipboard");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not write svg text when png write rejects", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      clipboard: {
        write: vi.fn(async () => { throw new Error("denied"); }),
        writeText,
      },
    });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    });
    await expect(writeDiagramClipboard(new Blob(["png"], { type: "image/png" }))).rejects.toThrow("denied");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("retries with a resolved blob if writing a promise is rejected", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const write: Mock<(items: Array<{ items: Record<string, Blob | Promise<Blob>> }>) => Promise<void>> = vi.fn(async (items) => {
      if (items[0]?.items["image/png"] instanceof Promise) throw new Error("no promise");
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    });
    await expect(writeDiagramClipboard(Promise.resolve(blob))).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]?.[0]?.items["image/png"]).toBe(blob);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not write text when the png promise rejects", async () => {
    const write = vi.fn(async () => { throw new Error("denied"); });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    });
    const png = Promise.reject(new Error("toBlob"));
    void png.catch(() => {});
    await expect(writeDiagramClipboard(png)).rejects.toThrow("toBlob");
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("canCopyDiagramImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubClipboardHost(options: {
    ua: string;
    platform?: string;
    maxTouchPoints?: number;
    secure?: boolean;
    canWrite?: boolean;
  }) {
    const canWrite = options.canWrite !== false;
    vi.stubGlobal("isSecureContext", options.secure ?? true);
    vi.stubGlobal("navigator", {
      userAgent: options.ua,
      platform: options.platform ?? "",
      maxTouchPoints: options.maxTouchPoints ?? 0,
      clipboard: canWrite ? { write: vi.fn(async () => undefined), writeText: vi.fn() } : { writeText: vi.fn() },
    });
    vi.stubGlobal("ClipboardItem", canWrite ? class ClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    } : undefined);
  }

  it("allows desktop browsers that can write clipboard images", () => {
    stubClipboardHost({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" });
    expect(canCopyDiagramImage()).toBe(true);
  });

  it("allows desktop Macintosh without touch points", () => {
    stubClipboardHost({
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(canCopyDiagramImage()).toBe(true);
  });

  it("rejects Android even when ClipboardItem exists", () => {
    stubClipboardHost({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0.0.0 Mobile Safari/537.36" });
    expect(canCopyDiagramImage()).toBe(false);
  });

  it("rejects iPhone", () => {
    stubClipboardHost({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" });
    expect(canCopyDiagramImage()).toBe(false);
  });

  it("rejects iPad UA", () => {
    stubClipboardHost({ ua: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15" });
    expect(canCopyDiagramImage()).toBe(false);
  });

  it("rejects iPadOS that reports Macintosh with touch points", () => {
    stubClipboardHost({
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(canCopyDiagramImage()).toBe(false);
  });

  it("rejects insecure contexts", () => {
    stubClipboardHost({
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      secure: false,
    });
    expect(canCopyDiagramImage()).toBe(false);
  });

  it("rejects hosts without image clipboard write", () => {
    stubClipboardHost({
      ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      canWrite: false,
    });
    expect(canCopyDiagramImage()).toBe(false);
  });
});

describe("downloadDiagramPng", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clicks a temporary download anchor and revokes the object URL", () => {
    vi.useFakeTimers();
    const png = new Blob(["png"], { type: "image/png" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    const click = vi.fn();
    const remove = vi.fn();
    const anchor = { href: "", download: "", rel: "", click, remove };
    const append = vi.fn();
    vi.stubGlobal("document", {
      body: { append },
      createElement: (tag: string) => {
        expect(tag).toBe("a");
        return anchor;
      },
    });

    downloadDiagramPng(png);
    expect(anchor).toMatchObject({ href: "blob:diagram", download: "mermaid.png", rel: "noopener" });
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith("blob:diagram");
  });
});

describe("copyMermaidDiagram", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not write svg or mermaid source when png conversion fails", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      clipboard: {
        write: vi.fn(async () => { throw new Error("denied"); }),
        writeText,
      },
    });
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    await expect(copyMermaidDiagram('<svg viewBox="0 0 10 10"></svg>')).rejects.toThrow();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("renderMermaidDiagram", () => {
  beforeEach(() => {
    mermaid.startOnLoad = true;
    mermaid.initialize.mockClear();
    mermaid.render.mockReset();
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries a transient render failure then returns svg", async () => {
    mermaid.render
      .mockRejectedValueOnce(new Error("svg element not in render tree"))
      .mockResolvedValueOnce({ svg: "<svg id=\"ok\" />" });
    await expect(renderMermaidDiagram("flowchart TD\\n  A --> B")).resolves.toBe("<svg id=\"ok\" />");
    expect(mermaid.startOnLoad).toBe(false);
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      suppressErrorRendering: true,
      themeCSS: expect.stringContaining("stroke: #ffffff"),
      themeVariables: expect.objectContaining({
        lineColor: "#ffffff",
        arrowheadColor: "#ffffff",
      }),
    }));
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("throws after repeated render failures", async () => {
    mermaid.render.mockRejectedValue(new Error("parse"));
    await expect(renderMermaidDiagram("not a diagram")).rejects.toThrow("parse");
    expect(mermaid.render).toHaveBeenCalledTimes(3);
  });

  it("normalizes percentage-width mermaid svg for shrink-to-fit preview", async () => {
    mermaid.render.mockResolvedValueOnce({
      svg: '<svg id="ok" width="100%" style="max-width: 10px;" viewBox="0 0 10 8"><g /></svg>',
    });
    await expect(renderMermaidDiagram("flowchart TD\n  A --> B")).resolves.toBe(
      '<svg id="ok" width="10" viewBox="0 0 10 8" height="8"><g /></svg>',
    );
  });

  it("renders diagrams one at a time", async () => {
    const order: string[] = [];
    mermaid.render.mockImplementation(async (_id: string, code: string) => {
      order.push(`start:${code}`);
      await Promise.resolve();
      order.push(`end:${code}`);
      return { svg: `<svg id="${code}" />` };
    });
    const first = renderMermaidDiagram("one");
    const second = renderMermaidDiagram("two");
    await expect(Promise.all([first, second])).resolves.toEqual(["<svg id=\"one\" />", "<svg id=\"two\" />"]);
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });
});
