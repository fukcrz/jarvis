#!/usr/bin/env node
// restart-now.mjs — 立即重启 9528 生产服务，跳过 idle 等待。
//
// 与 prod-restart.mjs 的区别：
//   - prod-restart.mjs 会先 poll /api，等待所有 run 进入 idle 再切换。
//   - 本脚本用于「用户明确接受断连」的场景：直接 SIGTERM 旧进程，再拉起新的。
//
// 必须以完全脱离 shell 的方式运行，否则 JARVIS 自身重启会带走它：
//   setsid nohup node scripts/restart-now.mjs >> logs/restart-now.log 2>&1 < /dev/null &

import { appendFileSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env["JARVIS_PORT"] ?? 9528);
const entry = join(root, "dist", "server", "server", "index.js");
const logFile = join(root, "logs", "restart-now.log");
const prodLog = join(root, "logs", "prod.log");
const SHUTDOWN_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 60_000;

function log(line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  console.log(message);
  try { appendFileSync(logFile, message + "\n"); } catch { /* */ }
}

function findServerProcess() {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
      if (!cmdline.includes("dist/server/server/index.js")) continue;
      const argv0 = cmdline.split(" ")[0];
      if (argv0 !== "node" && !argv0.endsWith("/node")) continue;
      return Number(name);
    } catch { /* 进程可能刚退出 */ }
  }
  return undefined;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function waitForHealthUp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* 重试 */ }
    await new Promise((r) => setTimeout(r, 500));
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
  log(`restart-now 启动：端口 ${port}`);
  if (!existsSync(entry)) {
    log(`ERROR: 生产构建不存在：${entry}`);
    process.exit(1);
  }

  const oldPid = findServerProcess();
  if (oldPid === undefined) {
    log("WARN: 未找到运行中的生产进程，直接启动新实例");
  } else {
    log(`stop: 向旧进程 ${oldPid} 发送 SIGTERM`);
    try { process.kill(oldPid, "SIGTERM"); } catch (e) { log(`WARN: kill 失败: ${e.message}`); }
    if (await waitForProcessExit(oldPid, SHUTDOWN_TIMEOUT_MS)) {
      log("stop: 旧进程已退出");
    } else {
      log(`WARN: ${SHUTDOWN_TIMEOUT_MS / 1000}s 内未退出，发送 SIGKILL`);
      try { process.kill(oldPid, "SIGKILL"); } catch { /* 进程可能刚退出 */ }
      await waitForProcessExit(oldPid, SHUTDOWN_TIMEOUT_MS);
    }
  }

  if (findServerProcess() !== undefined) {
    log("ERROR: 旧进程仍存活，端口未释放，放弃启动");
    process.exit(1);
  }
  log(`start: 启动新进程…`);
  const newPid = startServer();
  log(`start: 新 PID = ${newPid}`);

  const healthy = await waitForHealthUp(STARTUP_TIMEOUT_MS);
  if (healthy && processExists(newPid)) {
    log(`done: 服务已健康（PID ${newPid}），WebSocket 重连后即可继续`);
    process.exit(0);
  }
  if (!processExists(newPid)) {
    log(`ERROR: 新进程已退出，请查看 ${prodLog}`);
    process.exit(1);
  }
  log("ERROR: 新进程未在 60s 内通过健康检查");
  process.exit(1);
}

main().catch((e) => {
  log(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
