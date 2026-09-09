#!/usr/bin/env node

import {
  isJarvisServerListeningOn,
  isJarvisServerProcess,
  listenerPid,
  processExists,
  productionPort,
  forceProcessStop,
  readPid,
  removePidFile,
  requestProcessStop,
  runtimePaths,
  waitForExit,
} from "./prod-service.mjs";

async function main() {
  const port = productionPort();
  const { launcherFile, pidFile } = runtimePaths(port);
  let pid = readPid(pidFile);

  if (pid !== undefined && !(await isJarvisServerListeningOn(pid, port))) {
    removePidFile(pidFile);
    pid = undefined;
  }

  if (pid === undefined) {
    const listener = await listenerPid(port);
    if (listener !== undefined && await isJarvisServerListeningOn(listener, port)) pid = listener;
  }

  if (pid === undefined) {
    console.log(`未发现端口 ${port} 上运行的 Jarvis 生产服务`);
    return;
  }

  console.log(`正在停止 Jarvis 生产服务（PID ${pid}，端口 ${port}）…`);
  try {
    await requestProcessStop(pid);
  } catch (error) {
    if (processExists(pid)) throw error;
  }
  if (!await waitForExit(pid)) {
    console.warn("30 秒内未退出，发送强制停止信号…");
    try {
      await forceProcessStop(pid);
    } catch (error) {
      if (processExists(pid)) throw error;
    }
    if (!await waitForExit(pid, 5_000)) throw new Error(`进程 ${pid} 未能停止`);
  }

  if (!processExists(pid)) {
    removePidFile(pidFile);
    removePidFile(launcherFile);
  }
  console.log("生产服务已停止");
}

main().catch((error) => {
  console.error(`prod:stop 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
