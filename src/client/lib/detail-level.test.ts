import { describe, expect, it } from "vitest";
import { parseDetailLevel } from "./detail-level";

describe("parseDetailLevel", () => {
  it("falls back to normal for anything unknown", () => {
    expect(parseDetailLevel("concise")).toBe("concise");
    expect(parseDetailLevel("verbose")).toBe("verbose");
    expect(parseDetailLevel(null)).toBe("normal");
    expect(parseDetailLevel("loud")).toBe("normal");
  });
});
