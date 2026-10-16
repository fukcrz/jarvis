import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRecoveryNoticesForTest, listStartupWarnings } from "./fs.js";
import { acquireInstanceLock } from "./instance-lock.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jarvis-lock-"));
  clearRecoveryNoticesForTest();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("acquireInstanceLock", () => {
  it("writes and releases its own lock", async () => {
    const path = join(dir, "instance.lock");
    const lock = await acquireInstanceLock(1234, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid, port: 1234 });
    expect(listStartupWarnings()).toEqual([]);
    lock.release();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("ignores a stale lock from a dead process", async () => {
    const path = join(dir, "instance.lock");
    await writeFile(path, JSON.stringify({ pid: 2 ** 22 + 12345, port: 9528, startedAt: "x" }));
    const lock = await acquireInstanceLock(1234, path);
    expect(lock.other).toBeUndefined();
    expect(listStartupWarnings()).toEqual([]);
  });

  it("warns but still starts when another live instance holds the directory", async () => {
    const path = join(dir, "instance.lock");
    // 用父进程的 pid 冒充另一个还活着的实例。
    await writeFile(path, JSON.stringify({ pid: process.ppid, port: 9528, startedAt: "x" }));
    const lock = await acquireInstanceLock(1234, path);
    expect(lock.other?.pid).toBe(process.ppid);
    expect(listStartupWarnings()[0]).toContain("同一个数据目录");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
  });

  it("does not warn during a self restart", async () => {
    const path = join(dir, "instance.lock");
    await writeFile(path, JSON.stringify({ pid: process.ppid, port: 9528, startedAt: "x" }));
    await acquireInstanceLock(1234, path, { selfRestart: true });
    expect(listStartupWarnings()).toEqual([]);
  });

  it("does not delete a lock that a newer process took over", async () => {
    const path = join(dir, "instance.lock");
    const lock = await acquireInstanceLock(1234, path);
    await writeFile(path, JSON.stringify({ pid: process.ppid, port: 1, startedAt: "x" }));
    lock.release();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.ppid });
  });
});
