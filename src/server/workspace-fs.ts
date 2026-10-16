import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import ignore from "ignore";
import { platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { formatWorkspaceDropReference } from "../shared/drop-reference.js";
import { canonicalizeLocalPathInput } from "../shared/local-path.js";
import type { DirectoryListing, DroppedPathEntry, WorkspaceDirectoryListing, WorkspaceFile, WorkspaceFileContent } from "../shared/protocol.js";
import { AppError } from "./errors.js";
import { isMissingFile } from "./fs.js";

const IGNORED_SEARCH_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "coverage", ".next",
  ".venv", "venv", "vendor", "target", ".turbo", ".cache", "__pycache__",
]);
const MAX_FILE_SEARCH_RESULTS = 80;
const MAX_FILE_SEARCH_DEPTH = 14;
const MAX_FILE_SEARCH_VISITS = 4_000;
const FILE_SEARCH_CACHE_TTL_MS = 5_000;
const MAX_FILE_SEARCH_CACHE_ENTRIES = 32;
type IgnoreScope = { base: string; matcher: ReturnType<typeof ignore> };
const workspaceFileSearchCache = new Map<string, { expiresAt: number; promise: Promise<string[]> }>();
export const MAX_BROWSER_FILE_BYTES = 512 * 1024;
const MAX_TEXT_FILE_BYTES = MAX_BROWSER_FILE_BYTES * 8;

const FILE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/toml; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
};

const TEXT_SOURCE_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml", ".md", ".markdown", ".csv", ".tsv"]);

export async function listRoots(): Promise<DirectoryListing> {
  if (platform() !== "win32") return listDirectory("/");
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const entries = (await Promise.all(candidates.map(async (path) => {
    try {
      const metadata = await stat(path);
      return metadata.isDirectory() ? { name: path, path } : undefined;
    } catch {
      return undefined;
    }
  }))).filter((entry): entry is { name: string; path: string } => entry !== undefined);
  return { path: "", name: "Drives", entries, isGitRepository: false, isRootPicker: true };
}

export async function listDirectory(value: string): Promise<DirectoryListing> {
  try {
    const path = await realpath(value);
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new AppError("DIRECTORY_INVALID", "Path must be a directory", 400);
    const entries = await readdir(path, { withFileTypes: true });
    const directoryEntries = entries
      .filter((entry) => entry.isDirectory() && entry.name !== "." && entry.name !== "..")
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parentPath = dirname(path);
    return {
      path,
      name: basename(path) || path,
      parent: parentPath === path ? undefined : parentPath,
      entries: directoryEntries,
      isGitRepository: await pathExists(join(path, ".git")),
      isRootPicker: false,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("DIRECTORY_UNAVAILABLE", `Directory is unavailable: ${value}`, 400);
  }
}

export async function listWorkspaceDirectory(cwd: string, requestedPath: string): Promise<WorkspaceDirectoryListing> {
  const root = await realpath(cwd).catch(() => { throw new AppError("WORKSPACE_UNAVAILABLE", "Workspace is unavailable", 404); });
  const directory = await resolveExistingPath(root, requestedPath, "DIRECTORY_UNAVAILABLE");
  const metadata = await stat(directory).catch(() => undefined);
  if (metadata === undefined || !metadata.isDirectory()) throw new AppError("DIRECTORY_INVALID", "Path must be a directory", 400);
  const entries = await readdir(directory, { withFileTypes: true });
  const visible = entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({ name: entry.name, path: publicPath(join(directory, entry.name)), kind: entry.isDirectory() ? "directory" as const : "file" as const }))
    .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name));
  const parentDir = dirname(directory);
  const parent = parentDir === directory ? undefined : publicPath(parentDir);
  return { path: publicPath(directory), name: basename(directory) || directory, ...(parent === undefined ? {} : { parent }), entries: visible, isGitRepository: await pathExists(join(directory, ".git")) };
}

