import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { jarvisHome } from "./jarvis-home.js";

export const LOG_RETENTION_DAYS = 7;
export const LOG_FILE_MAX_BYTES = 20 * 1024 * 1024;

export function defaultLogDirectory(): string {
  return join(jarvisHome(), "logs");
}

/**
 * 按天写的日志文件：`<prefix>-YYYY-MM-DD.log`，单个文件超过上限后续写到 `.1.log`、`.2.log`……
 * 保留最近 7 天。写日志失败（磁盘满、权限）只会丢这一行，不影响服务。
 */
export class DailyLogFile {
  private currentDay = "";
  private currentPath = "";
  private currentSize = 0;
  private part = 0;
  private lastPrune = 0;

  constructor(
    readonly directory = defaultLogDirectory(),
    private readonly prefix = "server",
    private readonly maxBytes = LOG_FILE_MAX_BYTES,
    private readonly retentionDays = LOG_RETENTION_DAYS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(line: string): void {
    try {
      const text = line.endsWith("\n") ? line : `${line}\n`;
      this.rollIfNeeded(Buffer.byteLength(text));
      appendFileSync(this.currentPath, text);
      this.currentSize += Buffer.byteLength(text);
    } catch {
      // 日志写不进去不能影响服务。
    }
  }

  /** 当前正在写的文件路径（可能还没创建）。 */
  path(): string {
    this.rollIfNeeded(0);
    return this.currentPath;
  }

  private rollIfNeeded(incoming: number): void {
    const date = this.now();
    const day = localDay(date);
    if (day !== this.currentDay) {
      mkdirSync(this.directory, { recursive: true });
      this.currentDay = day;
      this.part = 0;
      this.openPart();
      this.prune(date.getTime());
    }
    while (this.currentSize > 0 && this.currentSize + incoming > this.maxBytes) {
      this.part += 1;
      this.openPart();
    }
  }

  private openPart(): void {
    this.currentPath = join(this.directory, `${this.prefix}-${this.currentDay}${this.part === 0 ? "" : `.${String(this.part)}`}.log`);
    try {
      this.currentSize = statSync(this.currentPath).size;
    } catch {
      this.currentSize = 0;
    }
  }

  /** 删除超过保留天数的日志（按文件名里的日期判断，所有前缀一起清）。 */
  prune(nowMs = this.now().getTime()): void {
    if (nowMs - this.lastPrune < 60 * 60 * 1000 && this.lastPrune !== 0) return;
    this.lastPrune = nowMs;
    const cutoff = localDay(new Date(nowMs - this.retentionDays * 24 * 60 * 60 * 1000));
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/.exec(name);
      if (match?.[1] !== undefined && match[1] < cutoff) rmSync(join(this.directory, name), { force: true });
    }
  }
}

/** 本地日期 YYYY-MM-DD（日志文件名、每日快照共用）。 */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 给 Fastify/pino 用的输出流：照常写到 stdout，同时写一份到按天的日志文件。 */
export function teeLogStream(file: DailyLogFile, out: NodeJS.WritableStream = process.stdout): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      file.write(text);
      out.write(text);
      callback();
    },
  });
}

/** console.warn / console.error 也写进日志文件（插件、Pi 的报错常走这里）。 */
export function teeConsole(file: DailyLogFile): void {
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      file.write(JSON.stringify({ level, time: Date.now(), msg: args.map(formatArg).join(" ") }));
    };
  }
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
