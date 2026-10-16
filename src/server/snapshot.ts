import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "./fs.js";
import { localDay } from "./log-files.js";
import { createZip, type ZipInput } from "./zip.js";
import { jarvisHome } from "./jarvis-home.js";

export const SNAPSHOT_KEEP = 7;

export interface SnapshotOptions {
  jarvisHome?: string;
  agentDir: string;
  keep?: number;
  now?: () => Date;
}

/**
 * 每日快照：把 ~/.jarvis 下的配置文件和会话状态文件打包成 `snapshots/<日期>.zip`，保留 7 份。
 * 不含会话 JSONL（太大，而且 Pi 只往后追加）。
 */
export class DailySnapshots {
  private readonly jarvisHome: string;
  private readonly directory: string;

  constructor(private readonly options: SnapshotOptions) {
    this.jarvisHome = options.jarvisHome ?? jarvisHome();
    this.directory = join(this.jarvisHome, "snapshots");
  }

  get path(): string {
    return this.directory;
  }

  async list(): Promise<Array<{ name: string; size: number }>> {
    const names = (await readdir(this.directory).catch(() => [] as string[])).filter((name) => /^\d{4}-\d{2}-\d{2}\.zip$/.test(name)).sort().reverse();
    return Promise.all(names.map(async (name) => ({ name, size: (await stat(join(this.directory, name)).catch(() => undefined))?.size ?? 0 })));
  }

  /** 今天还没有快照就打一份；返回新快照的文件名。 */
  async ensureToday(): Promise<string | undefined> {
    const day = localDay((this.options.now ?? (() => new Date()))());
    const name = `${day}.zip`;
    const target = join(this.directory, name);
    if (await stat(target).then(() => true, () => false)) return undefined;
    const entries: ZipInput[] = [];
    for (const file of await readdir(this.jarvisHome).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(this.jarvisHome, file)).catch(() => undefined);
      if (content !== undefined) entries.push({ name: file, data: content });
    }
    for (const file of ["jarvis-session-attention.json", "settings.json", "models.json", "model-groups.json"]) {
      const content = await readFile(join(this.options.agentDir, file)).catch(() => undefined);
      if (content !== undefined) entries.push({ name: `agent/${file}`, data: content });
    }
    if (entries.length === 0) return undefined;
    await mkdir(this.directory, { recursive: true });
    await atomicWrite(target, createZip(entries));
    await this.prune();
    return name;
  }

  async prune(): Promise<void> {
    const keep = this.options.keep ?? SNAPSHOT_KEEP;
    const snapshots = await this.list();
    for (const snapshot of snapshots.slice(keep)) await rm(join(this.directory, snapshot.name), { force: true });
  }

  /** 启动时检查一次，之后每 6 小时检查一次（跨天时补上）。 */
  /** 返回的 stop 会等正在写的快照写完，避免关闭时留下半截文件。 */
  start(log: (message: string) => void = () => undefined): () => Promise<void> {
    let running: Promise<void> = Promise.resolve();
    const run = () => {
      running = running.then(() => this.ensureToday()).then((name) => {
        if (name !== undefined) log(`已生成每日快照 ${name}`);
      }).catch(() => undefined);
    };
    run();
    const timer = setInterval(run, 6 * 60 * 60 * 1000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await running;
    };
  }
}
