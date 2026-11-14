import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { isRecord, type Workspace } from "../shared/protocol.js";
import { isMissingFile } from "./fs.js";
import { userContentFromContent } from "./projection.js";
import { isVisibleSessionId } from "./session-helpers.js";

export interface SessionFileIndex {
  id: string;
  path: string;
  mtimeMs: number;
  mtimeIso: string;
  timestamp?: string;
}

/** Match Pi's environment-over-settings session directory precedence. */
export function sessionDirectoryFor(cwd: string, agentDir: string): string | undefined {
  const environmentValue = process.env["PI_CODING_AGENT_SESSION_DIR"];
  if (environmentValue !== undefined && environmentValue.trim() !== "") return resolveConfiguredSessionDir(environmentValue, cwd);

  const globalSettings = readSessionDir(join(agentDir, "settings.json"));
  const projectSettings = readSessionDir(join(cwd, ".pi", "settings.json"));
  const configured = projectSettings ?? globalSettings;
  if (configured === undefined) return undefined;
  const base = projectSettings === undefined ? agentDir : join(cwd, ".pi");
  return resolveConfiguredSessionDir(configured, base);
}

function managedSessionDir(cwd: string): string | undefined {
  return sessionDirectoryFor(cwd, getAgentDir());
}

export function createManagedSession(cwd: string): SessionManager {
  const sessionDir = managedSessionDir(cwd);
  return sessionDir === undefined ? SessionManager.create(cwd) : SessionManager.create(cwd, sessionDir);
}

export async function persistEmptyManagedSession(manager: SessionManager): Promise<SessionManager> {
  const path = manager.getSessionFile();
  const header = manager.getHeader();
  if (path === undefined || header === null) throw new Error("Cannot persist an empty in-memory session");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
  return openManagedSessionAt(path, manager.getSessionDir());
}

export function openManagedSessionAt(path: string, sessionDir: string | undefined): SessionManager {
  return sessionDir === undefined ? SessionManager.open(path) : SessionManager.open(path, sessionDir);
}

export function openManagedSession(cwd: string, path: string): SessionManager {
  return openManagedSessionAt(path, managedSessionDir(cwd));
}

export function listManagedSessions(cwd: string): ReturnType<typeof SessionManager.list> {
  const sessionDir = managedSessionDir(cwd);
  return sessionDir === undefined ? SessionManager.list(cwd) : SessionManager.list(cwd, sessionDir);
}

function readSessionDir(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return undefined;
    const value = parsed["sessionDir"];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveConfiguredSessionDir(value: string, baseDir: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function defaultSessionDir(cwd: string, agentDir: string): string {
  const encoded = `--${resolve(cwd).replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`;
  return join(agentDir, "sessions", encoded);
}

function sessionFilesDirectory(workspace: Workspace): string {
  return sessionDirectoryFor(workspace.cwd, getAgentDir()) ?? defaultSessionDir(workspace.cwd, getAgentDir());
}

function shouldFilterSessionCwd(workspace: Workspace, directory: string): boolean {
  return sessionDirectoryFor(workspace.cwd, getAgentDir()) !== undefined && resolve(directory) !== resolve(defaultSessionDir(workspace.cwd, getAgentDir()));
}

export async function listSessionFiles(workspace: Workspace): Promise<SessionFileIndex[]> {
  const directory = sessionFilesDirectory(workspace);
  const filterCwd = shouldFilterSessionCwd(workspace, directory);
  const resolvedCwd = resolve(workspace.cwd);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const jsonlNames = names.filter((name) => name.endsWith(".jsonl"));
  const files = await mapLimit(jsonlNames, HEADER_READ_CONCURRENCY, async (name) => {
    const path = join(directory, name);
    const header = await readSessionFileHeader(path);
    if (header === undefined || header.subagentThread === true || !isVisibleSessionId(header.id)) return undefined;
    if (filterCwd && (header.cwd === undefined || header.cwd === "" || resolve(header.cwd) !== resolvedCwd)) return undefined;
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(path);
    } catch {
      return undefined;
    }
    return {
      id: header.id,
      path,
      mtimeMs: stats.mtimeMs,
      mtimeIso: stats.mtime.toISOString(),
      ...(header.timestamp === undefined ? {} : { timestamp: header.timestamp }),
    };
  });
  return files.filter((file): file is SessionFileIndex => file !== undefined);
}

function sessionJsonlDirectories(workspace: Workspace): string[] {
  const directories = new Set<string>([
    sessionFilesDirectory(workspace),
    defaultSessionDir(workspace.cwd, getAgentDir()),
  ]);
  const environmentValue = process.env["PI_CODING_AGENT_SESSION_DIR"];
  if (environmentValue !== undefined && environmentValue.trim() !== "") {
    directories.add(resolveConfiguredSessionDir(environmentValue, workspace.cwd));
  }
  return [...directories];
}

export async function removeSessionJsonl(workspace: Workspace, sessionId: string, remove: (path: string) => Promise<unknown> = (path) => rm(path, { force: true })): Promise<void> {
  for (const directory of sessionJsonlDirectories(workspace)) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(`_${sessionId}.jsonl`)) continue;
      await remove(join(directory, name));
    }
  }
}

