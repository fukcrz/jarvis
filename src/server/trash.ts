import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { TrashEntry, TrashKind } from "../shared/system.js";
import { AppError } from "./errors.js";
import { atomicWrite, errorCode, isMissingFile, timestampForFile, withFsRetry } from "./fs.js";
import { jarvisHome } from "./jarvis-home.js";

export const TRASH_RETENTION_DAYS = 30;
export type { TrashEntry, TrashKind };

interface TrashMeta extends Omit<TrashEntry, "id"> {
  version: 1;
  /** 回收站目录里实际存放内容的文件名。 */
  payload: string;
}

export function defaultTrashRoot(): string {
  return join(jarvisHome(), "trash");
}

/**
 * Jarvis 回收站：删除会话、文件浏览器里删除文件，都先移到 `~/.jarvis/trash/<时间>-<随机>/`，
 * 保留 30 天后自动清理。可以在 设置 → 数据与恢复 里还原。
 */
export class TrashService {
  constructor(private readonly root = defaultTrashRoot(), private readonly retentionDays = TRASH_RETENTION_DAYS) {}

  get directory(): string {
    return this.root;
  }

  /** 把文件或目录移进回收站；源不存在时返回 undefined。 */
  async moveToTrash(path: string, input: { kind: TrashKind; label?: string; workspaceId?: string; sessionId?: string }): Promise<TrashEntry | undefined> {
    const metadata = await lstat(path).catch((error: unknown) => {
      if (isMissingFile(error)) return undefined;
      throw error;
    });
    if (metadata === undefined) return undefined;
    const id = `${timestampForFile(new Date())}-${randomBytes(4).toString("hex")}`;
    const entryDir = join(this.root, id);
    await mkdir(entryDir, { recursive: true });
    const payload = basename(path) || "item";
    const meta: TrashMeta = {
      version: 1,
      kind: input.kind,
      label: input.label?.trim() || basename(path),
      originalPath: path,
      deletedAt: new Date().toISOString(),
      payload,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(metadata.isDirectory() ? { isDirectory: true } : {}),
    };
    await atomicWrite(join(entryDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    try {
      await movePath(path, join(entryDir, payload));
    } catch (error) {
      await rm(entryDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const entry = toEntry(meta);
    return { id, ...entry };
  }

  async list(): Promise<TrashEntry[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const entries: TrashEntry[] = [];
    for (const name of names) {
      const meta = await this.readMeta(name);
      if (meta === undefined) continue;
      const entry = toEntry(meta);
      entries.push({ id: name, ...entry });
    }
    return entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
  }

  /** 还原到原位置；原位置已有同名文件时，改用"名字 (恢复)"。 */
  async restore(id: string): Promise<{ entry: TrashEntry; restoredPath: string }> {
    if (!/^[\w.-]+$/.test(id)) throw new AppError("TRASH_NOT_FOUND", "回收站里没有这一项", 404);
    const meta = await this.readMeta(id);
    if (meta === undefined) throw new AppError("TRASH_NOT_FOUND", "回收站里没有这一项", 404);
    const source = join(this.root, id, meta.payload);
    await mkdir(dirname(meta.originalPath), { recursive: true });
    const target = await freePath(meta.originalPath);
    await movePath(source, target);
    await rm(join(this.root, id), { recursive: true, force: true });
    const entry = toEntry(meta);
    return { entry: { id, ...entry }, restoredPath: target };
  }

  async remove(id: string): Promise<void> {
    if (!/^[\w.-]+$/.test(id)) throw new AppError("TRASH_NOT_FOUND", "回收站里没有这一项", 404);
    await rm(join(this.root, id), { recursive: true, force: true });
  }

  /** 删除超过保留天数的条目，以及没有 meta.json 的残留目录。返回清掉的条目数。 */
  async purgeExpired(now = Date.now()): Promise<number> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    let purged = 0;
    for (const name of names) {
      const meta = await this.readMeta(name);
      const deletedAt = meta === undefined ? Number.NaN : Date.parse(meta.deletedAt);
      if (meta !== undefined && Number.isFinite(deletedAt) && deletedAt >= cutoff) continue;
      if (meta === undefined) {
        // 刚建好目录、还没写 meta 的条目不能删；只清理一小时以前的残留。
        const stat = await lstat(join(this.root, name)).catch(() => undefined);
        if (stat === undefined || stat.mtimeMs > now - 60 * 60 * 1000) continue;
      }
      await rm(join(this.root, name), { recursive: true, force: true }).catch(() => undefined);
      purged += 1;
    }
    return purged;
  }

  /** 启动时清理一次，之后每 6 小时一次。 */
  startAutoPurge(log: (message: string) => void = () => undefined): () => void {
    const run = () => {
      void this.purgeExpired().then((count) => {
        if (count > 0) log(`回收站已清理 ${String(count)} 项超过 ${String(this.retentionDays)} 天的内容`);
      }).catch(() => undefined);
    };
    run();
    const timer = setInterval(run, 6 * 60 * 60 * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async readMeta(id: string): Promise<TrashMeta | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.root, id, "meta.json"), "utf8")) as Partial<TrashMeta>;
      if (parsed.version !== 1 || typeof parsed.originalPath !== "string" || typeof parsed.payload !== "string" || typeof parsed.deletedAt !== "string") return undefined;
      return {
        version: 1,
        kind: parsed.kind === "session" || parsed.kind === "skill" ? parsed.kind : "file",
        label: typeof parsed.label === "string" ? parsed.label : basename(parsed.originalPath),
        originalPath: parsed.originalPath,
        deletedAt: parsed.deletedAt,
        payload: parsed.payload,
        ...(typeof parsed.workspaceId === "string" ? { workspaceId: parsed.workspaceId } : {}),
        ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
        ...(parsed.isDirectory === true ? { isDirectory: true } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

/** 改名移动；跨盘（EXDEV）时复制后删除源。 */
async function movePath(source: string, target: string): Promise<void> {
  try {
    await withFsRetry(() => rename(source, target));
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    await rm(source, { recursive: true, force: true });
  }
}

async function freePath(path: string): Promise<string> {
  const exists = async (candidate: string) => lstat(candidate).then(() => true, () => false);
  if (!await exists(path)) return path;
  const extension = extname(path);
  const stem = extension === "" ? path : path.slice(0, -extension.length);
  for (let index = 1; ; index += 1) {
    const candidate = `${stem} (恢复${index === 1 ? "" : ` ${String(index)}`})${extension}`;
    if (!await exists(candidate)) return candidate;
  }
}

function toEntry(meta: TrashMeta): Omit<TrashEntry, "id"> {
  return {
    kind: meta.kind,
    label: meta.label,
    originalPath: meta.originalPath,
    deletedAt: meta.deletedAt,
    ...(meta.workspaceId === undefined ? {} : { workspaceId: meta.workspaceId }),
    ...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
    ...(meta.isDirectory === true ? { isDirectory: true } : {}),
  };
}
