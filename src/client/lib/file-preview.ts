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
