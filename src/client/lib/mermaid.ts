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

/** 把 mermaid 源码渲染成 SVG 字符串；源码非法时抛错，交由调用方退回源码展示。 */
export async function renderMermaidDiagram(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  diagramCounter += 1;
  const { svg } = await mermaid.render(`jarvis-mermaid-${String(diagramCounter)}`, code);
  return svg;
}
