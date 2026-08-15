#!/usr/bin/env node
// prod-restart.mjs — 安全重启生产 Jarvis（9528），不打断进行中的会话 run。
//
// 背景：Pi 会话运行在 Jarvis 服务进程内部，直接 kill/restart 会中断
// 正在执行的 run（当前 AI 回复、bash 命令、压缩等都会被截断）。
// 本脚本先在外部轮询 /api，等待所有会话回到 idle，再优雅关停旧进程
// 并用与原始启动一致的方式拉起新进程，从而做到「改完代码不杀自己」。
//
// 用法：
//   node scripts/prod-restart.mjs            # 等所有 run 空闲后重启（默认 9528）
//   JARVIS_PORT=39130 node scripts/prod-restart.mjs
//
// 建议以脱离终端的方式运行：
//   setsid nohup node scripts/prod-restart.mjs >> logs/restart.log 2>&1 < /dev/null &

import { appendFileSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env["JARVIS_PORT"] ?? 9528);
const entry = join(root, "dist", "server", "server", "index.js");
const logFile = join(root, "logs", "restart.log");
const prodLog = join(root, "logs", "prod.log");
const base = `http://127.0.0.1:${port}`;

const POLL_MS = 2_000;
const GRACE_MS = 15_000;          // 全部空闲后再等一会儿，让最后一条回复完整渲染
const MAX_WAIT_MS = Number(process.env["JARVIS_MAX_WAIT_MS"] ?? 15 * 60_000); // 最长等待窗口
const SHUTDOWN_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 60_000;

function log(line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  console.log(message);
  try { appendFileSync(logFile, message + "\n"); } catch { /* log 目录不可用时不阻塞 */ }
}

async function fetchJson(path, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + path, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 是否有任何会话正在运行（进行中的 run 会被重启打断，必须先等它结束）。 */
async function anySessionRunning() {
  const body = await fetchJson("/api/workspaces");
  if (body === undefined) return true; // 服务不可达：按「忙」处理，继续等待
  const workspaces = body["workspaces"];
  if (!Array.isArray(workspaces)) return true;
  for (const workspace of workspaces) {
    const sessionsBody = await fetchJson(`/api/workspaces/${workspace["id"]}/sessions`);
    const sessions = sessionsBody?.["sessions"];
    if (!Array.isArray(sessions)) continue;
    for (const session of sessions) {
      if (session["runState"] !== "idle") {
        log(`wait: 会话 ${workspace["label"] ?? workspace["id"]} / ${session["id"]} runState=${String(session["runState"])}`);
        return true;
      }
    }
  }
  return false;
}

/** 找到生产服务进程：cmdline 含目标入口，且 argv[0] 是 node（排除 bash 等启动器包装）。 */
function findServerProcess() {
  for (const entryName of readdirSync("/proc")) {
    if (!/^\d+$/.test(entryName)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entryName}/cmdline`, "utf8").replaceAll("\0", " ");
      if (!cmdline.includes("dist/server/server/index.js")) continue;
      const argv0 = cmdline.split(" ")[0];
      if (argv0 !== "node" && !argv0.endsWith("/node")) continue;
      return Number(entryName);
    } catch {
      // 进程可能刚退出，跳过
    }
  }
  return undefined;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 以「进程是否消失」判断关停完成（服务 close 期间会拒连，health 不可达≠进程已退出）。 */
async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

async function waitForHealthUp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fetchJson("/api/health", 1_500)) !== undefined) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

function startServer() {
  const output = openSync(prodLog, "a");
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    detached: true,
    stdio: ["ignore", output, output],
  });
  child.unref();
  return child.pid;
}

async function main() {
  log(`prod-restart 启动：端口 ${port}，等待所有会话空闲后重启`);
  if (!existsSync(entry)) {
    log(`ERROR: 生产构建不存在：${entry}（先执行 npm run build）`);
    process.exit(1);
  }

  // 阶段 1：等待全部会话 idle（防止重启打断进行中的 run）。
  const deadline = Date.now() + MAX_WAIT_MS;
  let firstBusyLogged = false;
  while (await anySessionRunning()) {
    if (!firstBusyLogged) {
      log("wait: 存在进行中的 run，重启将推迟到会话空闲…");
      firstBusyLogged = true;
    }
    if (Date.now() > deadline) {
      log("ABORT: 等待超时（15 分钟），未执行重启，请手动处理运行中的任务");
      process.exit(1);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS));
  }
  log("idle: 所有会话已空闲");

  // 阶段 2：空闲确认后的缓冲期，再复查一次，避免缓冲期内新起的 run 被误杀。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, GRACE_MS));
  if (await anySessionRunning()) {
    log("wait: 缓冲期内出现新 run，回到等待状态");
    return main();
  }

  // 阶段 3：优雅关停旧进程（SIGTERM → 服务端 close() 会先 dispose 全部会话）。
  const oldPid = findServerProcess();
  if (oldPid === undefined) {
    log("WARN: 未找到运行中的生产服务进程，跳过关停，直接启动");
  } else {
    log(`stop: 发送 SIGTERM 给旧进程 ${oldPid}`);
    try {
      process.kill(oldPid, "SIGTERM");
    } catch (error) {
      log(`WARN: 向 ${oldPid} 发送 SIGTERM 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (await waitForProcessExit(oldPid, SHUTDOWN_TIMEOUT_MS)) {
      log("stop: 旧进程已退出");
    } else {
      log(`WARN: ${SHUTDOWN_TIMEOUT_MS / 1000}s 内未退出，发送 SIGKILL`);
      try { process.kill(oldPid, "SIGKILL"); } catch { /* 进程可能已退出 */ }
      await waitForProcessExit(oldPid, SHUTDOWN_TIMEOUT_MS);
    }
  }

  // 阶段 4：以与原始启动一致的方式拉起新进程（nohup 语义：detached + 日志落盘）。
  // 注意：必须等旧进程真正退出、端口释放后再 spawn，否则新进程会 EADDRINUSE 崩溃。
  if (findServerProcess() !== undefined) {
    log("ERROR: 旧进程仍存活，端口未释放，放弃启动以避免 EADDRINUSE");
    process.exit(1);
  }
  log(`start: 启动新进程（${entry}）…`);
  const newPid = startServer();
  const healthy = await waitForHealthUp(STARTUP_TIMEOUT_MS);
  if (healthy && processExists(newPid)) {
    const health = await fetchJson("/api/health");
    log(`done: 服务已恢复（PID ${newPid}）${health !== undefined ? JSON.stringify(health) : ""}`);
    log("done: 重启完成 — 前端会自动重连并重新同步");
  } else if (!processExists(newPid)) {
    log(`ERROR: 新进程（PID ${newPid}）已退出，可能端口冲突或启动失败，请查看 logs/prod.log`);
    process.exit(1);
  } else {
    log("ERROR: 新进程未在 60s 内通过健康检查，请查看 logs/prod.log");
    process.exit(1);
  }
}

main().catch((error) => {
  log(`FATAL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
