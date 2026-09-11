import { describe, expect, it } from "vitest";
import { isTextFilePreviewPath, localFilePathFromHref, looksLikeFileReference, MAX_TABLE_ROWS, parseDelimited, previewKindForPath } from "./file-preview";

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

  it("only treats text-like files as clickable message previews", () => {
    expect(isTextFilePreviewPath("src/app.ts")).toBe(true);
    expect(isTextFilePreviewPath("README.md")).toBe(true);
    expect(isTextFilePreviewPath("data.csv")).toBe(true);
    expect(isTextFilePreviewPath("docs/design.pdf")).toBe(false);
    expect(isTextFilePreviewPath("archive.zip")).toBe(false);
    expect(isTextFilePreviewPath("shot.png")).toBe(false);
  });
});

describe("localFilePathFromHref", () => {
  it("accepts relative, absolute, Windows, and file URLs", () => {
    expect(localFilePathFromHref("src/index.ts")).toBe("src/index.ts");
    expect(localFilePathFromHref("/tmp/my%20file.ts")).toBe("/tmp/my file.ts");
    expect(localFilePathFromHref(String.raw`C:\work\src\main.ts`)).toBe(String.raw`C:\work\src\main.ts`);
    expect(localFilePathFromHref("file:///C:/work/src/main.ts")).toBe("C:/work/src/main.ts");
    expect(localFilePathFromHref("file://server/share/src/main.ts")).toBe(String.raw`\\server\share\src\main.ts`);
    expect(localFilePathFromHref("file:///tmp/app.ts?line=2#L2")).toBe("/tmp/app.ts");
  });

  it("removes line suffixes without confusing Windows drive letters", () => {
    expect(localFilePathFromHref("src/app.ts:12")).toBe("src/app.ts");
    expect(localFilePathFromHref("src/app.ts:12:4")).toBe("src/app.ts");
    expect(localFilePathFromHref(String.raw`C:\src\app.ts:12`)).toBe(String.raw`C:\src\app.ts`);
  });

  it("rejects remote, dangerous, and already-served URLs", () => {
    expect(localFilePathFromHref("https://example.com/app.ts")).toBeUndefined();
    expect(localFilePathFromHref("mailto:a@example.com")).toBeUndefined();
    expect(localFilePathFromHref("javascript:alert(1)")).toBeUndefined();
    expect(localFilePathFromHref("/api/files?path=app.ts")).toBeUndefined();
    expect(localFilePathFromHref("//example.com/app.ts")).toBeUndefined();
  });
});

describe("looksLikeFileReference", () => {
  it("requires a path separator or a short file extension", () => {
    expect(looksLikeFileReference("src/app.ts")).toBe(true);
    expect(looksLikeFileReference("README.md")).toBe(true);
    expect(looksLikeFileReference("ordinary")).toBe(false);
    expect(looksLikeFileReference("https://example.com/app.ts")).toBe(false);
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
