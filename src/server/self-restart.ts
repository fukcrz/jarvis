import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import { AppError } from "./errors.js";
import type { EventHub } from "./event-hub.js";

/**
 * 自举式重启：当前进程 spawn 一个新进程（同一入口文件）接管服务，
 * 然后优雅关闭自己。新进程通过 JARVIS_SELF_RESTART=1 识别自己，
 * 在端口被旧进程占用时轮询重试 listen（处理 TIME_WAIT / 释放窗口）。
 *
 * 只做 reload（加载现有 dist/），不做编译——编译由开发环境随时执行。
 */
export function registerSelfRestart(app: FastifyInstance, events: EventHub): void {
  let restarting = false;

  app.post("/api/self/restart", async (request, reply) => {
    if (process.env["NODE_ENV"] !== "production") {
      throw new AppError("SELF_RESTART_PRODUCTION_ONLY", "自重启仅支持生产模式（NODE_ENV=production）", 400);
    }
    if (restarting) {
      throw new AppError("SELF_RESTART_IN_PROGRESS", "服务正在重启中，请稍候", 409);
    }
    restarting = true;
    events.broadcastWorkspace({
      version: PROTOCOL_VERSION,
      type: "extension.notify",
      notification: { id: randomUUID(), message: "服务即将重启，连接将短暂中断后自动恢复…" },
    });
    void scheduleRestart(app, events, () => { restarting = false; });
    return reply.code(202).send({ restarting: true });
  });
}

function scheduleRestart(app: FastifyInstance, events: EventHub, onFailed: () => void): void {
  setImmediate(() => {
    void (async () => {
      try {
        spawnChild();
        await closeGracefully(app, events);
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, "Self-restart failed; keeping the current process alive");
        onFailed();
      }
    })();
  });
}

/** 与 index.ts 同目录的入口文件；编译后为 dist/server/server/index.js。 */
function childEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

function spawnChild(): void {
  const child = spawn(process.execPath, [childEntry()], {
    env: { ...process.env, JARVIS_SELF_RESTART: "1" },
    stdio: "inherit",
    detached: true,
    windowsHide: true,
  });
  // 旧进程退出后新进程继续运行（否则父进程退出会带走子进程）。
  child.unref();
  child.on("error", (error) => {
    console.error("jarvis: failed to spawn replacement process:", error.message);
  });
}

async function closeGracefully(app: FastifyInstance, events: EventHub): Promise<void> {
  events.terminateAll();
  const forceExit = setTimeout(() => process.exit(0), 5_000);
  forceExit.unref();
  try {
    await app.close();
  } finally {
    clearTimeout(forceExit);
  }
}
