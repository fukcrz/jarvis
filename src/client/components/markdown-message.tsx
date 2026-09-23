import { createContext, memo, useContext, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { copyMermaidDiagram, renderMermaidDiagram } from "../lib/mermaid";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { defaultSchema, type Schema } from "hast-util-sanitize";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { isTextFilePreviewPath, localFilePathFromHref, localFileReferenceFromHref, looksLikeFileReference } from "../lib/file-preview";

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
    // URL safety is applied by urlTransform after sanitization. Keeping href's
    // protocol list empty is required for Windows drive-letter paths (C:\\...).
    href: [],
    src: [...(defaultProtocols.src ?? []), "data"],
  },
  attributes: {
    ...defaultSchema.attributes,
    // 本地文件链接重写后以新标签打开（target/rel 不随默认 schema 放行，需明确允许）。
    a: [...(defaultSchema.attributes?.["a"] ?? []), "target", "rel"],
  },
};
const rehypePluginsComplete: PluggableList = [[rehypeSanitize, sanitizeSchema], rehypeHighlight];
const rehypePluginsStreaming: PluggableList = [[rehypeSanitize, sanitizeSchema]];
// react-markdown 默认的 urlTransform 只放行 http/https 等协议，data URI 会被替换成空串；
// 这里只放行 data:image/*（base64 内嵌图），其余 URL 行为保持默认（javascript: 等仍被拦截）。
const urlTransform = (url: string): string =>
  /^data:image\//i.test(url) || localFilePathFromHref(url) !== undefined ? url : defaultUrlTransform(url);

import { DiagramLightbox, ImagePreview } from "./image-lightbox";
import { LocalTextFileLink } from "./text-file-preview";

interface MarkdownMessageProps {
  text: string;
  streaming?: boolean;
  /** 工作区根目录：用于把 AI 回复里的相对路径图片解析为本地文件。 */
  baseDir?: string;
  /** 只在完整的 AI 回复中开启文本文件链接预览。 */
  interactiveFiles?: boolean;
}

const IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)/g;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;