export async function removeWorkspaceEntry(cwd: string, requestedPath: string): Promise<void> {
  const root = await realpath(cwd).catch(() => { throw new AppError("WORKSPACE_UNAVAILABLE", "Workspace is unavailable", 404); });
  if (requestedPath.trim() === ".") throw new AppError("FILE_DELETE_INVALID", "The current directory cannot be deleted", 400);
  const candidate = resolveExistingCandidate(root, requestedPath);
  const parent = await realpath(dirname(candidate)).catch(() => { throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404); });
  const metadata = await lstat(candidate).catch(() => undefined);
  if (metadata === undefined) throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404);
  if (metadata.isSymbolicLink()) throw new AppError("FILE_DELETE_INVALID", "Symbolic links cannot be deleted from the file browser", 400);
  if (!metadata.isFile() && !metadata.isDirectory()) throw new AppError("FILE_DELETE_INVALID", "Only files and directories can be deleted", 400);
  const resolved = await realpath(candidate).catch(() => { throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404); });
  if (resolved === parent) throw new AppError("FILE_DELETE_INVALID", "The current directory cannot be deleted", 400);
  try {
    await rm(candidate, { recursive: metadata.isDirectory(), force: false });
  } catch (error) {
    if (isMissingFile(error)) throw new AppError("FILE_NOT_FOUND", "File or directory not found", 404);
    throw new AppError("FILE_DELETE_FAILED", "Unable to delete file or directory", 500);
  }
}

/**
 * 解析单段 Range 头（`bytes=start-end` / `bytes=start-` / `bytes=-suffix`）。
 * 返回 undefined 表示按整档返回（无头、或浏览器极少发的多段 Range）；
 * 返回 "unsatisfiable" 表示范围超出文件，调用方应回 416。
 */
export function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value?.trim() ?? "");
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (size === 0) return "unsatisfiable";
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (rawEnd === "" || suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  return end < start ? "unsatisfiable" : { start, end };
}

export function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Git Bash `/d/foo`、WSL `/mnt/d/foo`、Cygwin `/cygdrive/d/foo` → `d:/foo`。 */
function windowsPosixDriveAliases(path: string): string[] {
  const aliases: string[] = [];
  const push = (drive: string | undefined, rest: string | undefined) => {
    if (drive === undefined) return;
    const alias = `${drive}:${rest ?? "/"}`;
    if (alias !== path && !aliases.includes(alias)) aliases.push(alias);
  };
  const wsl = /^\/mnt\/([a-zA-Z])(\/.*)?$/i.exec(path);
  push(wsl?.[1], wsl?.[2]);
  const cygwin = /^\/cygdrive\/([a-zA-Z])(\/.*)?$/i.exec(path);
  push(cygwin?.[1], cygwin?.[2]);
  if (wsl === null && cygwin === null) {
    const gitBash = /^\/([a-zA-Z])(\/.*)$/.exec(path);
    push(gitBash?.[1], gitBash?.[2]);
  }
  return aliases;
}

function fileRequestCandidates(requestedPath: string, cwd: string | undefined): string[] {
  const normalized = canonicalizeLocalPathInput(requestedPath);
  const paths = [normalized];
  if (platform() === "win32") {
    for (const alias of windowsPosixDriveAliases(normalized)) paths.push(alias);
  }
  return paths.map((path) => isAbsoluteFilePath(path) ? path : resolve(cwd ?? process.cwd(), path));
}