export async function findSessionFile(workspace: Workspace, sessionId: string): Promise<string | undefined> {
  const directory = sessionFilesDirectory(workspace);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  const match = names.find((name) => name.endsWith(`_${sessionId}.jsonl`));
  if (match !== undefined) return join(directory, match);
  return (await listSessionFiles(workspace)).find((file) => file.id === sessionId)?.path;
}

const SESSION_HEADER_SCAN_BYTES = 64 * 1024;
const SESSION_LIST_HEAD_SCAN_BYTES = 256 * 1024;
const SESSION_LIST_TAIL_SCAN_BYTES = 64 * 1024;
const HEADER_READ_CONCURRENCY = 16;
/** pi-subagent-manager 在建子会话时写入的归属记录，用来区分主会话与子代理会话。 */
const SUBAGENT_THREAD_ENTRY = "pi-subagent:thread:v1";

export function filterSubagentInheritedEntries(entries: readonly unknown[], inheritedCount: number): unknown[] {
  const ownershipIndex = entries.findIndex((entry) => isRecord(entry) && entry["type"] === "custom" && entry["customType"] === SUBAGENT_THREAD_ENTRY);
  let remaining = Math.max(0, inheritedCount);
  return entries.filter((entry, index) => {
    if (index <= ownershipIndex) return index > ownershipIndex;
    if (remaining > 0 && isRecord(entry) && (entry["type"] === "message" || entry["type"] === "custom_message")) {
      remaining -= 1;
      return false;
    }
    return true;
  });
}

/** Read a registered child branch without using SessionManager.open(), which may migrate and rewrite JSONL. */
export function readSubagentSessionBranch(workspace: Workspace, sessionId: string, rootId: string, threadPath: string): { entries: unknown[]; inheritedCount: number } | undefined {
  const directory = sessionFilesDirectory(workspace);
  let file: string;
  try {
    const match = readdirSync(directory).find((name) => name.endsWith(`_${sessionId}.jsonl`));
    if (match === undefined) return undefined;
    file = join(directory, match);
  } catch {
    return undefined;
  }
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return undefined;
  }
  const parsed: unknown[] = [];
  for (const line of lines) {
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry)) parsed.push(entry);
    } catch {
      // An in-progress append may leave one incomplete final line; ignore only that line.
    }
  }
  const header = parsed.find((entry) => isRecord(entry) && entry["type"] === "session");
  if (!isRecord(header) || header["id"] !== sessionId) return undefined;
  const byId = new Map<string, Record<string, unknown>>();
  let leafId: string | undefined;
  for (const entry of parsed) {
    if (!isRecord(entry) || entry["type"] === "session" || typeof entry["id"] !== "string") continue;
    byId.set(entry["id"], entry);
    leafId = entry["id"];
  }
  const branch: unknown[] = [];
  const visited = new Set<string>();
  while (leafId !== undefined && !visited.has(leafId)) {
    visited.add(leafId);
    const entry = byId.get(leafId);
    if (entry === undefined) return undefined;
    branch.push(entry);
    leafId = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
  }
  branch.reverse();
  const ownership = branch.find((entry) => isRecord(entry) && entry["type"] === "custom" && entry["customType"] === SUBAGENT_THREAD_ENTRY);
  if (!isRecord(ownership) || !isRecord(ownership["data"])) return undefined;
  const data = ownership["data"];
  if (data["rootId"] !== rootId || data["threadPath"] !== threadPath || typeof data["inheritedCount"] !== "number" || !Number.isInteger(data["inheritedCount"]) || data["inheritedCount"] < 0) return undefined;
  return { entries: branch, inheritedCount: data["inheritedCount"] };
}

