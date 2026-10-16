import * as fsp from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWrite, backupPath, clearRecoveryNoticesForTest, listRecoveryNotices, readJsonRecovering, withFsRetry, writeWithBackup } from "./fs.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-fs-test-"));
  clearRecoveryNoticesForTest();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { force: true, recursive: true });
});

const parseVersioned = (value: unknown): { version: 1; name: string } => {
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 1) throw new Error("bad format");
  return value as { version: 1; name: string };
};

describe("atomicWrite", () => {
  it("writes the content and leaves no temporary files", async () => {
    const path = join(directory, "a.json");
    await atomicWrite(path, "one");
    await atomicWrite(path, "two");
    await expect(readFile(path, "utf8")).resolves.toBe("two");
    expect(await readdir(directory)).toEqual(["a.json"]);
  });

  it("cleans up the temporary file when the rename fails", async () => {
    const path = join(directory, "missing-dir", "a.json");
    await expect(atomicWrite(path, "x")).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans up the temporary file when the target is a directory", async () => {
    await fsp.mkdir(join(directory, "target"));
    await expect(atomicWrite(join(directory, "target"), "x")).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("withFsRetry", () => {
  it("retries transient EPERM/EBUSY errors", async () => {
    let calls = 0;
    const result = await withFsRetry(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: calls === 1 ? "EPERM" : "EBUSY" });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(withFsRetry(async () => {
      calls += 1;
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    })).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget", async () => {
    let calls = 0;
    await expect(withFsRetry(async () => {
      calls += 1;
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    })).rejects.toThrow("locked");
    expect(calls).toBe(8);
  });
});

describe("writeWithBackup + readJsonRecovering", () => {
  it("keeps the previous content as .bak", async () => {
    const path = join(directory, "settings.json");
    await writeWithBackup(path, JSON.stringify({ version: 1, name: "first" }));
    await writeWithBackup(path, JSON.stringify({ version: 1, name: "second" }));
    expect(JSON.parse(await readFile(backupPath(path), "utf8"))).toEqual({ version: 1, name: "first" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, name: "second" });
  });

  it("returns missing when neither file nor backup exists", async () => {
    await expect(readJsonRecovering(join(directory, "none.json"), parseVersioned)).resolves.toEqual({ value: undefined, source: "missing" });
    expect(listRecoveryNotices()).toEqual([]);
  });

  it("restores a truncated file from the backup and keeps the corrupt copy", async () => {
    const path = join(directory, "workspaces.json");
    await writeWithBackup(path, JSON.stringify({ version: 1, name: "good" }));
    await writeWithBackup(path, JSON.stringify({ version: 1, name: "newer" }));
    await writeFile(path, "\0\0\0\0");

    const result = await readJsonRecovering(path, parseVersioned);
    expect(result).toEqual({ value: { version: 1, name: "good" }, source: "backup" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, name: "good" });
    const names = await readdir(directory);
    const corrupt = names.find((name) => name.startsWith("workspaces.json.corrupt-"));
    expect(corrupt).toBeDefined();
    await expect(readFile(join(directory, corrupt ?? ""), "utf8")).resolves.toBe("\0\0\0\0");
    expect(listRecoveryNotices()).toMatchObject([{ file: path, outcome: "backup" }]);
  });

  it("treats a file that fails validation like a corrupt file", async () => {
    const path = join(directory, "prefs.json");
    await writeFile(backupPath(path), JSON.stringify({ version: 1, name: "bak" }));
    await writeFile(path, JSON.stringify({ version: 9 }));
    await expect(readJsonRecovering(path, parseVersioned)).resolves.toMatchObject({ value: { name: "bak" }, source: "backup" });
  });

  it("falls back to defaults when there is no usable backup", async () => {
    const path = join(directory, "auth.json");
    await writeFile(path, "{");
    await writeFile(backupPath(path), "also broken");
    await expect(readJsonRecovering(path, parseVersioned)).resolves.toEqual({ value: undefined, source: "default" });
    expect((await readdir(directory)).some((name) => name.startsWith("auth.json.corrupt-"))).toBe(true);
    expect(listRecoveryNotices()).toMatchObject([{ outcome: "default" }]);
  });

  it("uses the backup when the main file has vanished", async () => {
    const path = join(directory, "tunnel.json");
    await writeFile(backupPath(path), JSON.stringify({ version: 1, name: "bak" }));
    await expect(readJsonRecovering(path, parseVersioned)).resolves.toMatchObject({ source: "backup" });
    await expect(readFile(path, "utf8")).resolves.toContain("bak");
  });
});