export async function resolveFileRequestPath(requestedPath: string, cwd: string | undefined): Promise<string> {
  let lastError: unknown;
  for (const candidate of fileRequestCandidates(requestedPath, cwd)) {
    try {
      return await realpath(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof AppError ? lastError : new AppError("FILE_NOT_FOUND", "File not found", 404);
}

export function fileResponseMimeType(ext: string): string {
  if (TEXT_SOURCE_EXTENSIONS.has(ext)) return "text/plain; charset=utf-8";
  return FILE_MIME_TYPES[ext] ?? "application/octet-stream";
}

export async function readWorkspaceFile(cwd: string, requestedPath: string): Promise<WorkspaceFileContent> {
  const root = await realpath(cwd).catch(() => { throw new AppError("WORKSPACE_UNAVAILABLE", "Workspace is unavailable", 404); });
  const filePath = await resolveExistingPath(root, requestedPath, "FILE_NOT_FOUND");
  const metadata = await stat(filePath).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) throw new AppError("FILE_NOT_FOUND", "File not found", 404);
  const content = await readTextFile(filePath, metadata);
  return { ...content, path: publicPath(filePath) };
}

export async function readTextFile(filePath: string, metadata: { size: number }, options: { includeContent?: boolean } = {}): Promise<WorkspaceFileContent> {
  const includeContent = options.includeContent ?? true;
  if (metadata.size > MAX_TEXT_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "File is too large to preview", 413);
  const ext = extname(filePath).toLowerCase();
  const mime = FILE_MIME_TYPES[ext];
  const mediaType = mime?.split(";", 1)[0]?.trim();
  const textLike = mediaType === undefined || mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/x-ndjson" || mediaType === "application/xml";
  if (!textLike) throw new AppError("FILE_NOT_TEXT", "Only text files can be previewed", 415);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const previewBuffer = includeContent ? Buffer.allocUnsafe(MAX_BROWSER_FILE_BYTES) : undefined;
  let previewBytes = 0;
  let size = 0;
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      size += chunk.byteLength;
      if (size > MAX_TEXT_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "File is too large to preview", 413);
      if (chunk.includes(0)) throw new AppError("FILE_BINARY", "Binary files cannot be previewed", 415);
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        throw new AppError("FILE_BINARY", "Binary files cannot be previewed", 415);
      }
      if (previewBuffer !== undefined && previewBytes < MAX_BROWSER_FILE_BYTES) {
        const length = Math.min(chunk.byteLength, MAX_BROWSER_FILE_BYTES - previewBytes);
        chunk.copy(previewBuffer, previewBytes, 0, length);
        previewBytes += length;
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw error;
  }
  try {
    decoder.decode();
  } catch {
    throw new AppError("FILE_BINARY", "Binary files cannot be previewed", 415);
  }
  let content = "";
  if (previewBuffer !== undefined && previewBytes > 0) {
    let end = previewBytes;
    const previewDecoder = new TextDecoder("utf-8", { fatal: true });
    while (end > 0) {
      try {
        content = previewDecoder.decode(previewBuffer.subarray(0, end));
        break;
      } catch {
        end -= 1;
      }
    }
  }
  return {
    path: filePath,
    name: basename(filePath),
    content,
    size,
    truncated: size > MAX_BROWSER_FILE_BYTES,
  };
}

export async function searchWorkspaceFiles(cwd: string, query: string): Promise<WorkspaceFile[]> {
  const normalizedQuery = query.trim().replaceAll("\\", "/").toLocaleLowerCase();
  const paths = await workspaceFileIndex(cwd);
  return paths.flatMap((path) => {
    const score = fileMatchScore(path.toLocaleLowerCase(), normalizedQuery);
    return score === undefined ? [] : [{ path, score }];
  }).sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, MAX_FILE_SEARCH_RESULTS)
    .map(({ path }) => ({ path }));
}

function workspaceFileIndex(cwd: string): Promise<string[]> {
  const cached = workspaceFileSearchCache.get(cwd);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    workspaceFileSearchCache.delete(cwd);
    workspaceFileSearchCache.set(cwd, cached);
    return cached.promise;
  }

  const entry: { expiresAt: number; promise: Promise<string[]> } = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise: buildWorkspaceFileIndex(cwd).then((paths) => {
      entry.expiresAt = Date.now() + FILE_SEARCH_CACHE_TTL_MS;
      return paths;
    }).catch((error: unknown) => {
      if (workspaceFileSearchCache.get(cwd) === entry) workspaceFileSearchCache.delete(cwd);
      throw error;
    }),
  };
  workspaceFileSearchCache.delete(cwd);
  workspaceFileSearchCache.set(cwd, entry);
  while (workspaceFileSearchCache.size > MAX_FILE_SEARCH_CACHE_ENTRIES) {
    const oldest = workspaceFileSearchCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    workspaceFileSearchCache.delete(oldest);
  }
  return entry.promise;
}

