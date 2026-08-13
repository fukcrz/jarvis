import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage, rewriteLocalImageUrls } from "./markdown-message";

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

  it("rewrites workspace-relative local image paths to the /api/files endpoint", () => {
    const rewritten = rewriteLocalImageUrls("截图：\n\n![成果](shot.png) 和 ![备份](backup/copy.png)", "/home/user/workspace");

    expect(rewritten).toContain("![成果](/api/files?path=shot.png&cwd=%2Fhome%2Fuser%2Fworkspace)");
    expect(rewritten).toContain("![备份](/api/files?path=backup%2Fcopy.png&cwd=%2Fhome%2Fuser%2Fworkspace)");
  });

  it("rewrites absolute and file:// paths without a cwd and leaves remote/data URLs alone", () => {
    const rewritten = rewriteLocalImageUrls(
      "![a](/tmp/图 片.png) ![b](file:///var/data/x.webp) ![c](https://example.com/y.png) ![d](data:image/png;base64,AAAA) ![e](/api/files?path=z.png)",
      "/ws",
    );

    expect(rewritten).toContain("![a](/api/files?path=%2Ftmp%2F%E5%9B%BE%20%E7%89%87.png)");
    expect(rewritten).toContain("![b](/api/files?path=%2Fvar%2Fdata%2Fx.webp)");
    expect(rewritten).toContain("![c](https://example.com/y.png)");
    expect(rewritten).toContain("![d](data:image/png;base64,AAAA)");
    expect(rewritten).toContain("![e](/api/files?path=z.png)");
  });

  it("keeps markdown image titles when rewriting and renders local images with baseDir", () => {
    const rewritten = rewriteLocalImageUrls('![图](shots/a.png "标题")', "/ws");
    expect(rewritten).toBe('![图](/api/files?path=shots%2Fa.png&cwd=%2Fws "标题")');

    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "![图](shots/a.png)",
      baseDir: "/ws",
    }));
    expect(markup).toContain('<img src="/api/files?path=shots%2Fa.png&amp;cwd=%2Fws" alt="图"/>');
  });
});
