/**
 * mermaid 体积大（构建产物数百 KB），只在回复里真的出现 ```mermaid 代码块时才动态加载，
 * 不进入主 bundle。
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | undefined;

/** 按需加载并初始化 mermaid：安全级别维持 strict（内置 DOMPurify，图形源码不能注入脚本）。 */
async function loadMermaid(): Promise<typeof import("mermaid").default> {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei UI', sans-serif",
      themeVariables: {
        darkMode: true,
        background: "#121212",
        primaryColor: "#2b2838",
        primaryTextColor: "#f1f1f4",
        primaryBorderColor: "#504c61",
        secondaryColor: "#242428",
        secondaryTextColor: "#e1e1e6",
        secondaryBorderColor: "#42424a",
        tertiaryColor: "#1b1b1e",
        tertiaryTextColor: "#e1e1e6",
        tertiaryBorderColor: "#303036",
        lineColor: "#8b8b96",
        textColor: "#e1e1e6",
        noteBkgColor: "#302e20",
        noteTextColor: "#f4be70",
        noteBorderColor: "#4a4128",
        actorBkg: "#2b2838",
        actorTextColor: "#f1f1f4",
        actorBorder: "#504c61",
        signalColor: "#c9c9d1",
        signalTextColor: "#c9c9d1",
        labelTextColor: "#f1f1f4",
        edgeLabelBackground: "#1b1b1e",
      },
    });
    return mermaid;
  });
  return mermaidPromise;
}

let diagramCounter = 0;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const EXPORT_BACKGROUND = "#121212";
const MAX_EXPORT_EDGE = 4096;

/** 把 mermaid 源码渲染成 SVG 字符串；源码非法时抛错，交由调用方退回源码展示。 */
export async function renderMermaidDiagram(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  diagramCounter += 1;
  const { svg } = await mermaid.render(`jarvis-mermaid-${String(diagramCounter)}`, code);
  return svg;
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

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("svg decode"));
    };
    image.src = url;
  });
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

/** 优先写入 PNG；浏览器不支持图片剪贴板或转码失败时退回 SVG 文本。 */
export async function writeDiagramClipboard(svg: string, png?: Blob): Promise<"png" | "svg"> {
  const api = clipboard();
  if (png !== undefined && clipboardCanWriteImages() && api !== undefined) {
    try {
      await api.write([new ClipboardItem({ "image/png": png })]);
      return "png";
    } catch {
      // 部分浏览器声明了 write 但不接受 image/png。
    }
  }
  if (api?.writeText === undefined) throw new Error("clipboard");
  await api.writeText(svg);
  return "svg";
}

/** 把已渲染的 mermaid SVG 复制到剪贴板。 */
export async function copyMermaidDiagram(svg: string): Promise<"png" | "svg"> {
  let png: Blob | undefined;
  try {
    png = await pngBlobFromSvg(svg);
  } catch {
    png = undefined;
  }
  return writeDiagramClipboard(svg, png);
}
