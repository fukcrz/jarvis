import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareMermaidSvgForExport, renderMermaidDiagram, writeDiagramClipboard } from "./mermaid";

const mermaid = vi.hoisted(() => ({
  startOnLoad: true,
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaid,
}));

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
    }));
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  });

  it("throws after repeated render failures", async () => {
    mermaid.render.mockRejectedValue(new Error("parse"));
    await expect(renderMermaidDiagram("not a diagram")).rejects.toThrow("parse");
    expect(mermaid.render).toHaveBeenCalledTimes(3);
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
