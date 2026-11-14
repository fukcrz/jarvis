import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionService } from "./session-service.js";
import { filterSubagentInheritedEntries, readSubagentSessionBranch, listSessionFiles, readSessionFileHeader, readSessionListCopy } from "./session-files.js";

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

describe("subagent inherited entry filtering", () => {
  it("filters inherited message and custom_message entries after the ownership marker, even with compaction", () => {
    const entries = [
      { type: "message", id: "parent-prefix", message: { role: "user", content: "parent context" } },
      { type: "custom", id: "ownership", customType: "pi-subagent:thread:v1" },
      { type: "message", id: "inherited-user", message: { role: "user", content: "copied prompt" } },
      { type: "custom_message", id: "inherited-custom", customType: "context", content: "copied custom" },
      { type: "compaction", id: "compact", summary: "summary" },
      { type: "message", id: "child-answer", message: { role: "assistant", content: "answer" } },
    ];
    expect(filterSubagentInheritedEntries(entries, 2).map((entry) => (entry as { id: string }).id)).toEqual(["compact", "child-answer"]);
  });
});

describe("subagent thread sessions", () => {
  const header = (id: string, cwd: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
  const marker = JSON.stringify({ type: "custom", customType: "pi-subagent:thread:v1", data: { rootId: "main", threadPath: "/root/map-auth", inheritedCount: 0 }, id: "own1", parentId: "info1", timestamp: "2026-01-01T00:00:01.000Z" });
  const userText = (text: string) => JSON.stringify({ type: "message", id: "u1", parentId: "own1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: text, timestamp: 1 } });

  it("marks a child session by its ownership entry and ignores the marker inside later messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-subagent-session-"));
    const previous = process.env["PI_CODING_AGENT_SESSION_DIR"];
    process.env["PI_CODING_AGENT_SESSION_DIR"] = directory;
    try {
      const child = join(directory, "2026-01-01T00-00-00-000Z_child.jsonl");
      const main = join(directory, "main.jsonl");
      await writeFile(child, [header("child", directory), JSON.stringify({ type: "session_info", id: "info1", parentId: null, timestamp: "2026-01-01T00:00:00.500Z", name: "Child" }), marker, userText("do it")].join("\n") + "\n");
      await writeFile(main, [
        header("main", directory),
        JSON.stringify({ type: "session_info", id: "info1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", name: "Main" }),
        userText(marker),
      ].join("\n") + "\n");
      expect((await readSessionFileHeader(child))?.subagentThread).toBe(true);
      expect((await readSessionFileHeader(main))?.subagentThread).toBeUndefined();
      const before = await stat(child);
      const branch = readSubagentSessionBranch({ id: "w", cwd: directory, label: "w", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" }, "child", "main", "/root/map-auth");
      expect(branch?.inheritedCount).toBe(0);
      expect(branch?.entries).toHaveLength(3);
      expect(readSubagentSessionBranch({ id: "w", cwd: directory, label: "w", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" }, "child", "other", "/root/map-auth")).toBeUndefined();
      expect((await stat(child)).mtimeMs).toBe(before.mtimeMs);
      const parentRef = { workspaceId: "w", sessionId: "main" };
      const getActive = vi.fn(() => { throw new Error("must not activate a child session"); });
      const service = { workspaces: { get: () => ({ id: "w", cwd: directory }) }, getActive } as unknown as SessionService;
      const page = await SessionService.prototype.subagentTimeline.call(service, parentRef, "child", "/root/map-auth", undefined, 1);
      expect(page.items).toHaveLength(1);
      expect(page.start).toBe(0);
      expect(getActive).not.toHaveBeenCalled();
      await expect(SessionService.prototype.subagentTimeline.call(service, { ...parentRef, sessionId: "other" }, "child", "/root/map-auth")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      expect((await stat(child)).mtimeMs).toBe(before.mtimeMs);
      const listed = await listSessionFiles({ id: "w", cwd: directory, label: "w", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: "2026-01-01T00:00:00.000Z" });
      expect(listed.map((file) => file.id)).toEqual(["main"]);
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
      else process.env["PI_CODING_AGENT_SESSION_DIR"] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
