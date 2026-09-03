import { createContext, useContext, useState, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { defaultSchema, type Schema } from "hast-util-sanitize";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

const remarkPlugins: PluggableList = [remarkGfm];
// 注意顺序：sanitize 先跑、highlight 后跑。
// rehype-sanitize 的默认 schema 只允许 code 上的 language-* class（span 的 class 会被剥掉），
// 先消毒再高亮，hljs 生成的 class 就不会被过滤。
// 默认 schema 的 src 协议白名单只有 http/https，data URI（base64 内嵌图）会被剥掉，
// 这里在默认基础上放开 data: 协议，让 AI 可以用 ![](data:image/...) 直接把图嵌进回复。
const defaultProtocols = defaultSchema.protocols ?? {};
const sanitizeSchema: Schema = {
  ...defaultSchema,
  protocols: {
    ...defaultProtocols,
    src: [...(defaultProtocols.src ?? []), "data"],
  },
  attributes: {
    ...defaultSchema.attributes,
    // 本地文件链接重写后以新标签打开（target/rel 不随默认 schema 放行，需明确允许）。
    a: [...(defaultSchema.attributes?.["a"] ?? []), "target", "rel"],
  },
};
const rehypePlugins: PluggableList = [[rehypeSanitize, sanitizeSchema], rehypeHighlight];
// react-markdown 默认的 urlTransform 只放行 http/https 等协议，data URI 会被替换成空串；
// 这里只放行 data:image/*（base64 内嵌图），其余 URL 行为保持默认（javascript: 等仍被拦截）。
const urlTransform = (url: string): string =>
  /^data:image\//i.test(url) ? url : defaultUrlTransform(url);

interface MarkdownMessageProps {
  text: string;
  streaming?: boolean;
  /** 工作区根目录：用于把 AI 回复里的相对路径图片解析为本地文件。 */
  baseDir?: string;
}

/**
 * 把 AI 回复里的本地图片引用重写为 Jarvis 的 /api/files 接口 URL。
 * 与本地 md 文档一致：支持相对路径（以工作区 cwd 为基准）、绝对路径、file:// 形式；
 * http(s)/data: 等已有 URL 与 /api/ 前缀保持原样。
 */
export function rewriteLocalImageUrls(markdown: string, cwd: string | undefined): string {
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt: string, target: string) => {
    const trimmed = target.trim();
    if (/^(https?:\/\/|data:|blob:|mailto:)/i.test(trimmed)) return whole;
    if (trimmed.startsWith("/api/")) return whole;
    const withoutScheme = trimmed.startsWith("file://") ? trimmed.slice("file://".length) : trimmed;
    // 路径与可选标题（"title" / 'title' / (title)）以空白+引号分隔；路径本身允许含空格。
    const titleIndex = withoutScheme.search(/\s+["'(]/);
    const path = titleIndex === -1 ? withoutScheme : withoutScheme.slice(0, titleIndex);
    const rest = titleIndex === -1 ? "" : withoutScheme.slice(titleIndex);
    if (path === "") return whole;
    const query = `path=${encodeURIComponent(path)}${path.startsWith("/") || cwd === undefined || cwd === "" ? "" : `&cwd=${encodeURIComponent(cwd)}`}`;
    return `![${alt}](/api/files?${query}${rest})`;
  });
}

/**
 * 把 AI 回复里的本地路径链接重写为 Jarvis 的 /api/files 接口 URL。
 * 与图片一致：相对路径以 cwd 为基准，绝对路径与 file:// 直接使用；
 * http(s)/data:/mailto:/# 等已有链接与 /api/ 前缀保持原样。
 */
export function rewriteLocalLinkHref(href: string | undefined, cwd: string | undefined): string | undefined {
  if (href === undefined || href === "") return href;
  if (/^(https?:\/\/|data:|blob:|mailto:|#)/i.test(href)) return href;
  if (href.startsWith("/api/")) return href;
  const withoutScheme = href.startsWith("file://") ? href.slice("file://".length) : href;
  const query = `path=${encodeURIComponent(withoutScheme)}${withoutScheme.startsWith("/") || cwd === undefined || cwd === "" ? "" : `&cwd=${encodeURIComponent(cwd)}`}`;
  return `/api/files?${query}`;
}

const LocalFileCwdContext = createContext<string | undefined>(undefined);

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- node 是 react-markdown 注入的 hast 节点，需从 DOM 属性中剥离。
function LocalLink({ node: _node, href, children, ...rest }: ComponentProps<"a"> & { node?: HastNode }) {
  const cwd = useContext(LocalFileCwdContext);
  const resolved = rewriteLocalLinkHref(href, cwd);
  if (resolved === href) return <a href={href} {...rest}>{children}</a>;
  return <a href={resolved} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
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

const components = { pre: CodeBlock, a: LocalLink };

export function MarkdownMessage({ text, streaming = false, baseDir }: MarkdownMessageProps) {
  const content = baseDir === undefined ? text : rewriteLocalImageUrls(text, baseDir);
  return <LocalFileCwdContext.Provider value={baseDir}>
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform} components={components}>{content}</ReactMarkdown>
    {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
  </LocalFileCwdContext.Provider>;
}
