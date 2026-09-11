/** 文件预览类别：文本类走 JSON 接口取内容，媒体类通过 /api/files 内联渲染。 */
export type PreviewKind = "text" | "markdown" | "table" | "image" | "pdf" | "audio" | "video" | "unsupported";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".heic", ".heif", ".svg", ".ico"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".avi", ".mkv"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const TABLE_EXTENSIONS = new Set([".csv", ".tsv"]);
const UNSUPPORTED_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".iso", ".dmg", ".apk", ".deb", ".rpm", ".msi",
]);

export function previewKindForPath(path: string): PreviewKind {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (TABLE_EXTENSIONS.has(ext)) return "table";
  if (ext === ".pdf") return "pdf";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (UNSUPPORTED_EXTENSIONS.has(ext)) return "unsupported";
  return "text";
}

/** 消息里只有文本/Markdown/表格走点击预览；媒体与压缩包仍走原有打开/下载链接。 */
export function isTextFilePreviewPath(path: string): boolean {
  const kind = previewKindForPath(path);
  return kind === "text" || kind === "markdown" || kind === "table";
}

/**
 * 文件引用的解析结果。行号只用于打开预览时定位，不参与文件路径解析。
 */
export interface LocalFileReference {
  path: string;
  line?: number;
  column?: number;
}

/**
 * 从 Markdown 链接或行内代码中取出本地文件引用。
 * 远程 URL、锚点、已服务 URL 和其它协议不会被当成本地文件。
 */
export function localFileReferenceFromHref(href: string | undefined): LocalFileReference | undefined {
  if (href === undefined || href.trim() === "") return undefined;
  const trimmed = href.trim();
  if (/^(?:https?:\/\/|data:|blob:|mailto:|javascript:|#|\/\/)/i.test(trimmed) || trimmed.startsWith("/api/")) return undefined;
  const location = splitFileLocation(trimmed);
  const decodedForScheme = decodeFileReference(location.path);
  if (/^file:\/\//i.test(decodedForScheme)) return mergeFileLocation(fileUrlPath(decodedForScheme), location);
  // Windows 盘符是本地路径中唯一允许出现「协议式冒号」的非 file:// 形式。
  // Markdown 解析器可能把反斜杠写成 %5C，因此协议判断使用一次解码后的值。
  if (/^[a-z][a-z\d+.-]*:/i.test(decodedForScheme) && !/^[a-z]:[\\/]/i.test(decodedForScheme)) return undefined;
  return mergeFileLocation(parseFileLocation(decodedForScheme.trim()), location);
}

export function localFilePathFromHref(href: string | undefined): string | undefined {
  return localFileReferenceFromHref(href)?.path;
}

function fileUrlPath(value: string): LocalFileReference | undefined {
  const withoutScheme = stripQueryAndFragment(value.slice("file://".length));
  const slash = withoutScheme.indexOf("/");
  const authority = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const rawPath = slash === -1 ? "" : withoutScheme.slice(slash);
  const decodedAuthority = decodeFileReference(authority);
  let path: string;
  if (decodedAuthority !== "" && !/^localhost$/i.test(decodedAuthority)) {
    if (/^[a-z]:$/i.test(decodedAuthority)) path = `${decodedAuthority}${rawPath}`;
    else path = `\\\\${decodedAuthority}${rawPath.replaceAll("/", "\\")}`;
  } else {
    path = rawPath;
  }
  // file:///C:/... 在 Windows 上多出的根斜杠不能传给 Node 当作 /C:/...。
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  const decoded = decodeFileReference(path).trim();
  return decoded === "" ? undefined : parseFileLocation(decoded);
}

function stripQueryAndFragment(value: string): string {
  const index = value.search(/[?#]/);
  return index === -1 ? value : value.slice(0, index);
}

function splitFileLocation(value: string): LocalFileReference {
  let path = value;
  let line: number | undefined;
  let column: number | undefined;
  const fragmentIndex = path.indexOf("#");
  if (fragmentIndex !== -1) {
    const fragment = path.slice(fragmentIndex + 1);
    const match = /^L(\d+)(?::?C?(\d+))?$/i.exec(fragment);
    if (match !== null) {
      line = Number(match[1]);
      column = match[2] === undefined ? undefined : Number(match[2]);
    }
    path = path.slice(0, fragmentIndex);
  }
  const queryIndex = path.indexOf("?");
  if (queryIndex !== -1) {
    const query = new URLSearchParams(path.slice(queryIndex + 1));
    const queryLine = query.get("line") ?? query.get("L");
    const queryColumn = query.get("column") ?? query.get("col") ?? query.get("C");
    if (queryLine !== null && /^\d+$/.test(queryLine)) line = Number(queryLine);
    if (queryColumn !== null && /^\d+$/.test(queryColumn)) column = Number(queryColumn);
    path = path.slice(0, queryIndex);
  }
  return { path, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

function parseFileLocation(value: string): LocalFileReference {
  const lineSuffix = /:(\d+)(?::(\d+))?$/.exec(value);
  if (lineSuffix === null || lineSuffix.index === 0 || /^[a-z]$/i.test(value.slice(0, lineSuffix.index))) return { path: value };
  const line = Number(lineSuffix[1]);
  const column = lineSuffix[2] === undefined ? undefined : Number(lineSuffix[2]);
  return { path: value.slice(0, lineSuffix.index), line, ...(column === undefined ? {} : { column }) };
}

function mergeFileLocation(parsed: LocalFileReference | undefined, location: LocalFileReference): LocalFileReference | undefined {
  if (parsed === undefined) return undefined;
  return {
    ...parsed,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
  };
}

/** 行内代码需要一个轻量启发式，避免把普通单词都变成一次文件探测请求。 */
export function looksLikeFileReference(value: string | undefined): boolean {
  const path = localFilePathFromHref(value);
  if (path === undefined || path.length > 2_000 || /[\r\n]/.test(path)) return false;
  const normalized = path.replaceAll("\\", "/");
  return normalized.includes("/") || /\.[a-z0-9_-]{1,16}$/i.test(normalized);
}

function decodeFileReference(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 不完整的百分号编码仍交给服务端按原始路径尝试，失败时保持不可点击。
    return value;
  }
}

/** CSV/TSV 轻量解析：支持引号包裹字段、双引号转义与 CRLF。 */
export function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRow();
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0 || quoted) endRow();
  return rows;
}

/** 预览表格时最多渲染的行数，超出显示提示。 */
export const MAX_TABLE_ROWS = 500;
