import { describe, expect, it } from "vitest";
import { composerImageAttachments } from "./image";

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
