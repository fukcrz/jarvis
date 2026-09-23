import { describe, expect, it } from "vitest";
import { isExternalHttpUrl } from "./external-links";

const origin = "http://127.0.0.1:9528";

describe("isExternalHttpUrl", () => {
  it("treats other hosts as external", () => {
    expect(isExternalHttpUrl("https://github.com/fukcrz/jarvis", origin)).toBe(true);
    expect(isExternalHttpUrl("http://example.com/a", origin)).toBe(true);
    expect(isExternalHttpUrl("//github.com/path", origin)).toBe(true);
  });

  it("keeps same-origin and in-app links", () => {
    expect(isExternalHttpUrl("/api/files?path=a.md", origin)).toBe(false);
    expect(isExternalHttpUrl("http://127.0.0.1:9528/chat", origin)).toBe(false);
    expect(isExternalHttpUrl("#/chat/1/2", origin)).toBe(false);
    expect(isExternalHttpUrl("mailto:a@b.c", origin)).toBe(false);
  });
});