/** 重写正文里的单个图片引用；下划线由调用方保证不在代码里。 */
function rewriteImageReference(whole: string, alt: string, target: string, cwd: string | undefined): string {
  const trimmed = target.trim();
  if (trimmed.startsWith("/api/")) return whole;
  // 路径与可选标题（"title" / 'title' / (title)）以空白+引号分隔；路径本身允许含空格。
  const titleIndex = trimmed.search(/\s+["'(]/);
  const rawPath = titleIndex === -1 ? trimmed : trimmed.slice(0, titleIndex);
  const rest = titleIndex === -1 ? "" : trimmed.slice(titleIndex);
  const path = localFilePathFromHref(rawPath);
  if (path === undefined || path === "") return whole;
  const query = `path=${encodeURIComponent(path)}${isAbsoluteLocalPath(path) || cwd === undefined || cwd === "" ? "" : `&cwd=${encodeURIComponent(cwd)}`}`;
  return `![${alt}](/api/files?${query}${rest})`;
}

/** 行内代码（`…`）不参与重写，否则行内示例会被改坏。 */
function outsideInlineCode(line: string, transform: (segment: string) => string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((segment, index) => index % 2 === 1 ? segment : transform(segment))
    .join("");
}

/** 按行处理围栏外的内容；围栏内的行原样保留（代码里的示例属于代码本身）。 */
function mapOutsideFences(markdown: string, transform: (line: string) => string): string {
  let fence: string | undefined;
  return markdown.split("\n").map((line) => {
    const match = FENCE_PATTERN.exec(line);
    const marker = match?.[1];
    if (fence === undefined) {
      if (marker === undefined) return transform(line);
      fence = marker;
      return line;
    }
    if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    return line;
  }).join("\n");
}

/**
 * 把 AI 回复里的本地图片引用重写为 Jarvis 的 /api/files 接口 URL。
 * 与本地 md 文档一致：支持相对路径（以工作区 cwd 为基准）、绝对路径、file:// 形式；
 * http(s)/data: 等已有 URL 与 /api/ 前缀保持原样。
 * 代码围栏与行内代码里的示例属于代码本身，必须原样保留（例如 mermaid 标签里的 `![](x.png)`）。
 */
export function rewriteLocalImageUrls(markdown: string, cwd: string | undefined): string {
  return mapOutsideFences(markdown, (line) => outsideInlineCode(line, (segment) => segment.replace(IMAGE_PATTERN, (whole, alt: string, target: string) => rewriteImageReference(whole, alt, target, cwd))));
}

/** 表格行与链接/图片目标里的星号可能承担语法结构（`| **A** |`、`[**A**](x)`），一律不动。 */
const STRUCTURED_MARKDOWN = /^\s*\||\]\(/;

/**
 * 部分模型把 reasoning 标题与回答小标题连排输出（`**A****B**`），CommonMark 会把它当成
 * 一个 strong 并保留字面 `****`，渲染成「A****B」粘成一串。这里把紧邻的四颗星号当作段落
 * 分隔，拆成两段各自成段的标题；代码围栏、行内代码、表格行与链接里的星号保持原样。
 */
export function separateAdjacentBoldTitles(markdown: string): string {
  return mapOutsideFences(markdown, (line) => STRUCTURED_MARKDOWN.test(line) ? line : outsideInlineCode(line, (segment) => segment.replaceAll("****", "**\n\n**")));
}

/**
 * 把 AI 回复里的本地路径链接重写为 Jarvis 的 /api/files 接口 URL。
 * 与图片一致：相对路径以 cwd 为基准，绝对路径与 file:// 直接使用；
 * http(s)/data:/mailto:/# 等已有链接与 /api/ 前缀保持原样。
 */
export function rewriteLocalLinkHref(href: string | undefined, cwd: string | undefined): string | undefined {
  if (href === undefined || href === "") return href;
  if (href.startsWith("/api/")) return href;
  const path = localFilePathFromHref(href);
  if (path === undefined) return href;
  const query = `path=${encodeURIComponent(path)}${isAbsoluteLocalPath(path) || cwd === undefined || cwd === "" ? "" : `&cwd=${encodeURIComponent(cwd)}`}`;
  return `/api/files?${query}`;
}

const LocalFileCwdContext = createContext<string | undefined>(undefined);
const InteractiveFilesContext = createContext(false);
const CodeBlockContext = createContext(false);
/** 流式输出中：mermaid 块只显示源码，等这一轮结束再渲染图形。 */
const MarkdownStreamingContext = createContext(false);

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- node 是 react-markdown 注入的 hast 节点，需从 DOM 属性中剥离。
function LocalLink({ node: _node, href, className, children, ...rest }: ComponentProps<"a"> & { node?: HastNode }) {
  const cwd = useContext(LocalFileCwdContext);
  const interactive = useContext(InteractiveFilesContext);
  const reference = interactive ? localFileReferenceFromHref(href) : undefined;
  if (reference !== undefined && isTextFilePreviewPath(reference.path)) {
    return <LocalTextFileLink path={reference.path} cwd={cwd} line={reference.line} className={className}>{children}</LocalTextFileLink>;
  }
  const resolved = rewriteLocalLinkHref(href, cwd);
  if (resolved === href) return <a href={href} className={className} {...rest}>{children}</a>;
  // 媒体、压缩包和未开启交互预览时保留现有行为：本地文件链接在新标签打开。
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

function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function textFromReactNode(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textFromReactNode).join("");
  return "";
}

function extractText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(extractText).join("");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- node is react-markdown's hast node, not a DOM prop.
function MarkdownCode({ node: _node, children, className, ...rest }: ComponentProps<"code"> & { node?: HastNode }) {
  const cwd = useContext(LocalFileCwdContext);
  const interactive = useContext(InteractiveFilesContext);
  const isBlock = useContext(CodeBlockContext);
  const text = textFromReactNode(children).trim();
  const reference = localFileReferenceFromHref(text);
  if (interactive && !isBlock && reference !== undefined && looksLikeFileReference(text) && isTextFilePreviewPath(reference.path)) {
    return <LocalTextFileLink path={reference.path} cwd={cwd} line={reference.line}><code className={className} {...rest}>{children}</code></LocalTextFileLink>;
  }
  return <code className={className} {...rest}>{children}</code>;
}

function CodeBlock({ node, children, ...rest }: ComponentProps<"pre"> & { node?: HastNode }) {
  const codeNode = node?.children?.[0];
  const classes = codeNode?.properties?.className;
  const lang = Array.isArray(classes)
    ? classes.find((c): c is string => typeof c === "string" && c.startsWith("language-"))?.slice("language-".length)
    : undefined;
  const code = extractText(codeNode);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const handleCopy = () => {
    void copyText(code).then(() => {
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    }).catch(() => {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1600);
    });
  };
  if (lang === "mermaid") return <MermaidBlock code={code} />;
  return (
    <CodeBlockContext.Provider value={true}>
      <div className="code-block">
        <div className="code-block-bar">
          <span className="code-block-lang">{lang ?? "text"}</span>
          <button type="button" className={`code-block-copy${copyState === "copied" ? " copied" : copyState === "failed" ? " failed" : ""}`} onClick={handleCopy} disabled={code === ""}>
            {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
          </button>
        </div>
        <pre {...rest}>{children}</pre>
      </div>
    </CodeBlockContext.Provider>
  );
}

/**
 * ```mermaid 代码块：异步渲染成 SVG。流式输出期间只显示源码（半成品图会抖动/报错），
 * 渲染失败时回退成源码并说明状态；可以手动在图形与源码之间切换。
 */
function MermaidBlock({ code }: { code: string }) {
  const streaming = useContext(MarkdownStreamingContext);
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [diagramCopy, setDiagramCopy] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (streaming || code.trim() === "") return;
    let cancelled = false;
    setFailed(false);
    void renderMermaidDiagram(code)
      .then((result) => { if (!cancelled) { setSvg(result); setFailed(false); } })
      .catch(() => { if (!cancelled) { setSvg(undefined); setFailed(true); } });
    return () => { cancelled = true; };
  }, [code, streaming]);

  const handleCopy = () => {
    void copyText(code).then(() => {
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    }).catch(() => {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1600);
    });
  };
  const handleCopyDiagram = () => {
    if (svg === undefined) return;
    void copyMermaidDiagram(svg).then(() => {
      setDiagramCopy("copied");
      window.setTimeout(() => setDiagramCopy("idle"), 1600);
    }).catch(() => {
      setDiagramCopy("failed");
      window.setTimeout(() => setDiagramCopy("idle"), 1600);
    });
  };
  const diagram = svg !== undefined && !failed && !streaming;
  return <div className="code-block mermaid-block">
    <div className="code-block-bar">
      <span className="code-block-lang">mermaid</span>
      <span className="mermaid-block-actions">
        {diagram ? <button type="button" className="code-block-copy" onClick={() => setShowSource((current) => !current)}>{showSource ? "图形" : "源码"}</button> : null}
        <button type="button" className={`code-block-copy${copyState === "copied" ? " copied" : copyState === "failed" ? " failed" : ""}`} onClick={handleCopy} disabled={code === ""}>{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}</button>
        {diagram ? <button type="button" className={`code-block-copy${diagramCopy === "copied" ? " copied" : diagramCopy === "failed" ? " failed" : ""}`} onClick={handleCopyDiagram}>{diagramCopy === "copied" ? "已复制" : diagramCopy === "failed" ? "复制失败" : "复制图"}</button> : null}
      </span>
    </div>
    {!failed ? null : <p className="mermaid-block-error" role="status">图形渲染失败，已显示源码</p>}
    {diagram && !showSource
      ? <div
        className="mermaid-block-diagram"
        role="button"
        tabIndex={0}
        aria-label="预览图形"
        onClick={(event) => { if ((event.target as Element).closest("svg") !== null) setPreviewOpen(true); }}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPreviewOpen(true); } }}
      >
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      : <pre><code>{code}</code></pre>}
    {previewOpen && svg !== undefined ? <DiagramLightbox svg={svg} onClose={() => setPreviewOpen(false)} /> : null}
  </div>;
}

const components = { pre: CodeBlock, code: MarkdownCode, a: LocalLink, img: MarkdownMedia };

export const MarkdownMessage = memo(function MarkdownMessage({ text, streaming = false, baseDir, interactiveFiles = false }: MarkdownMessageProps) {
  const content = separateAdjacentBoldTitles(baseDir === undefined ? text : rewriteLocalImageUrls(text, baseDir));
  return <LocalFileCwdContext.Provider value={baseDir}>
    <InteractiveFilesContext.Provider value={interactiveFiles}>
      <MarkdownStreamingContext.Provider value={streaming}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={streaming ? rehypePluginsStreaming : rehypePluginsComplete} urlTransform={urlTransform} components={components}>{content}</ReactMarkdown>
        {streaming ? <span className="streaming-cursor" aria-hidden="true" /> : null}
      </MarkdownStreamingContext.Provider>
    </InteractiveFilesContext.Provider>
  </LocalFileCwdContext.Provider>;
});
