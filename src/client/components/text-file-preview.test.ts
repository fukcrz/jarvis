import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodePreview } from "./code-preview";
import { LocalTextFilePreviewAnchor, localTextFilePreviewHref, shouldOpenLocalTextFilePreview } from "./text-file-preview";

describe("local text file preview trigger", () => {
  it("builds the same /api/files href used by other local file links", () => {
    expect(localTextFilePreviewHref("src/app.ts", "/ws")).toBe("/api/files?path=src%2Fapp.ts&cwd=%2Fws");
    expect(localTextFilePreviewHref("/tmp/archive.ts")).toBe("/api/files?path=%2Ftmp%2Farchive.ts");
  });

  it("renders an anchor so the path can be selected", () => {
    const markup = renderToStaticMarkup(createElement(LocalTextFilePreviewAnchor, {
      path: "src/app.ts",
      cwd: "/ws",
      onOpen: () => {},
    }, "src/app.ts"));

    expect(markup).toContain("<a ");
    expect(markup).toContain('href="/api/files?path=src%2Fapp.ts&amp;cwd=%2Fws"');
    expect(markup).toContain('class="local-file-preview-trigger"');
    expect(markup).toContain('target="_blank"');
    expect(markup).not.toContain("<button");
  });

  it("opens the preview only for an unmodified primary click without a text selection", () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
    expect(shouldOpenLocalTextFilePreview(click, { isCollapsed: true })).toBe(true);
    expect(shouldOpenLocalTextFilePreview(click, { isCollapsed: false })).toBe(false);
    expect(shouldOpenLocalTextFilePreview({ ...click, ctrlKey: true }, { isCollapsed: true })).toBe(false);
    expect(shouldOpenLocalTextFilePreview({ ...click, button: 1 }, { isCollapsed: true })).toBe(false);
  });
});

describe("text file preview content", () => {
  it("shows syntax highlighting without a current-line marker", () => {
    const markup = renderToStaticMarkup(createElement(CodePreview, {
      text: "export const n = 1;\nexport const m = 2;",
      path: "chart.ts",
      className: "text-file-preview-code",
      lineClassName: "text-file-preview-line",
    }));

    expect(markup).toContain("hljs-keyword");
    expect(markup).toContain('class="text-file-preview-line"');
    expect(markup).not.toContain("highlighted");
    expect(markup).not.toContain("text-file-preview-column");
    expect(markup).not.toContain("code-block-copy");
  });
});