async function buildWorkspaceFileIndex(cwd: string): Promise<string[]> {
  const paths: string[] = [];
  let visits = 0;

  const visit = async (directory: string, relativeDirectory: string, parentScopes: IgnoreScope[], depth: number): Promise<void> => {
    if (depth > MAX_FILE_SEARCH_DEPTH || visits >= MAX_FILE_SEARCH_VISITS) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    const localIgnore = entries.find((entry) => entry.isFile() && entry.name === ".gitignore");
    let scopes = parentScopes;
    if (localIgnore !== undefined) {
      try {
        const patterns = await readFile(join(directory, localIgnore.name), "utf8");
        scopes = [...parentScopes, { base: relativeDirectory, matcher: ignore().add(patterns) }];
      } catch {
        // An unreadable .gitignore does not hide otherwise searchable files.
      }
    }

    for (const entry of entries) {
      if (visits >= MAX_FILE_SEARCH_VISITS) return;
      visits += 1;
      const absolutePath = join(directory, entry.name);
      const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_SEARCH_DIRECTORIES.has(entry.name) || isIgnoredSearchPath(path, true, scopes)) continue;
        await visit(absolutePath, path, scopes, depth + 1);
      } else if (entry.isFile() && !isIgnoredSearchPath(path, false, scopes)) {
        paths.push(path);
      }
    }
  };

  await visit(cwd, "", [], 0);
  return paths;
}

function isIgnoredSearchPath(path: string, directory: boolean, scopes: IgnoreScope[]): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const scopedPath = scope.base === "" ? path : path.startsWith(`${scope.base}/`) ? path.slice(scope.base.length + 1) : "";
    if (scopedPath === "") continue;
    const result = scope.matcher.test(directory ? `${scopedPath}/` : scopedPath);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

export function fileMatchScore(path: string, query: string): number | undefined {
  if (query === "") return path.split("/").length * 100 + path.length;
  const basenameIndex = path.lastIndexOf("/") + 1;
  const fileName = path.slice(basenameIndex);
  if (fileName.startsWith(query)) return path.length;
  const pathIndex = path.indexOf(query);
  if (pathIndex >= 0) return 1_000 + pathIndex * 10 + path.length;
  let queryIndex = 0;
  for (const character of path) if (character === query[queryIndex]) queryIndex += 1;
  return queryIndex === query.length ? 10_000 + path.length : undefined;
}

function publicPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function resolveExistingCandidate(root: string, requestedPath: string): string {
  const trimmed = canonicalizeLocalPathInput(requestedPath);
  if (trimmed === "" || trimmed === ".") return root;
  return isAbsoluteFilePath(trimmed) ? trimmed : resolve(root, trimmed);
}

async function resolveExistingPath(root: string, requestedPath: string, errorCode: string): Promise<string> {
  try {
    return await realpath(resolveExistingCandidate(root, requestedPath));
  } catch {
    throw new AppError(errorCode, "Path not found", 404);
  }
}

const DROP_MTIME_TOLERANCE_MS = 2_000;

