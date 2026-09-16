import { describe, expect, it } from "vitest";
import { fileMatchScore, parseByteRange } from "./workspace-fs.js";

describe("parseByteRange", () => {
  it("parses closed, open, and suffix ranges", () => {
    expect(parseByteRange("bytes=0-3", 8)).toEqual({ start: 0, end: 3 });
    expect(parseByteRange("bytes=4-", 8)).toEqual({ start: 4, end: 7 });
    expect(parseByteRange("bytes=-2", 8)).toEqual({ start: 6, end: 7 });
  });

  it("rejects unsatisfiable and multi-range requests", () => {
    expect(parseByteRange("bytes=99-", 8)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-1,3-4", 8)).toBeUndefined();
    expect(parseByteRange(undefined, 8)).toBeUndefined();
    expect(parseByteRange("bytes=-0", 8)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-3", 0)).toBe("unsatisfiable");
  });
});

describe("fileMatchScore", () => {
  it("prefers basename prefix over path substring", () => {
    const basenameHit = fileMatchScore("src/app.tsx", "app");
    const pathHit = fileMatchScore("src/app.tsx", "src");
    expect(basenameHit).toBeDefined();
    expect(pathHit).toBeDefined();
    expect(basenameHit!).toBeLessThan(pathHit!);
  });

  it("scores empty queries by path depth", () => {
    expect(fileMatchScore("a/b.ts", "")).toBe(2 * 100 + 6);
  });
});
