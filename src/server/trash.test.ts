import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrashService } from "./trash.js";

let directory: string;
let trash: TrashService;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-trash-test-"));
  trash = new TrashService(join(directory, "trash"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("TrashService", () => {
  it("moves a file into the trash and restores it to the original path", async () => {
    const file = join(directory, "work", "notes.txt");
    await mkdir(join(directory, "work"));
    await writeFile(file, "hello");

    const entry = await trash.moveToTrash(file, { kind: "file" });
    expect(entry).toMatchObject({ kind: "file", label: "notes.txt", originalPath: file });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await trash.list()).toHaveLength(1);

    const restored = await trash.restore(entry?.id ?? "");
    expect(restored.restoredPath).toBe(file);
    await expect(readFile(file, "utf8")).resolves.toBe("hello");
    expect(await trash.list()).toEqual([]);
  });

  it("moves whole directories", async () => {
    const folder = join(directory, "work", "src");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "a.ts"), "a");
    const entry = await trash.moveToTrash(folder, { kind: "file" });
    expect(entry?.isDirectory).toBe(true);
    await trash.restore(entry?.id ?? "");
    await expect(readFile(join(folder, "a.ts"), "utf8")).resolves.toBe("a");
  });

  it("does not overwrite a file that reappeared at the original path", async () => {
    const file = join(directory, "a.jsonl");
    await writeFile(file, "old");
    const entry = await trash.moveToTrash(file, { kind: "session", label: "会话 A", sessionId: "s1", workspaceId: "w1" });
    await writeFile(file, "new");
    const restored = await trash.restore(entry?.id ?? "");
    expect(restored.restoredPath).toBe(join(directory, "a (恢复).jsonl"));
    await expect(readFile(file, "utf8")).resolves.toBe("new");
    await expect(readFile(restored.restoredPath, "utf8")).resolves.toBe("old");
  });

  it("returns undefined for a path that does not exist", async () => {
    await expect(trash.moveToTrash(join(directory, "nope"), { kind: "file" })).resolves.toBeUndefined();
  });

  it("purges entries older than the retention period", async () => {
    const keep = join(directory, "keep.txt");
    const old = join(directory, "old.txt");
    await writeFile(keep, "k");
    await writeFile(old, "o");
    const oldEntry = await trash.moveToTrash(old, { kind: "file" });
    await trash.moveToTrash(keep, { kind: "file" });
    const metaPath = join(directory, "trash", oldEntry?.id ?? "", "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    await writeFile(metaPath, JSON.stringify({ ...meta, deletedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }));

    await expect(trash.purgeExpired()).resolves.toBe(1);
    expect((await trash.list()).map((entry) => entry.label)).toEqual(["keep.txt"]);
  });

  it("cleans stray directories without metadata only after an hour", async () => {
    const stray = join(directory, "trash", "stray");
    await mkdir(stray, { recursive: true });
    await expect(trash.purgeExpired()).resolves.toBe(0);
    const past = new Date(Date.now() - 2 * 3_600_000);
    await utimes(stray, past, past);
    await expect(trash.purgeExpired()).resolves.toBe(1);
    expect(await readdir(join(directory, "trash"))).toEqual([]);
  });

  it("rejects ids that try to escape the trash directory", async () => {
    await expect(trash.restore("../etc")).rejects.toMatchObject({ code: "TRASH_NOT_FOUND" });
  });
});
