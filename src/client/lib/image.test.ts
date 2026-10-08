import { describe, expect, it } from "vitest";
import { composerImageAttachments, sameImageAttachments } from "./image";

describe("sameImageAttachments", () => {
  it("distinguishes equally sized attachment lists with different images", () => {
    expect(sameImageAttachments(
      [{ mimeType: "image/png", data: "queued" }],
      [{ mimeType: "image/png", data: "draft" }],
    )).toBe(false);
  });

  it("matches attachment content in order", () => {
    expect(sameImageAttachments(
      [{ mimeType: "image/png", data: "first" }, { mimeType: "image/jpeg", data: "second" }],
      [{ mimeType: "image/png", data: "first" }, { mimeType: "image/jpeg", data: "second" }],
    )).toBe(true);
  });
});

describe("composerImageAttachments", () => {
  it("keeps data-bearing images and drops url-only ones", () => {
    expect(composerImageAttachments([
      { mimeType: "image/png", data: "abc" },
      { mimeType: "image/jpeg", url: "/media/0" },
      { mimeType: "image/webp", data: "", url: "/media/1" },
    ])).toEqual([{ mimeType: "image/png", data: "abc" }]);
  });

  it("returns an empty list when there are no images", () => {
    expect(composerImageAttachments(undefined)).toEqual([]);
    expect(composerImageAttachments([])).toEqual([]);
  });
});