export async function matchDroppedEntries(cwd: string, entries: DroppedPathEntry[]): Promise<{ references: string[]; unmatched: string[] }> {
  const references: string[] = [];
  const unmatched: string[] = [];
  const ordered: DroppedPathEntry[] = [];
  const fileWants = new Map<string, true>();
  const directoryWants = new Map<string, true>();
  for (const entry of entries) {
    const name = normalizeDropName(entry.name);
    if (name === undefined) {
      unmatched.push(entry.name);
      continue;
    }
    const normalized = { ...entry, name };
    ordered.push(normalized);
    (entry.kind === "directory" ? directoryWants : fileWants).set(dropNameKey(name), true);
  }
  if (ordered.length === 0) return { references, unmatched };

  const cwdReal = await realpath(cwd).catch(() => resolve(cwd));
  const fileCandidates = new Map<string, { path: string; size: number; mtimeMs: number }[]>();
  const directoryCandidates = new Map<string, string[]>();
  const rootKey = dropNameKey(basename(cwdReal));
  if (directoryWants.has(rootKey)) pushDropCandidate(directoryCandidates, rootKey, "");

  let visits = 0;
  const visit = async (directory: string, relativeDirectory: string, parentScopes: IgnoreScope[], depth: number): Promise<void> => {
    if (depth > MAX_FILE_SEARCH_DEPTH || visits >= MAX_FILE_SEARCH_VISITS) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const localIgnore = children.find((entry) => entry.isFile() && entry.name === ".gitignore");
    let scopes = parentScopes;
    if (localIgnore !== undefined) {
      try {
        const patterns = await readFile(join(directory, localIgnore.name), "utf8");
        scopes = [...parentScopes, { base: relativeDirectory, matcher: ignore().add(patterns) }];
      } catch {
        // An unreadable .gitignore does not hide otherwise searchable files.
      }
    }
    for (const child of children) {
      if (visits >= MAX_FILE_SEARCH_VISITS) return;
      visits += 1;
      const absolutePath = join(directory, child.name);
      const path = relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      const key = dropNameKey(child.name);
      if (child.isDirectory()) {
        if (IGNORED_SEARCH_DIRECTORIES.has(child.name) || isIgnoredSearchPath(path, true, scopes)) continue;
        if (directoryWants.has(key)) pushDropCandidate(directoryCandidates, key, path);
        await visit(absolutePath, path, scopes, depth + 1);
      } else if (child.isFile() && fileWants.has(key) && !isIgnoredSearchPath(path, false, scopes)) {
        const metadata = await stat(absolutePath).catch(() => undefined);
        if (metadata?.isFile() === true) pushDropCandidate(fileCandidates, key, { path, size: metadata.size, mtimeMs: metadata.mtimeMs });
      }
    }
  };
  await visit(cwdReal, "", [], 0);

  for (const entry of ordered) {
    const key = dropNameKey(entry.name);
    const relativePath = entry.kind === "directory"
      ? uniqueDirectoryCandidate(directoryCandidates.get(key) ?? [])
      : uniqueFileCandidate(fileCandidates.get(key) ?? [], entry);
    if (relativePath === undefined) unmatched.push(entry.name);
    else references.push(formatWorkspaceDropReference(relativePath, entry.kind === "directory"));
  }
  return { references, unmatched };
}

function normalizeDropName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) return undefined;
  return trimmed;
}

function dropNameKey(name: string): string {
  return platform() === "win32" ? name.toLocaleLowerCase() : name;
}

function pushDropCandidate<T>(bucket: Map<string, T[]>, key: string, value: T): void {
  const current = bucket.get(key);
  if (current === undefined) bucket.set(key, [value]);
  else current.push(value);
}

function uniqueDirectoryCandidate(candidates: string[]): string | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

function uniqueFileCandidate(candidates: { path: string; size: number; mtimeMs: number }[], entry: DroppedPathEntry): string | undefined {
  let pool = candidates;
  if (entry.size !== undefined) pool = pool.filter((candidate) => candidate.size === entry.size);
  if (pool.length === 1) return pool[0]?.path;
  const mtimeMs = entry.mtimeMs;
  if (mtimeMs === undefined) return undefined;
  const timed = pool.filter((candidate) => Math.abs(candidate.mtimeMs - mtimeMs) <= DROP_MTIME_TOLERANCE_MS);
  return timed.length === 1 ? timed[0]?.path : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
