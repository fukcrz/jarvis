import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodePreview } from "./code-preview";

describe("CodePreview", () => {
  it("renders highlighted tokens and hides line numbers from assistive technology", () => {
    const markup = renderToStaticMarkup(createElement(CodePreview, {
      text: "const count = 1;",
      path: "src/index.ts",
      className: "file-preview-code",
      lineClassName: "file-preview-line",
    }));

    expect(markup).toContain('class="hljs"');
    expect(markup).toContain("hljs-keyword");
    expect(markup).toContain("hljs-number");
    expect(markup).toContain('class="file-preview-line-number" aria-hidden="true">1</span>');
  });

  it("keeps unknown text files as plain text", () => {
    const markup = renderToStaticMarkup(createElement(CodePreview, {
      text: "plain text <&",
      path: "notes.txt",
      className: "text-file-preview-code",
      lineClassName: "text-file-preview-line",
    }));

    expect(markup).not.toContain("hljs-");
    expect(markup).toContain("plain text &lt;&amp;");
  });

  it("keeps blank lines empty and preserves original line endings", () => {
    const markup = renderToStaticMarkup(createElement(CodePreview, {
      text: "first\r\n\rsecond\nlast",
      path: "notes.txt",
      className: "text-file-preview-code",
      lineClassName: "text-file-preview-line",
    }));

    expect(markup).toContain("</span>\r\n<span class=\"text-file-preview-line\"");
    expect(markup).toContain("</span>\r<span class=\"text-file-preview-line\"");
    expect(markup).toContain('class="text-file-preview-line-content"></span>');
    expect(markup).not.toContain('line-content"> </span>');
  });

  it("places the column marker at the expanded tab stop", () => {
    const markup = renderToStaticMarkup(createElement(CodePreview, {
      text: "\tvalue",
      path: "src/index.ts",
      className: "text-file-preview-code",
      lineClassName: "text-file-preview-line",
      column: 2,
      line: 1,
    }));

    expect(markup).toContain("--text-file-column:2");
  });
});
