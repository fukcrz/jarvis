import { describe, expect, it } from "vitest";
import { highlightCode, languageForPath, type HighlightNode } from "./code-highlight";

function textFromNodes(nodes: HighlightNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.value : textFromNodes(node.children)).join("");
}

function hasClass(nodes: HighlightNode[], className: string): boolean {
  return nodes.some((node) => node.type === "element" && (node.className.includes(className) || hasClass(node.children, className)));
}

describe("languageForPath", () => {
  it("recognizes common source and configuration filenames", () => {
    expect(languageForPath("src/App.TSX")).toBe("typescript");
    expect(languageForPath(String.raw`src\\main.PY`)).toBe("python");
    expect(languageForPath("package.jsonc")).toBe("json");
    expect(languageForPath("Dockerfile")).toBe("bash");
    expect(languageForPath(".eslintrc")).toBe("json");
  });

  it("leaves ordinary text and unknown extensions without a language", () => {
    expect(languageForPath("notes.txt")).toBeUndefined();
    expect(languageForPath("debug.log")).toBeUndefined();
    expect(languageForPath("README")).toBeUndefined();
    expect(languageForPath("archive.unknownext")).toBeUndefined();
  });
});

describe("highlightCode", () => {
  it("returns token nodes and keeps line boundaries", () => {
    const lines = highlightCode("const n: number = 1;\r\n// done", "typescript");

    expect(lines).toHaveLength(2);
    expect(textFromNodes(lines[0]?.nodes ?? [])).toBe("const n: number = 1;");
    expect(textFromNodes(lines[1]?.nodes ?? [])).toBe("// done");
    expect(lines.map((line) => line.ending)).toEqual(["\r\n", ""]);
    expect(hasClass(lines[0]?.nodes ?? [], "hljs-keyword")).toBe(true);
    expect(hasClass(lines[0]?.nodes ?? [], "hljs-number")).toBe(true);
    expect(hasClass(lines[1]?.nodes ?? [], "hljs-comment")).toBe(true);
  });

  it("preserves CRLF, legacy CR, and trailing empty lines", () => {
    const lines = highlightCode("first\r\nsecond\rthird\n", undefined);

    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.ending)).toEqual(["\r\n", "\r", "\n", ""]);
    expect(textFromNodes(lines[0]?.nodes ?? [])).toBe("first");
    expect(textFromNodes(lines[1]?.nodes ?? [])).toBe("second");
    expect(textFromNodes(lines[2]?.nodes ?? [])).toBe("third");
    expect(textFromNodes(lines[3]?.nodes ?? [])).toBe("");
  });

  it("falls back to escaped plain text for unknown languages", () => {
    const lines = highlightCode("<script>&\nplain", "not-a-language");

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.nodes.every((node) => node.type === "text"))).toBe(true);
    expect(textFromNodes(lines[0]?.nodes ?? [])).toBe("<script>&");
  });
});
