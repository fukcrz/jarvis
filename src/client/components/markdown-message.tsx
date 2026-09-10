import { createContext, useContext, useState, type ComponentProps } from "react";
import { ImageOff } from "lucide-react";
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

import { ImagePreview } from "./image-lightbox";

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
function LocalLink({ node: _node, href, className, children, ...rest }: ComponentProps<"a"> & { node?: HastNode }) {
  const cwd = useContext(LocalFileCwdContext);
  const resolved = rewriteLocalLinkHref(href, cwd);
  if (resolved === href) return <a href={href} className={className} {...rest}>{children}</a>;
  // 本地文件链接标类名，便于与站外链接区分（站外链接加外开标记）。
  return <a href={resolved} className={className === undefined ? "local-file-link" : `local-file-link ${className}`} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
}

/**
 * 图片加载失败时在提示条里显示的目标：本地引用显示解码后的路径（相对路径带上工作区基准），
 * 内嵌图与远程图分别显示说明或 host+path，避免把超长 URL 或 base64 直接铺满一行。
 */
export function imageFallbackTarget(src: string | undefined): string {
  if (src === undefined || src === "") return "图片地址缺失";
  if (src.startsWith("data:")) return "内嵌图片";
  const local = /^\/api\/files\?(.*)$/.exec(src);
  if (local !== null) {
    const query = new URLSearchParams(local[1]);
    const target = query.get("path") ?? "";
    const cwd = query.get("cwd");
    if (target === "") return "本地图片";
    // 前端对非 / 开头的路径都会带上 cwd（含 Windows 盘符路径），只有真正的相对路径才提示基准目录。
    const absolute = target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\");
    return cwd === null || absolute ? target : `${target}（相对 ${cwd}）`;
  }
  try {
    const url = new URL(src, "http://localhost");
    const label = `${url.host}${url.pathname}`;
    return label.length <= 90 ? label : `${label.slice(0, 89)}…`;
  } catch {
    return src.length <= 90 ? src : `${src.slice(0, 89)}…`;
  }
}

/**
 * 判断 markdown 图片语法指向的媒体类型：
 * /api/files 引用取真实路径扩展名，远程 URL 取路径扩展名，data: 取 MIME。
 * 浏览器不解码的容器（.mkv/.avi 等）归为 image，走加载失败兑底。
 */
export function mediaKindForSource(src: string | undefined): "image" | "video" | "audio" {
  if (src === undefined || src === "") return "image";
  if (/^data:video\//i.test(src)) return "video";
  if (/^data:audio\//i.test(src)) return "audio";
  const local = /^\/api\/files\?(.*)$/.exec(src);
  const target = local === null ? src : (new URLSearchParams(local[1]).get("path") ?? "");
  const normalized = (target.split(/[?#]/)[0] ?? "").replaceAll("\\", "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot);
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return AUDIO_EXTENSIONS.has(ext) ? "audio" : "image";
}

function MediaFallback({ label, src }: { label: string; src: string | undefined }) {
  return <span className="message-image-fallback" role="img" aria-label={label}>
    <ImageOff size={15} aria-hidden />
    <span className="message-image-fallback-path" title={src}>{imageFallbackTarget(src)}</span>
    {src === undefined ? null : <a href={src} target="_blank" rel="noreferrer">打开</a>}
  </span>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- node 是 react-markdown 注入的 hast 节点，需从 DOM 属性中剥离。
function MarkdownMedia({ node: _node, src, alt, title, ...rest }: ComponentProps<"img"> & { node?: HastNode }) {
  const [failed, setFailed] = useState(false);
  const label = alt === undefined || alt === "" ? "图片预览" : alt;
  const kind = mediaKindForSource(src);
  if (failed) return <MediaFallback label={label} src={src} />;
  // 视频/音频用浏览器原生控件直接渲染，不做灯箱也不自动播放。
  if (kind !== "image") return <span className={`message-media-frame${kind === "audio" ? " message-audio-frame" : ""}`}>
    {kind === "video"
      ? <video src={src} controls preload="metadata" playsInline aria-label={label} title={title} onError={() => setFailed(true)} />
      : <audio src={src} controls preload="metadata" aria-label={label} onError={() => setFailed(true)} />}
  </span>;
  return <ImagePreview className="message-image-frame" src={src ?? ""} alt={label}>
    <img {...rest} className="message-image" src={src} alt={alt ?? ""} title={title} loading="lazy" onError={() => setFailed(true)} />
  </ImagePreview>;
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus"]);

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

const components = { pre: CodeBlock, a: LocalLink, img: MarkdownMedia };

export function MarkdownMessage({ text, streaming = false, baseDir }: MarkdownMessageProps) {
  const content = baseDir === undefined ? text : rewriteLocalImageUrls(text, baseDir);
  return <LocalFileCwdContext.Provider value={baseDir}>
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} urlTransform={urlTransform} components={components}>{content}</ReactMarkdown>
    {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
  </LocalFileCwdContext.Provider>;
}