export async function readSessionFileHeader(path: string): Promise<{ id: string; cwd?: string; timestamp?: string; subagentThread?: true } | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(SESSION_HEADER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    const newline = head.indexOf(0x0a);
    if (newline <= 0) return undefined;
    const parsed: unknown = JSON.parse(head.subarray(0, newline).toString("utf8"));
    if (!isRecord(parsed) || parsed["type"] !== "session" || typeof parsed["id"] !== "string" || parsed["id"] === "") return undefined;
    return {
      id: parsed["id"],
      ...(typeof parsed["cwd"] === "string" ? { cwd: parsed["cwd"] } : {}),
      ...(typeof parsed["timestamp"] === "string" ? { timestamp: parsed["timestamp"] } : {}),
      ...(subagentThreadMarked(head.subarray(newline + 1)) ? { subagentThread: true as const } : {}),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 只看会话开头的几行：归属记录在建子会话时先于对话内容写入。 */
function subagentThreadMarked(head: Buffer): boolean {
  let offset = 0;
  for (let index = 0; index < 8; index += 1) {
    const newline = head.indexOf(0x0a, offset);
    const line = head.subarray(offset, newline === -1 ? head.length : newline).toString("utf8").trim();
    if (line !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      if (isRecord(parsed) && parsed["type"] === "message") return false;
      if (isRecord(parsed) && parsed["type"] === "custom" && parsed["customType"] === SUBAGENT_THREAD_ENTRY) return true;
    }
    if (newline === -1) return false;
    offset = newline + 1;
  }
  return false;
}

export async function sessionModifiedAt(sessionFile: string | undefined, fallback: string): Promise<string> {
  if (sessionFile === undefined) return fallback;
  try {
    return (await stat(sessionFile)).mtime.toISOString();
  } catch {
    return fallback;
  }
}

export async function sessionFileMtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** 只取侧栏需要的名称和首条用户消息，不拼全文。 */
export async function readSessionListCopy(path: string): Promise<{ name: string | null; preview: string | null }> {
  const [head, tailName] = await Promise.all([readSessionListHead(path), readLatestSessionInfoName(path)]);
  return { name: tailName !== undefined ? tailName : head.name, preview: head.preview };
}

async function readSessionListHead(path: string): Promise<{ name: string | null; preview: string | null }> {
  let stream: ReturnType<typeof createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  let name: string | null = null;
  let preview: string | null = null;
  let bytes = 0;
  try {
    stream = createReadStream(path, { encoding: "utf8" });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      const parsed = parseJsonlRecord(line);
      if (parsed === undefined) {
        if (bytes >= SESSION_LIST_HEAD_SCAN_BYTES) break;
        continue;
      }
      if (parsed["type"] === "session_info") name = sessionInfoName(parsed);
      else if (preview === null && parsed["type"] === "message") {
        const message = parsed["message"];
        if (isRecord(message) && message["role"] === "user") {
          const text = userContentFromContent(message["content"]).text.trim();
          if (text !== "") preview = text;
        }
      }
      if (preview !== null || bytes >= SESSION_LIST_HEAD_SCAN_BYTES) break;
    }
  } catch {
    return { name, preview };
  } finally {
    lines?.close();
    stream?.destroy();
  }
  return { name, preview };
}

async function readLatestSessionInfoName(path: string): Promise<string | null | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (metadata.size === 0) return undefined;
    const length = Math.min(SESSION_LIST_TAIL_SCAN_BYTES, metadata.size);
    const start = metadata.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (start > 0 && lines.length > 0) lines.shift();
    let name: string | null | undefined;
    for (const line of lines) {
      const parsed = parseJsonlRecord(line);
      if (parsed?.["type"] === "session_info") name = sessionInfoName(parsed);
    }
    return name;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()));
  return results;
}

function parseJsonlRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sessionInfoName(entry: Record<string, unknown>): string | null {
  const name = entry["name"];
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

/** 数非空行数（流式读，不把整个文件读进内存）。按换行符跳着找，只看每行开头是否有内容，大文件也很快。 */
export async function countJsonlLines(path: string): Promise<number> {
  let lines = 0;
  let lineHasContent = false;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(10, start);
      const end = newline === -1 ? buffer.length : newline;
      for (let index = start; !lineHasContent && index < end; index += 1) {
        const byte = buffer[index];
        if (byte !== 13 && byte !== 32) lineHasContent = true;
      }
      if (newline === -1) break;
      if (lineHasContent) lines += 1;
      lineHasContent = false;
      start = newline + 1;
    }
  }
  return lineHasContent ? lines + 1 : lines;
}
