import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailySnapshots } from "./snapshot.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "jarvis-snap-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("DailySnapshots", () => {
  it("snapshots config files once per day and keeps the newest N", async () => {
    const home = join(dir, "home");
    const agent = join(dir, "agent");
    await mkdir(home, { recursive: true });
    await mkdir(agent, { recursive: true });
    await writeFile(join(home, "workspaces.json"), "{\"version\":1}");
    await writeFile(join(home, "notes.txt"), "not json");
    await writeFile(join(agent, "jarvis-session-attention.json"), "{}");
    let now = new Date(2026, 9, 1, 12);
    const snapshots = new DailySnapshots({ jarvisHome: home, agentDir: agent, keep: 3, now: () => now });

    expect(await snapshots.ensureToday()).toBe("2026-10-01.zip");
    expect(await snapshots.ensureToday()).toBeUndefined();
    const listing = execFileSync("unzip", ["-l", join(home, "snapshots", "2026-10-01.zip")], { encoding: "utf8" });
    expect(listing).toContain("workspaces.json");
    expect(listing).toContain("agent/jarvis-session-attention.json");
    expect(listing).not.toContain("notes.txt");

    for (const day of [2, 3, 4, 5]) {
      now = new Date(2026, 9, day, 12);
      await snapshots.ensureToday();
    }
    expect((await readdir(join(home, "snapshots"))).sort()).toEqual(["2026-10-03.zip", "2026-10-04.zip", "2026-10-05.zip"]);
  });
});
