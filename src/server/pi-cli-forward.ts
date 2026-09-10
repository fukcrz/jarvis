import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/**
 * Pi CLI 兼容转发。
 *
 * 派生子进程的 Pi 扩展（pi-subagent、Pi 官方 subagent 示例等）用
 * `process.execPath` + `process.argv[1]` 推导子进程入口。Pi 嵌入 Jarvis 运行时，
 * 这个 argv[1] 是 Jarvis 的服务入口，于是「派子代理」会变成再起一个 Jarvis 服务
 * （端口冲突后退出），子代理从未真正运行。
 *
 * 这类调用带有 Pi CLI 自己的 `--mode` 参数（text/json/rpc），Jarvis 不使用该参数，
 * 因此可以精确识别，并在启动服务之前转发给真正的 Pi CLI。
 */

const PI_CLI_MODES = new Set(["text", "json", "rpc"]);

/** argv 是否为 Pi CLI 调用（带 `--mode text|json|rpc`）。 */
export function isPiCliInvocation(argv: readonly string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    // 与 Pi 的 CLI 解析一致：`--` 之后都是位置参数，不再解析。
    if (token === "--") return false;
    if (token === "--mode") {
      const value = argv[index + 1];
      if (value !== undefined && PI_CLI_MODES.has(value)) return true;
      continue;
    }
    if (token.startsWith("--mode=") && PI_CLI_MODES.has(token.slice("--mode=".length))) return true;
  }
  return false;
}

/** 宿主 Pi 包自带的 CLI 入口；找不到时返回 undefined。 */
export function resolvePiCliEntry(): string | undefined {
  const entry = join(getPackageDir(), "dist", "bundle", "cli.js");
  return existsSync(entry) ? entry : undefined;
}

/**
 * 命中 Pi CLI 调用时转发给真正的 Pi CLI，并以它的退出码结束本进程。
 * 不是 Pi CLI 调用时立即返回，由调用方继续正常启动服务。
 */
export async function forwardPiCliInvocation(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (!isPiCliInvocation(argv)) return;

  const entry = resolvePiCliEntry();
  if (entry === undefined) {
    console.error("jarvis: invoked as the Pi CLI, but no Pi CLI entry was found to forward to");
    process.exit(1);
  }

  const child = spawn(process.execPath, [entry, ...argv], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // 双向透传。调用方可能提前关闭 stdin（EPIPE），这不是错误。
  process.stdin.pipe(child.stdin).on("error", () => {});
  child.stdout.pipe(process.stdout).on("error", () => {});
  child.stderr.pipe(process.stderr).on("error", () => {});
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  child.on("error", (error) => {
    console.error(`jarvis: failed to forward to the Pi CLI: ${error.message}`);
    process.exit(1);
  });

  // 用 close 而非 exit：确保子进程 stdio 已全部冲刷，避免截断 RPC 输出。
  await new Promise<void>((resolve) => {
    child.on("close", (code) => {
      resolve();
      process.exit(code ?? 1);
    });
  });
}
