import { useState, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { defaultSchema } from "hast-util-sanitize";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];
// 注意顺序：sanitize 先跑、highlight 后跑。
// rehype-sanitize 的默认 schema 只允许 code 上的 language-* class（span 的 class 会被剥掉），
// 先消毒再高亮，hljs 生成的 class 就不会被过滤。
// 默认 schema 的 src 协议白名单只有 http/https，data URI（base64 内嵌图）会被剥掉，
// 这里在默认基础上放开 data: 协议，让 AI 可以用 ![](data:image/...) 直接把图嵌进回复。
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols.src ?? []), "data"],
  },
};
const rehypePlugins = [[rehypeSanitize, sanitizeSchema], rehypeHighlight];
// react-markdown 默认的 urlTransform 只放行 http/https 等协议，data URI 会被替换成空串；
// 这里只放行 data:image/*（base64 内嵌图），其余 URL 行为保持默认（javascript: 等仍被拦截）。
const urlTransform = (url: string): string =>
  /^data:image\//i.test(url) ? url : defaultUrlTransform(url);

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
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform} components={components}>{text}</ReactMarkdown>
    {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
  </>;
}
