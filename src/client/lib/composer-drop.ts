const ATTACHABLE_IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
const ATTACHABLE_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

export interface BrowserDropFile {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  source?: File;
}

export interface BrowserDropItem {
  kind: string;
  type: string;
  directoryName?: string;
  file?: BrowserDropFile;
}

export interface BrowserDropData {
  items: BrowserDropItem[];
  uriList: string;
  plainText: string;
}

export interface CollectedBrowserDrop {
  images: BrowserDropFile[];
  paths: string[];
  entries: { name: string; kind: "file" | "directory"; size?: number; mtimeMs?: number }[];
}

export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

export function isAttachableDropImage(file: { name: string; type: string }): boolean {
  const type = file.type.toLowerCase();
  if (ATTACHABLE_IMAGE_MIME.has(type)) return true;
  if (type.startsWith("image/")) return false;
  return ATTACHABLE_IMAGE_EXTENSION.test(file.name);
}

export function insertionForDropReferences(value: string, cursor: number, references: readonly string[]): { from: number; insert: string; cursor: number } | undefined {
  if (references.length === 0) return undefined;
  const position = Math.max(0, Math.min(cursor, value.length));
  const before = position > 0 ? value[position - 1] : undefined;
  const after = position < value.length ? value[position] : undefined;
  const prefix = before !== undefined && !/\s/.test(before) ? " " : "";
  const suffix = after === undefined || !/\s/.test(after) ? " " : "";
  const insert = `${prefix}${references.join(" ")}${suffix}`;
  return { from: position, insert, cursor: position + insert.length };
}

export function parseFileUriList(value: string): string[] {
  const paths: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.toLowerCase().startsWith("file:")) continue;
    const path = fileUrlToPath(trimmed);
    if (path !== "") paths.push(path);
  }
  return paths;
}

export function plainTextDropPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\n")) return undefined;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.startsWith("/")) return trimmed;
  return undefined;
}

export function collectBrowserDrop(data: BrowserDropData, attachImages: boolean): CollectedBrowserDrop {
  const images: BrowserDropFile[] = [];
  const entries: CollectedBrowserDrop["entries"] = [];
  for (const item of data.items) {
    if (item.kind !== "file") continue;
    if (item.directoryName !== undefined && item.directoryName !== "") {
      entries.push({ name: item.directoryName, kind: "directory" });
      continue;
    }
    const file = item.file;
    if (file === undefined || file.name === "") continue;
    if (attachImages && isAttachableDropImage(file)) {
      images.push(file);
      continue;
    }
    entries.push({ name: file.name, kind: "file", size: file.size, mtimeMs: file.lastModified });
  }

  const uriPaths = parseFileUriList(data.uriList);
  const plain = plainTextDropPath(data.plainText);
  const paths = uriPaths.length > 0 ? uriPaths : plain === undefined ? [] : [plain];
  const attachedNames = new Set(images.map((file) => file.name.toLocaleLowerCase()));
  const filteredPaths = attachImages
    ? paths.filter((path) => {
      const name = path.split(/[\\/]/).pop()?.toLocaleLowerCase() ?? "";
      return !ATTACHABLE_IMAGE_EXTENSION.test(path) && !attachedNames.has(name);
    })
    : paths;
  return {
    images,
    paths: filteredPaths,
    entries: filteredPaths.length > 0 ? [] : entries,
  };
}

export function browserDropFromTransfer(dataTransfer: DataTransfer): BrowserDropData {
  const items = Array.from(dataTransfer.items);
  const uriList = dataTransfer.getData("text/uri-list");
  const plainText = dataTransfer.getData("text/plain");
  if (items.length > 0) {
    return {
      uriList,
      plainText,
      items: items.map((item) => {
        const entry = webkitEntry(item);
        const file = item.kind === "file" ? item.getAsFile() : null;
        return {
          kind: item.kind,
          type: item.type,
          ...(entry?.isDirectory === true && entry.name !== "" ? { directoryName: entry.name } : {}),
          ...(file === null ? {} : { file: { name: file.name, type: file.type || item.type, size: file.size, lastModified: file.lastModified, source: file } }),
        };
      }),
    };
  }
  return {
    uriList,
    plainText,
    items: Array.from(dataTransfer.files).map((file) => ({
      kind: "file",
      type: file.type,
      file: { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, source: file },
    })),
  };
}

function webkitEntry(item: DataTransferItem): { isDirectory: boolean; name: string } | undefined {
  const withEntry = item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null };
  return withEntry.webkitGetAsEntry?.() ?? undefined;
}

function fileUrlToPath(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  let pathname = decodeURIComponent(parsed.pathname);
  const drive = /^\/([a-zA-Z])[:|](\/.*)?$/.exec(pathname);
  if (drive?.[1] !== undefined) return `${drive[1]}:${drive[2] ?? "/"}`;
  if (pathname.startsWith("/") && parsed.host !== "" && parsed.host !== "localhost") pathname = `//${parsed.host}${pathname}`;
  return pathname;
}
