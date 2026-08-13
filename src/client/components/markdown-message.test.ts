import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./markdown-message";

describe("MarkdownMessage", () => {
  it("renders Markdown while a message is still streaming", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      streaming: true,
      text: "# Heading\n\n**Bold** with `code`.\n\n- First\n- Second",
    }));

    expect(markup).toContain("<h1>Heading</h1>");
    expect(markup).toContain("<strong>Bold</strong>");
    expect(markup).toContain("<code>code</code>");
    expect(markup).toContain("<li>First</li>");
    expect(markup).toContain('class="streaming-cursor"');
  });

  it("highlights fenced code blocks with language label and copy button", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "```ts\nconst n: number = 1;\n```",
    }));

    expect(markup).toContain('class="code-block"');
    expect(markup).toContain("code-block-lang");
    expect(markup).toContain(">ts<");
    expect(markup).toContain("code-block-copy");
    expect(markup).toContain("复制");
    // hljs token class 没有被 sanitize 剥掉，language class 也保留
    expect(markup).toContain("hljs-keyword");
    expect(markup).toContain("hljs-number");
    expect(markup).toContain("language-ts");
  });

  it("keeps unlabeled code blocks plain but still copyable", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "```\nplain text\n```",
    }));

    expect(markup).toContain('class="code-block"');
    expect(markup).toContain("code-block-copy");
    expect(markup).toContain(">text<");
    expect(markup).not.toContain("hljs-");
  });

  it("renders base64 data URI images so AI can embed pictures", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: `看这张图：\n\n![测试图](${dataUri})`,
    }));

    expect(markup).toContain(`<img src="${dataUri}" alt="测试图"/>`);
  });

  it("still strips javascript: URLs from image src", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "![x](javascript:alert(1))",
    }));

    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain('src="javascript');
  });

  it("still allows normal http(s) image URLs", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "![网络图](https://example.com/pic.png)",
    }));

    expect(markup).toContain('<img src="https://example.com/pic.png" alt="网络图"/>');
  });
});
