import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage, imageFallbackTarget, mediaKindForSource, rewriteLocalImageUrls, separateAdjacentBoldTitles } from "./markdown-message";

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

    expect(markup).toContain(`<img class="message-image" src="${dataUri}" alt="测试图" loading="lazy"/>`);
    // 图片先渲染为可点击缩略，点击前不出现灯箱。
    expect(markup).toContain('class="message-image-frame"');
    expect(markup).not.toContain("image-lightbox");
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

    expect(markup).toContain('<img class="message-image" src="https://example.com/pic.png" alt="网络图" loading="lazy"/>');
  });

  it("leaves image references inside code fences and inline code untouched", () => {
    const markdown = [
      "正文 ![图](shot.png)",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[开始] --> B[![](shot.png)]",
      "```",
      "",
      "~~~",
      "![](tilde.png)",
      "~~~",
      "",
      "行内示例 `![](inline.png)` 不改写",
    ].join("\n");
    const rewritten = rewriteLocalImageUrls(markdown, "/ws");

    expect(rewritten).toContain("正文 ![图](/api/files?path=shot.png&cwd=%2Fws)");
    expect(rewritten).toContain("A[开始] --> B[![](shot.png)]");
    expect(rewritten).toContain("![](tilde.png)");
    expect(rewritten).toContain("`![](inline.png)`");
  });

  it("splits glued bold titles that some models emit back to back", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "**Forming side-chat architecture options****Preparing a recommendation before any edits**从现有实现看，我建议把侧聊定位成辅助会话。",
    }));

    expect(markup).toContain("<p><strong>Forming side-chat architecture options</strong></p>");
    expect(markup).toContain("<p><strong>Preparing a recommendation before any edits</strong>从现有实现看，我建议把侧聊定位成辅助会话。</p>");
    expect(markup).not.toContain("****");
  });

  it("separates every glued title run and keeps code, tables, and links untouched", () => {
    expect(separateAdjacentBoldTitles("**Planning a****Planning b****Checking c**")).toBe("**Planning a**\n\n**Planning b**\n\n**Checking c**");

    const markdown = [
      "| **A****B** | 值 |",
      "见 [**A****B**](https://example.com)",
      "```md",
      "**A****B**",
      "```",
      "行内 `**A****B**` 示例",
    ].join("\n");
    const separated = separateAdjacentBoldTitles(markdown);

    expect(separated).toContain("| **A****B** | 值 |");
    expect(separated).toContain("[**A****B**](https://example.com)");
    expect(separated).toContain("```md\n**A****B**\n```");
    expect(separated).toContain("行内 `**A****B**` 示例");
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
    expect(markup).toContain('<img class="message-image" src="/api/files?path=shots%2Fa.png&amp;cwd=%2Fws" alt="图" loading="lazy"/>');
  });

  it("rewrites local file links to the /api/files endpoint and opens them in a new tab", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "下载 [设计稿](docs/design.pdf) 和 [打包件](/tmp/archive.zip)",
      baseDir: "/ws",
    }));

    expect(markup).toContain('href="/api/files?path=docs%2Fdesign.pdf&amp;cwd=%2Fws"');
    expect(markup).toContain('href="/api/files?path=%2Ftmp%2Farchive.zip"');
    // 本地文件链接标类名，站外链接靠 CSS 的 [href^="http"] 区分。
    expect(markup.match(/class="local-file-link"/g)).toHaveLength(2);
    expect(markup.match(/target="_blank" rel="noreferrer"/g)).toHaveLength(2);
  });

  it("keeps non-text local links as downloads when interactive previews are enabled", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "打开 [源码](src/app.ts) 和 [设计稿](docs/design.pdf)",
      baseDir: "/ws",
      interactiveFiles: true,
    }));

    // 文本引用先走资格探测，静态渲染时尚未确认可预览。
    expect(markup).toContain('class="local-file-reference"');
    expect(markup).toContain(">源码<");
    expect(markup).not.toContain('href="/api/files?path=src%2Fapp.ts');
    expect(markup).toContain('href="/api/files?path=docs%2Fdesign.pdf&amp;cwd=%2Fws"');
    expect(markup).toContain('class="local-file-link"');
  });

  it("leaves remote, anchor, mailto, and existing /api/ links untouched", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "[官网](https://example.com) [锚点](#section) [邮件](mailto:a@b.c) [已服务](/api/files?path=z.png)",
      baseDir: "/ws",
    }));

    expect(markup).toContain('<a href="https://example.com">官网</a>');
    expect(markup).toContain('<a href="#section">锚点</a>');
    expect(markup).toContain('<a href="mailto:a@b.c">邮件</a>');
    expect(markup).toContain('<a href="/api/files?path=z.png">已服务</a>');
    expect(markup).not.toContain("local-file-link");
  });

  it("renders video and audio targets as inline players instead of images", () => {
    const video = renderToStaticMarkup(createElement(MarkdownMessage, { text: "![录屏](clips/demo.mp4)", baseDir: "/ws" }));
    expect(video).toContain('class="message-media-frame"');
    expect(video).toContain('<video src="/api/files?path=clips%2Fdemo.mp4&amp;cwd=%2Fws" controls=""');
    expect(video).toContain('playsInline=""');
    expect(video).not.toContain("message-image-frame");

    const audio = renderToStaticMarkup(createElement(MarkdownMessage, { text: "![语音](voice.mp3)", baseDir: "/ws" }));
    expect(audio).toContain('class="message-media-frame message-audio-frame"');
    expect(audio).toContain('<audio src="/api/files?path=voice.mp3&amp;cwd=%2Fws" controls=""');

    // 浏览器不解码的容器不做特例：仍走图片分支，加载失败后显示兑底提示
    const unsupported = renderToStaticMarkup(createElement(MarkdownMessage, { text: "![录屏](clips/demo.mkv)", baseDir: "/ws" }));
    expect(unsupported).toContain('class="message-image"');
    expect(unsupported).not.toContain("<video");
  });

  it("detects media kind from local references, remote URLs, and data URIs", () => {
    expect(mediaKindForSource("/api/files?path=clips%2Fdemo.mp4&cwd=%2Fws")).toBe("video");
    expect(mediaKindForSource("/api/files?path=C%3A%5Ctmp%5Cscreen.WEBM")).toBe("video");
    expect(mediaKindForSource("/api/files?path=voice.ogg")).toBe("audio");
    expect(mediaKindForSource("https://example.com/a/demo.mp4?token=1")).toBe("video");
    expect(mediaKindForSource("https://example.com/a/voice.m4a#t=3")).toBe("audio");
    expect(mediaKindForSource("data:video/mp4;base64,AAAA")).toBe("video");
    expect(mediaKindForSource("data:audio/mpeg;base64,AAAA")).toBe("audio");
    expect(mediaKindForSource("data:image/png;base64,AAAA")).toBe("image");
    expect(mediaKindForSource("/api/files?path=clips%2Fdemo.mkv")).toBe("image");
    expect(mediaKindForSource("/api/files?path=shot.png")).toBe("image");
    expect(mediaKindForSource(undefined)).toBe("image");
  });

  it("renders mermaid fences as a diagram card that falls back to source", () => {
    const markup = renderToStaticMarkup(createElement(MarkdownMessage, {
      text: "流程：\n\n```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```",
    }));

    expect(markup).toContain('class="code-block mermaid-block"');
    expect(markup).toContain(">mermaid<");
    // 静态渲染（尚未执行副作用）时显示源码，不当作普通代码块高亮
    expect(markup).toContain("A[开始] --&gt; B[结束]");
    expect(markup).toContain("code-block-copy");
    expect(markup).toContain("复制");
    expect(markup).not.toContain("复制图");
    expect(markup).not.toContain("mermaid-block-diagram");
    expect(markup).not.toContain("预览图形");
    expect(markup).not.toContain("image-lightbox");

    const streaming = renderToStaticMarkup(createElement(MarkdownMessage, { text: "```mermaid\nflowchart LR\n  A --> B\n```", streaming: true }));
    expect(streaming).toContain('class="code-block mermaid-block"');
  });

  it("labels a failed image with its local path, host, or embed kind", () => {
    expect(imageFallbackTarget("/api/files?path=shots%2Fa.png&cwd=%2Fws")).toBe("shots/a.png（相对 /ws）");
    expect(imageFallbackTarget("/api/files?path=%2Ftmp%2Fmissing.png")).toBe("/tmp/missing.png");
    expect(imageFallbackTarget("/api/files?path=D%3A%2Ftmp%2Fmissing.png&cwd=D%3A%5Cws")).toBe("D:/tmp/missing.png");
    expect(imageFallbackTarget("data:image/png;base64,AAAA")).toBe("内嵌图片");
    expect(imageFallbackTarget("https://example.com/a/b.png?x=1")).toBe("example.com/a/b.png");
    expect(imageFallbackTarget(undefined)).toBe("图片地址缺失");
  });
});
