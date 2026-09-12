import { Fragment, forwardRef, useMemo, type CSSProperties, type ReactNode } from "react";
import { highlightCode, languageForPath, type HighlightNode } from "../lib/code-highlight";

export interface CodePreviewProps {
  text: string;
  path?: string;
  className: string;
  lineClassName: string;
  line?: number;
  column?: number;
  columnClassName?: string;
  ariaLabel?: string;
}

export const CodePreview = forwardRef<HTMLPreElement, CodePreviewProps>(function CodePreview({ text, path, className, lineClassName, line, column, columnClassName = `${lineClassName}-column`, ariaLabel = "文件内容" }, ref) {
  const language = languageForPath(path);
  const lines = useMemo(() => highlightCode(text, language), [language, text]);
  return <pre ref={ref} className={`${className} code-preview`} aria-label={ariaLabel}><code className={language === undefined ? undefined : "hljs"}>{lines.map((lineData, index) => {
    const lineNumber = index + 1;
    const highlighted = line === lineNumber;
    const content = lineData.nodes.map((node, nodeIndex) => renderNode(node, `${lineNumber}-${nodeIndex}`));
    const visualColumn = highlighted && column !== undefined ? visualColumnForText(textFromNodes(lineData.nodes), column) : undefined;
    return <Fragment key={lineNumber}><span className={`${lineClassName}${highlighted ? " highlighted" : ""}`} data-line={lineNumber}><span className={`${lineClassName}-number`} aria-hidden="true">{lineNumber}</span><span className={`${lineClassName}-content`}>{content}{visualColumn === undefined ? null : <span className={columnClassName} style={{ "--text-file-column": visualColumn } as CSSProperties} />}</span></span>{lineData.ending}</Fragment>;
  })}</code></pre>;
});

function visualColumnForText(text: string, column: number, tabSize = 2): number {
  const limit = Math.max(0, Math.min(text.length, column - 1));
  let visualColumn = 0;
  for (let index = 0; index < limit; index += 1) {
    visualColumn = text[index] === "\t" ? visualColumn + tabSize - (visualColumn % tabSize) : visualColumn + 1;
  }
  return visualColumn;
}

function textFromNodes(nodes: HighlightNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.value : textFromNodes(node.children)).join("");
}

function renderNode(node: HighlightNode, key: string): ReactNode {
  if (node.type === "text") return <Fragment key={key}>{node.value}</Fragment>;
  const children = node.children.map((child, index) => renderNode(child, `${key}-${index}`));
  return node.className.length === 0
    ? <Fragment key={key}>{children}</Fragment>
    : <span className={node.className.join(" ")} key={key}>{children}</span>;
}
