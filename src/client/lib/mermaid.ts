/**
 * mermaid 体积大（构建产物数百 KB），只在回复里真的出现 ```mermaid 代码块时才动态加载，
 * 不进入主 bundle。
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | undefined;

const RENDER_ATTEMPTS = 3;
let renderQueue: Promise<void> = Promise.resolve();

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task);
  renderQueue = run.then(() => undefined, () => undefined);
  return run;
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    const schedule = globalThis.requestAnimationFrame ?? ((callback: (time: number) => void) => {
      globalThis.setTimeout(() => callback(0), 0);
    });
    schedule(() => resolve());
  });
}

/** 按需加载并初始化 mermaid：安全级别维持 strict（内置 DOMPurify，图形源码不能注入脚本）。 */
async function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.startOnLoad = false;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei UI', sans-serif",
      // mindmap 连线用 cScale（节点底色）而不是 lineColor；darkMode 还会再压暗，必须写进 SVG 样式。
      themeCSS: ".edge, [class*=\"section-edge-\"] { stroke: #ffffff !important; }",
      themeVariables: {
        darkMode: true,
        background: "#0b0d14",
        primaryColor: "#302d42",
        primaryTextColor: "#f5efea",
        primaryBorderColor: "#3a4460",
        secondaryColor: "#1c2436",
        secondaryTextColor: "#f5efea",
        secondaryBorderColor: "#3a4460",
        tertiaryColor: "#121624",
        tertiaryTextColor: "#f5efea",
        tertiaryBorderColor: "#2a3248",
        lineColor: "#ffffff",
        arrowheadColor: "#ffffff",
        textColor: "#f5efea",
        noteBkgColor: "#302e20",
        noteTextColor: "#f4be70",
        noteBorderColor: "#4a4128",
        actorBkg: "#302d42",
        actorTextColor: "#f5efea",
        actorBorder: "#3a4460",
        signalColor: "#c9c9d1",
        signalTextColor: "#c9c9d1",
        labelTextColor: "#f1f3f4",
        edgeLabelBackground: "#16181c",
      },
    });
    return mermaid;
  });
  return mermaidPromise;
}

let diagramCounter = 0;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const EXPORT_BACKGROUND = "#0b0d14";
const MAX_EXPORT_EDGE = 4096;

