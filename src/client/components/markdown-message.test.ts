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
});
