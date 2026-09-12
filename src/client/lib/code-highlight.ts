import { common, createLowlight } from "lowlight";
import type { RootContent } from "hast";

export interface HighlightTextNode {
  type: "text";
  value: string;
}

export interface HighlightElementNode {
  type: "element";
  className: string[];
  children: HighlightNode[];
}

export type HighlightNode = HighlightTextNode | HighlightElementNode;

export interface HighlightLine {
  nodes: HighlightNode[];
  ending: string;
}

interface SourceLine {
  text: string;
  ending: string;
}

const lowlight = createLowlight(common);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".less": "less",
  ".html": "xml",
  ".htm": "xml",
  ".xml": "xml",
  ".vue": "xml",
  ".svelte": "xml",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "ini",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".env": "ini",
  ".properties": "ini",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "bash",
  ".bat": "bash",
  ".cmd": "bash",
  ".py": "python",
  ".pyw": "python",
  ".rb": "ruby",
  ".php": "php",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".go": "go",
  ".rs": "rust",
  ".swift": "swift",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".diff": "diff",
  ".patch": "diff",
};

const LANGUAGE_BY_NAME: Record<string, string> = {
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  "cmakelists.txt": "makefile",
  "dockerfile": "bash",
  "makefile": "makefile",
  "gnumakefile": "makefile",
  "gemfile": "ruby",
  "procfile": "bash",
  "rakefile": "ruby",
};

/** 根据文件名确定语言；无法确定时返回 undefined，调用方保持纯文本。 */
export function languageForPath(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const special = LANGUAGE_BY_NAME[name];
  if (special !== undefined) return special;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? undefined : LANGUAGE_BY_EXTENSION[name.slice(dot)];
}

/**
 * 按文件已确定的语言生成高亮节点；没有语言或高亮失败时保持纯文本。
 * 返回结果按行拆开，供带行号的代码预览直接渲染。
 */
export function highlightCode(text: string, language: string | undefined): HighlightLine[] {
  const sourceLines = splitSourceLines(text);
  // Highlight.js works with logical lines; the renderer restores the original
  // separators so copied and selected preview text remains byte-for-byte intact.
  const source = sourceLines.map((line) => line.text).join("\n");
  if (language === undefined) return plainTextLines(sourceLines);

  try {
    const root = lowlight.highlight(language, source);
    const nodes = root.children.flatMap((node) => {
      const converted = convertNode(node);
      return converted === undefined ? [] : [converted];
    });
    const lines = splitChildren(nodes);
    return lines.length === sourceLines.length && lines.every((line, index) => textFromNodes(line) === sourceLines[index]?.text)
      ? lines.map((nodes, index) => ({ nodes, ending: sourceLines[index]?.ending ?? "" }))
      : plainTextLines(sourceLines);
  } catch {
    return plainTextLines(sourceLines);
  }
}

function splitSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const separators = /\r\n|\r|\n/g;
  let start = 0;
  for (const separator of text.matchAll(separators)) {
    const index = separator.index ?? 0;
    lines.push({ text: text.slice(start, index), ending: separator[0] });
    start = index + separator[0].length;
  }
  lines.push({ text: text.slice(start), ending: "" });
  return lines;
}

function plainTextLines(lines: SourceLine[]): HighlightLine[] {
  return lines.map((line) => ({
    nodes: line.text === "" ? [] : [{ type: "text", value: line.text }],
    ending: line.ending,
  }));
}

function textFromNodes(nodes: HighlightNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.value : textFromNodes(node.children)).join("");
}

function convertNode(node: RootContent): HighlightNode | undefined {
  if (node.type === "text") return { type: "text", value: node.value };
  if (node.type !== "element") return undefined;
  return {
    type: "element",
    className: classNames(node.properties.className),
    children: node.children.flatMap((child) => {
      const converted = convertNode(child);
      return converted === undefined ? [] : [converted];
    }),
  };
}

function classNames(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

function splitChildren(nodes: HighlightNode[]): HighlightNode[][] {
  const lines: HighlightNode[][] = [[]];
  for (const node of nodes) {
    const parts = splitNode(node);
    if (parts.length === 0) continue;
    lines[lines.length - 1]!.push(...parts[0]!);
    for (let index = 1; index < parts.length; index += 1) lines.push(parts[index]!);
  }
  return lines;
}

function splitNode(node: HighlightNode): HighlightNode[][] {
  if (node.type === "text") {
    return node.value.split("\n").map((value) => value === "" ? [] : [{ type: "text", value }]);
  }
  return splitChildren(node.children).map((children) => children.length === 0 ? [] : [{ type: "element", className: node.className, children }]);
}
