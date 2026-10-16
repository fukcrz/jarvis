import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyLogFile } from "./log-files.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-logs-test-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("DailyLogFile", () => {
  it("writes one file per local day", async () => {
    let now = new Date(2026, 9, 16, 23, 59);
    const log = new DailyLogFile(directory, "server", 1024 * 1024, 7, () => now);
    log.write("first");
    now = new Date(2026, 9, 17, 0, 1);
    log.write("second\n");
    expect((await readdir(directory)).sort()).toEqual(["server-2026-10-16.log", "server-2026-10-17.log"]);
    await expect(readFile(join(directory, "server-2026-10-16.log"), "utf8")).resolves.toBe("first\n");
    await expect(readFile(join(directory, "server-2026-10-17.log"), "utf8")).resolves.toBe("second\n");
  });

  it("rolls over to numbered parts when a file reaches the size cap", async () => {
    const now = new Date(2026, 9, 16, 12);
    const log = new DailyLogFile(directory, "server", 20, 7, () => now);
    log.write("0123456789");
    log.write("0123456789");
    log.write("abc");
    expect((await readdir(directory)).sort()).toEqual(["server-2026-10-16.1.log", "server-2026-10-16.log"]);
  });

  it("deletes logs older than the retention period", async () => {
    await writeFile(join(directory, "server-2026-10-01.log"), "old");
    await writeFile(join(directory, "desktop-2026-10-02.1.log"), "old");
    await writeFile(join(directory, "server-2026-10-12.log"), "recent");
    await writeFile(join(directory, "notes.txt"), "keep");
    const log = new DailyLogFile(directory, "server", 1024, 7, () => new Date(2026, 9, 16, 12));
    log.write("today");
    expect((await readdir(directory)).sort()).toEqual(["notes.txt", "server-2026-10-12.log", "server-2026-10-16.log"]);
  });

  it("never throws when the directory cannot be created", () => {
    const log = new DailyLogFile(join(directory, "\0bad"), "server");
    expect(() => log.write("x")).not.toThrow();
  });
});
