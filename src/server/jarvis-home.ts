import { homedir } from "node:os";
import { join } from "node:path";

/** Jarvis 自己的数据目录：`JARVIS_HOME`，未设置时为 `~/.jarvis`。每次调用都重新读环境变量（测试会切换它）。 */
export function jarvisHome(): string {
  return process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis");
}

/** 本地日期 YYYY-MM-DD（每日快照文件名用）。 */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
