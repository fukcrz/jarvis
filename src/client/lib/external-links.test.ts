import { describe, expect, it } from "vitest";
import { isExternalHttpUrl, shouldOpenExternalLink } from "./external-links";

const origin = "http://127.0.0.1:9528";

describe("isExternalHttpUrl", () => {
  it("treats other hosts as external", () => {
    expect(isExternalHttpUrl("https://github.com/fukcrz/jarvis", origin)).toBe(true);
    expect(isExternalHttpUrl("http://example.com/a", origin)).toBe(true);
    expect(isExternalHttpUrl("http://127.0.0.1:3000/", origin)).toBe(true);
    expect(isExternalHttpUrl("//github.com/path", origin)).toBe(true);
  });

  it("keeps same-origin and in-app links", () => {
    expect(isExternalHttpUrl("/api/files?path=a.md", origin)).toBe(false);
    expect(isExternalHttpUrl("http://127.0.0.1:9528/chat", origin)).toBe(false);
    expect(isExternalHttpUrl("#/chat/1/2", origin)).toBe(false);
    expect(isExternalHttpUrl("mailto:a@b.c", origin)).toBe(false);
  });
});

describe("shouldOpenExternalLink", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

  it("opens only unmodified primary clicks on external web URLs", () => {
    expect(shouldOpenExternalLink(click, "https://example.com", false, origin)).toBe(true);
    for (const modified of [
      { ...click, ctrlKey: true },
      { ...click, metaKey: true },
      { ...click, shiftKey: true },
      { ...click, altKey: true },
      { ...click, button: 1 },
      { ...click, defaultPrevented: true },
    ]) expect(shouldOpenExternalLink(modified, "https://example.com", false, origin)).toBe(false);
  });

  it("leaves downloads, same-origin routes, anchors, and non-web protocols alone", () => {
    expect(shouldOpenExternalLink(click, "https://example.com/file", true, origin)).toBe(false);
    for (const href of ["/api/files?path=a", "#/chat", "#section", "mailto:a@b.c", "tel:+123", "javascript:alert(1)", null]) {
      expect(shouldOpenExternalLink(click, href, false, origin)).toBe(false);
    }
  });
});
