import { randomUUID } from "node:crypto";
import { copyFile, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isRecord } from "../shared/protocol.js";

/** Windows 上杀毒、索引、同步盘短暂占用文件时 rename/copy 会报这些错误码，重试即可。 */
const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EAGAIN", "ENOTEMPTY"]);
const RETRY_DELAYS_MS = [20, 40, 80, 160, 250, 400, 600];

export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined;
}

/** 对偶发的 EPERM/EBUSY/EACCES 按递增间隔重试（总计约 1.5 秒）。 */
export async function withFsRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !RETRYABLE_CODES.has(errorCode(error) ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** 把目录项刷到盘上（改名后持久化）。Windows 不支持对目录 fsync，忽略失败。 */
async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => undefined);
  if (handle === undefined) return;
  try {
    await handle.sync();
  } catch {
    // 部分文件系统不支持目录 fsync。
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 原子写：先写临时文件并刷盘，再改名覆盖目标，最后刷目录。
 * 改名遇到 Windows 上的临时占用会重试；任何失败都会清理临时文件。
 */
export async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await withFsRetry(() => rename(temporary, path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsyncDirectory(dirname(path));
}

export function backupPath(path: string): string {
  return `${path}.bak`;
}

/**
 * 带备份的原子写：先把当前文件复制成 `.bak`（同样先写临时文件再改名），再原子写入新内容。
 * 备份失败不阻止写入。
 */
export async function writeWithBackup(path: string, content: string): Promise<void> {
  await backupCurrent(path).catch((error: unknown) => {
    if (!isMissingFile(error)) console.warn(`[jarvis] 备份 ${basename(path)} 失败`, error);
  });
  await atomicWrite(path, content);
}

async function backupCurrent(path: string): Promise<void> {
  const target = backupPath(path);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await withFsRetry(() => copyFile(path, temporary));
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await withFsRetry(() => rename(temporary, target));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export interface RecoveryNotice {
  file: string;
  /** backup：已用 .bak 恢复；default：没有可用备份，已改用默认值。 */
  outcome: "backup" | "default";
  /** 坏文件被改名留存的位置。 */
  corruptPath?: string;
  reason: string;
  at: string;
}

const recoveryNotices: RecoveryNotice[] = [];

/** 本次启动以来发生过的配置恢复，供界面提示"已从备份恢复 X"。 */
export function listRecoveryNotices(): RecoveryNotice[] {
  return [...recoveryNotices];
}

export function clearRecoveryNoticesForTest(): void {
  recoveryNotices.length = 0;
}

export type JsonParser<T> = (value: unknown) => T;

export interface RecoveredJson<T> {
  /** undefined 表示文件不存在，且没有可用备份。 */
  value: T | undefined;
  /** 读到的内容来自哪里。 */
  source: "file" | "backup" | "default" | "missing";
}

/**
 * 读取 JSON 配置并容错：
 * - 文件不存在：有 .bak 就用 .bak，否则返回 missing；
 * - 文件读坏（解析或校验失败）：把坏文件改名为 `<name>.corrupt-<时间>` 留存，再用 .bak 恢复并写回；
 *   没有可用 .bak 时返回 default，交给调用方使用默认值。
 * 任何恢复都会记一条警告和一条 RecoveryNotice，不再让启动失败或悄悄清空。
 */
export async function readJsonRecovering<T>(path: string, parse: JsonParser<T>, options: { transform?: (raw: string) => string } = {}): Promise<RecoveredJson<T>> {
  const decode = (raw: string): T => parse(JSON.parse(options.transform === undefined ? raw : options.transform(raw)) as unknown);
  let raw: string | undefined;
  try {
    raw = await withFsRetry(() => readFile(path, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  let failure: unknown;
  if (raw !== undefined) {
    try {
      return { value: decode(raw), source: "file" };
    } catch (error) {
      failure = error;
    }
  }
  const fromBackup = await readBackup(path, decode);
  if (raw === undefined && fromBackup === undefined) return { value: undefined, source: "missing" };
  let corruptPath: string | undefined;
  if (raw !== undefined) {
    corruptPath = `${path}.corrupt-${timestampForFile(new Date())}`;
    await withFsRetry(() => rename(path, corruptPath ?? path)).catch(() => { corruptPath = undefined; });
  }
  const reason = failure === undefined ? "文件丢失" : asText(failure);
  if (fromBackup !== undefined) {
    await atomicWrite(path, fromBackup.raw).catch((error: unknown) => console.warn(`[jarvis] 写回 ${basename(path)} 失败`, error));
    recordRecovery({ file: path, outcome: "backup", ...(corruptPath === undefined ? {} : { corruptPath }), reason });
    return { value: fromBackup.value, source: "backup" };
  }
  recordRecovery({ file: path, outcome: "default", ...(corruptPath === undefined ? {} : { corruptPath }), reason });
  return { value: undefined, source: "default" };
}

async function readBackup<T>(path: string, decode: (raw: string) => T): Promise<{ raw: string; value: T } | undefined> {
  try {
    const raw = await readFile(backupPath(path), "utf8");
    return { raw, value: decode(raw) };
  } catch {
    return undefined;
  }
}

function recordRecovery(notice: Omit<RecoveryNotice, "at">): void {
  const entry: RecoveryNotice = { ...notice, at: new Date().toISOString() };
  recoveryNotices.push(entry);
  if (recoveryNotices.length > 50) recoveryNotices.shift();
  const action = entry.outcome === "backup" ? "已从备份恢复" : "没有可用备份，已改用默认值";
  console.warn(`[jarvis] 配置文件 ${entry.file} 读取失败（${entry.reason}），${action}${entry.corruptPath === undefined ? "" : `；坏文件留存为 ${entry.corruptPath}`}`);
}

export function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function asText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
