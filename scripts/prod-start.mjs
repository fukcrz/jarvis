#!/usr/bin/env node

import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import {
  ensureRuntimeDirectories,
  entry,
  healthCheck,
  isJarvisServerListeningOn,
  isJarvisServerProcess,
  listenerPid,
  productionPort,
  requestProcessStop,
  readPid,
  removePidFile,
  runtimePaths,
  startServer,
  processExists,
  waitForHealth,
} from "./prod-service.mjs";

async function main() {
  const port = productionPort();
  const { pidFile, logFile } = runtimePaths(port);

  if (!existsSync(entry)) {
    throw new Error(`生产构建不存在：${entry}\n请先执行 npm run build`);
  }

  ensureRuntimeDirectories(port);
  const trackedPid = readPid(pidFile);
  if (trackedPid !== undefined) {
    if (await isJarvisServerListeningOn(trackedPid, port)) {
      throw new Error(`生产服务已在后台运行（PID ${trackedPid}，端口 ${port}）`);
    }
    removePidFile(pidFile);
  }

  const occupiedPid = await listenerPid(port);
  if (occupiedPid !== undefined) {
    const description = await isJarvisServerProcess(occupiedPid) ? "Jarvis 生产服务" : "其他进程";
    throw new Error(`端口 ${port} 已被${description}占用（PID ${occupiedPid}）；不会自动重启或抢占端口`);
  }
  if (await healthCheck(port)) {
    throw new Error(`端口 ${port} 上已有可用 Jarvis 服务；不会自动重启`);
  }

  const stdout = openSync(logFile, "a");
  let stderr;
  try {
    stderr = openSync(logFile, "a");
  } catch (error) {
    closeSync(stdout);
    throw error;
  }
  let child;
  try {
    child = startServer(port, stdout, stderr);
  } catch (error) {
    closeSync(stdout);
    closeSync(stderr);
    throw error;
  }
  let outputClosed = false;
  const closeOutput = () => {
    if (!outputClosed) {
      outputClosed = true;
      closeSync(stdout);
      closeSync(stderr);
    }
  };
  let startError;
  child.once("spawn", closeOutput);
  child.once("error", (error) => {
    startError = error;
    closeOutput();
  });
  child.unref();

  if (child.pid === undefined) {
    closeOutput();
    throw new Error("无法创建生产服务进程");
  }
  const healthy = startError === undefined && await waitForHealth(port);
  const serverPid = await listenerPid(port);
  if (!healthy || serverPid === undefined || !(await isJarvisServerListeningOn(serverPid, port))) {
    if (serverPid !== undefined && await isJarvisServerProcess(serverPid)) {
      try { await requestProcessStop(serverPid); } catch { /* process may already have exited */ }
    }
    const detail = startError instanceof Error ? `：${startError.message}` : "";
    throw new Error(`服务未能在 30 秒内启动${detail}，请查看 ${logFile}`);
  }

  writeFileSync(pidFile, `${serverPid}\n`, "utf8");
  console.log(`生产服务已在后台启动：PID ${serverPid}，http://127.0.0.1:${port}`);
  console.log(`日志：${logFile}`);
}

main().catch((error) => {
  console.error(`prod:start 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
