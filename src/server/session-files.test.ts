import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSessionFiles, readSessionFileHeader, readSessionListCopy } from "./session-files.js";

describe("readSessionListCopy", () => {
  it("stops after the first user preview and still sees a later rename in the tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-session-copy-"));
    const path = join(directory, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: directory }),
        JSON.stringify({ type: "session_info", id: "info1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", name: "Original" }),
        JSON.stringify({ type: "message", id: "u1", parentId: "info1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "First preview", timestamp: Date.parse("2026-01-01T00:00:01.000Z") } }),
      ];
      for (let index = 0; index < 4_000; index += 1) {
        lines.push(JSON.stringify({
          type: "message",
          id: `pad-${String(index)}`,
          parentId: "u1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "assistant", content: `padding ${String(index)} ${"x".repeat(80)}`, timestamp: 1 },
        }));
      }
      lines.push(JSON.stringify({ type: "session_info", id: "info2", parentId: "u1", timestamp: "2026-01-01T00:00:03.000Z", name: "Renamed" }));
      await writeFile(path, `${lines.join("\n")}\n`);
      const copy = await readSessionListCopy(path);
      expect(copy).toEqual({ name: "Renamed", preview: "First preview" });
      expect((await stat(path)).size).toBeGreaterThan(64 * 1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("subagent thread sessions", () => {
  const header = (id: string, cwd: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
  const marker = JSON.stringify({ type: "custom", customType: "pi-subagent:thread:v1", data: { rootId: "main", threadPath: "/root/map-auth" }, id: "own1", parentId: "info1", timestamp: "2026-01-01T00:00:01.000Z" });
  const userText = (text: string) => JSON.stringify({ type: "message", id: "u1", parentId: "own1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: text, timestamp: 1 } });

  it("marks a child session by its ownership entry and ignores the marker inside later messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-subagent-session-"));
    const previous = process.env["PI_CODING_AGENT_SESSION_DIR"];
    process.env["PI_CODING_AGENT_SESSION_DIR"] = directory;
    try {
      const child = join(directory, "child.jsonl");
      const main = join(directory, "main.jsonl");
      await writeFile(child, [header("child", directory), marker, userText("do it")].join("\n") + "\n");
      await writeFile(main, [
        header("main", directory),
        JSON.stringify({ type: "session_info", id: "info1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", name: "Main" }),
        userText(marker),
      ].join("\n") + "\n");
      expect((await readSessionFileHeader(child))?.subagentThread).toBe(true);
      expect((await readSessionFileHeader(main))?.subagentThread).toBeUndefined();
      const listed = await listSessionFiles({ id: "w", cwd: directory, label: "w", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
      expect(listed.map((file) => file.id)).toEqual(["main"]);
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
      else process.env["PI_CODING_AGENT_SESSION_DIR"] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
