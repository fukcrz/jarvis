import { describe, expect, it } from "vitest";
import { MAX_TABLE_ROWS, parseDelimited, previewKindForPath } from "./file-preview";

describe("previewKindForPath", () => {
  it("maps common extensions to preview kinds", () => {
    expect(previewKindForPath("a.png")).toBe("image");
    expect(previewKindForPath("a.PNG")).toBe("image");
    expect(previewKindForPath("a.webp")).toBe("image");
    expect(previewKindForPath("a.svg")).toBe("image");
    expect(previewKindForPath("a.pdf")).toBe("pdf");
    expect(previewKindForPath("a.mp3")).toBe("audio");
    expect(previewKindForPath("a.flac")).toBe("audio");
    expect(previewKindForPath("a.mp4")).toBe("video");
    expect(previewKindForPath("a.mov")).toBe("video");
    expect(previewKindForPath("a.md")).toBe("markdown");
    expect(previewKindForPath("a.markdown")).toBe("markdown");
    expect(previewKindForPath("a.csv")).toBe("table");
    expect(previewKindForPath("a.tsv")).toBe("table");
    expect(previewKindForPath("a.zip")).toBe("unsupported");
    expect(previewKindForPath("a.xlsx")).toBe("unsupported");
    expect(previewKindForPath("a.exe")).toBe("unsupported");
  });

  it("falls back to text for code, config, log, and unknown extensions", () => {
    expect(previewKindForPath("src/index.ts")).toBe("text");
    expect(previewKindForPath("tsconfig.json")).toBe("text");
    expect(previewKindForPath("Dockerfile")).toBe("text");
    expect(previewKindForPath("notes.txt")).toBe("text");
    expect(previewKindForPath("debug.log")).toBe("text");
    expect(previewKindForPath("archive.unknownext")).toBe("text");
  });
});

describe("parseDelimited", () => {
  it("parses simple CSV rows", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with escaped quotes, commas, and newlines", () => {
    const csv = '"name","note"\n"张,三","说 ""hello""\n继续"';
    expect(parseDelimited(csv, ",")).toEqual([
      ["name", "note"],
      ["张,三", "说 \"hello\"\n继续"],
    ]);
  });

  it("parses TSV with tabs", () => {
    expect(parseDelimited("name\tage\n张三\t20\n", "\t")).toEqual([
      ["name", "age"],
      ["张三", "20"],
    ]);
  });

  it("handles CRLF line endings and trailing newline", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps trailing empty fields and ends without a final newline", () => {
    expect(parseDelimited("a,b,\n1,2", ",")).toEqual([
      ["a", "b", ""],
      ["1", "2"],
    ]);
  });

  it("exports a sane render row cap", () => {
    expect(MAX_TABLE_ROWS).toBeGreaterThanOrEqual(100);
  });
});
