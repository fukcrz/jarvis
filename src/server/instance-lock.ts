import { readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { addStartupWarning, atomicWrite } from "./fs.js";
import { jarvisHome } from "./jarvis-home.js";

interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
  host?: string;
}

export function defaultLockPath(): string {
  return join(jarvisHome(), "instance.lock");
}

/**
 * 实例锁：在数据目录记下占用它的进程和端口。发现另一个还活着的 Jarvis 用着同一个目录时，
 * 只提示（两边同时改配置会互相覆盖），不拦着启动。返回释放函数。
 */
export async function acquireInstanceLock(port: number, path = defaultLockPath(), options: { selfRestart?: boolean } = {}): Promise<{ release: () => void; other?: LockInfo }> {
  const other = await readLock(path);
  const otherAlive = other !== undefined && other.pid !== process.pid && (other.host === undefined || other.host === hostname()) && isAlive(other.pid);
  if (otherAlive && options.selfRestart !== true) {
    addStartupWarning(`另一个 Jarvis（进程 ${String(other.pid)}，端口 ${String(other.port)}）也在使用同一个数据目录。两边同时修改工作区或设置会互相覆盖，建议只开一个，或给开发版设置单独的 JARVIS_HOME。`);
  }
  const mine: LockInfo = { pid: process.pid, port, startedAt: new Date().toISOString(), host: hostname() };
  await atomicWrite(path, `${JSON.stringify(mine, null, 2)}\n`).catch(() => undefined);
  return {
    ...(otherAlive ? { other } : {}),
    // 同步实现：在 process.on("exit") 里也能用。只删自己的锁（自重启时新进程已经写了它的）。
    release: () => {
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
        if (current.pid === process.pid) rmSync(path, { force: true });
      } catch {
        // 文件不在或读不了，都不用管。
      }
    },
  };
}

async function readLock(path: string): Promise<LockInfo | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockInfo>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") return undefined;
    return { pid: parsed.pid, port: parsed.port, startedAt: String(parsed.startedAt ?? ""), ...(typeof parsed.host === "string" ? { host: parsed.host } : {}) };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}