/** 把 mermaid 源码渲染成 SVG 字符串。瞬时失败会排队重试；源码非法时仍抛错，交由调用方退回源码展示。 */
export async function renderMermaidDiagram(code: string): Promise<string> {
  return enqueueRender(async () => {
    const mermaid = await loadMermaid();
    let lastError: unknown;
    for (let attempt = 0; attempt < RENDER_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await waitForPaint();
      try {
        diagramCounter += 1;
        const { svg } = await mermaid.render(`jarvis-mermaid-${String(diagramCounter)}`, code);
        return normalizeMermaidSvg(svg);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  });
}

/**
 * mermaid 默认 useMaxWidth 会产出 width="100%"（再加 max-width 像素）。
 * 消息列有确定宽度，图能撑开；全屏灯箱是 shrink-to-fit，百分比宽度会算成 0×0。
 * 渲染后改成 viewBox 像素尺寸，灯箱和消息列都能按图本身大小显示。
 */
export function normalizeMermaidSvg(svg: string): string {
  const start = svg.indexOf("<svg");
  if (start === -1) return svg;
  const rest = svg.slice(start);
  const openTag = /^<svg\b[^>]*>/.exec(rest)?.[0];
  if (openTag === undefined) return svg;
  const widthMatch = /\swidth\s*=\s*(["'])([^"']*)\1/i.exec(openTag);
  if (widthMatch === null || !widthMatch[2].trim().endsWith("%")) return svg;
  const { width, height } = svgPixelSize(rest);
  let tag = openTag.replace(/\swidth\s*=\s*(["'])[^"']*\1/i, ` width="${String(width)}"`);
  if (/\sheight\s*=/.test(tag)) {
    tag = tag.replace(/\sheight\s*=\s*(["'])[^"']*\1/i, ` height="${String(height)}"`);
  } else {
    tag = tag.replace(/\s*\/?\s*>$/, ` height="${String(height)}"$&`);
  }
  tag = tag.replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i, (_all, quote: string, style: string) => {
    const cleaned = style.replace(/max-width\s*:\s*[^;]*;?\s*/gi, "").trim();
    return cleaned === "" ? "" : ` style=${quote}${cleaned}${quote}`;
  });
  return svg.slice(0, start) + tag + rest.slice(openTag.length);
}

/** 补齐导出所需的 SVG 命名空间，去掉 XML 声明。 */
export function prepareMermaidSvgForExport(svg: string): string {
  const trimmed = svg.trim();
  const start = trimmed.indexOf("<svg");
  if (start === -1) throw new Error("invalid svg");
  const out = trimmed.slice(start);
  const openTag = /^<svg\b[^>]*>/.exec(out)?.[0];
  if (openTag === undefined) throw new Error("invalid svg");
  const missing = [
    /\sxmlns=/.test(openTag) ? "" : ` xmlns="${SVG_NS}"`,
    /\sxmlns:xlink=/.test(openTag) ? "" : ` xmlns:xlink="${XLINK_NS}"`,
  ].join("");
  return `<svg${missing}${openTag.slice(4)}${out.slice(openTag.length)}`;
}

function clipboard(): Clipboard | undefined {
  return globalThis.navigator?.clipboard;
}

function clipboardCanWriteImages(): boolean {
  return typeof globalThis.ClipboardItem === "function" && typeof clipboard()?.write === "function";
}

function svgPixelSize(svg: string): { width: number; height: number } {
  const viewBox = /viewBox="([^"']+)"/.exec(svg)?.[1];
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const width = Number(/\bwidth="([0-9.]+)(?:px)?"/.exec(svg)?.[1]);
  const height = Number(/\bheight="([0-9.]+)(?:px)?"/.exec(svg)?.[1]);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 800,
    height: Number.isFinite(height) && height > 0 ? height : 600,
  };
}

function loadImage(src: string, revoke?: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (revoke !== undefined) URL.revokeObjectURL(revoke);
      resolve(image);
    };
    image.onerror = () => {
      if (revoke !== undefined) URL.revokeObjectURL(revoke);
      reject(new Error("svg decode"));
    };
    image.src = src;
  });
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  return loadImage(url, url).catch(() => (
    loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  ));
}

async function pngBlobFromSvg(svg: string): Promise<Blob> {
  const prepared = prepareMermaidSvgForExport(svg);
  const { width, height } = svgPixelSize(prepared);
  const scale = Math.min(2, MAX_EXPORT_EDGE / Math.max(width, height));
  const image = await loadSvgImage(prepared);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("canvas");
  context.fillStyle = EXPORT_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (blob === null) throw new Error("toBlob");
  return blob;
}

/** 把 PNG 写入剪贴板。传 Promise 可以在转码期间保住点击手势，失败不写源码。 */
export async function writeDiagramClipboard(png: Blob | Promise<Blob>): Promise<void> {
  const api = clipboard();
  if (!clipboardCanWriteImages() || api === undefined) throw new Error("clipboard");
  try {
    await api.write([new ClipboardItem({ "image/png": png })]);
  } catch (error) {
    if (!(png instanceof Promise)) throw error;
    const blob = await png;
    await api.write([new ClipboardItem({ "image/png": blob })]);
  }
}

async function copyPngViaExecCommand(png: Blob): Promise<void> {
  if (typeof document.execCommand !== "function") throw new Error("execCommand");
  const url = URL.createObjectURL(png);
  const host = document.createElement("div");
  host.contentEditable = "true";
  host.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;overflow:hidden";
  const image = new Image();
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("png decode"));
    });
    image.src = url;
    await loaded;
    document.body.append(host);
    host.append(image);
    host.focus();
    const selection = globalThis.getSelection();
    if (selection === null) throw new Error("selection");
    const range = document.createRange();
    range.selectNode(image);
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand("copy");
    selection.removeAllRanges();
    if (!ok) throw new Error("execCommand");
  } finally {
    host.remove();
    URL.revokeObjectURL(url);
  }
}

/** 把已渲染的 mermaid SVG 复制为 PNG。失败抛错，不写源码。 */
export async function copyMermaidDiagram(svg: string): Promise<void> {
  const pngPromise = pngBlobFromSvg(svg);
  void pngPromise.catch(() => {});
  try {
    await writeDiagramClipboard(pngPromise);
  } catch {
    await copyPngViaExecCommand(await pngPromise);
  }
}
