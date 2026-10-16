import { homedir } from "node:os";
import { join } from "node:path";

/** Jarvis 自己的数据目录：`JARVIS_HOME`，未设置时为 `~/.jarvis`。每次调用都重新读环境变量（测试会切换它）。 */
export function jarvisHome(): string {
  return process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis");
}
