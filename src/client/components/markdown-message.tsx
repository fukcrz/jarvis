import { useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];
// 注意顺序：sanitize 先跑、highlight 后跑。
// rehype-sanitize 的默认 schema 只允许 code 上的 language-* class（span 的 class 会被剥掉），
// 先消毒再高亮，hljs 生成的 class 就不会被过滤。
const rehypePlugins = [rehypeSanitize, rehypeHighlight];

interface MarkdownMessageProps {
  text: string;
  streaming?: boolean;
}

interface HastNode {
  type?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function extractText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(extractText).join("");
}

function CodeBlock({ node, children, ...rest }: ComponentProps<"pre"> & { node?: HastNode }) {
  const codeNode = node?.children?.[0];
  const classes = codeNode?.properties?.className;
  const lang = Array.isArray(classes)
    ? classes.find((c): c is string => typeof c === "string" && c.startsWith("language-"))?.slice("language-".length)
    : undefined;
  const code = extractText(codeNode);
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{lang ?? "text"}</span>
        <button type="button" className={`code-block-copy${copied ? " copied" : ""}`} onClick={handleCopy} disabled={code === ""}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

const components = { pre: CodeBlock };

export function MarkdownMessage({ text, streaming = false }: MarkdownMessageProps) {
  return <>
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{text}</ReactMarkdown>
    {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
  </>;
}
