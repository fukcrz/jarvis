import { Writable } from "node:stream";

/**
 * 最近的服务日志，只放内存（不写文件）：导出诊断包时带上。
 * 超过行数或字节上限时丢掉最旧的。
 */
export class RecentLogs {
  private lines: string[] = [];
  private bytes = 0;

  constructor(private readonly maxLines = 2000, private readonly maxBytes = 2 * 1024 * 1024) {}

  push(text: string): void {
    for (const raw of text.split("\n")) {
      if (raw.length === 0) continue;
      const line = raw.length > 8_000 ? `${raw.slice(0, 8_000)}…` : raw;
      this.lines.push(line);
      this.bytes += line.length + 1;
    }
    while (this.lines.length > this.maxLines || (this.bytes > this.maxBytes && this.lines.length > 1)) {
      this.bytes -= (this.lines.shift()?.length ?? 0) + 1;
    }
  }

  text(): string {
    return this.lines.length === 0 ? "" : `${this.lines.join("\n")}\n`;
  }
}

/** 给 Fastify/pino 用的输出流：照常写到 stdout，同时记一份到内存。 */
export function teeLogStream(recent: RecentLogs, out: NodeJS.WritableStream = process.stdout): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      recent.push(text);
      out.write(text);
      callback();
    },
  });
}

/** console.warn / console.error 也记进内存日志（插件、Pi 的报错常走这里）。 */
export function teeConsole(recent: RecentLogs): void {
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      recent.push(JSON.stringify({ level, time: Date.now(), msg: args.map(formatArg).join(" ") }));
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
