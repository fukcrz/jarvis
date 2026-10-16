import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionAttentionStore } from "./session-attention-store.js";

const ref = { workspaceId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222" };

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-attention-test-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("SessionAttentionStore starring", () => {
  it("persists a star and keeps it when attention returns to idle", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setStarred(ref, true);
    await store.setAttention(ref, "running", "2026-01-02T00:00:00.000Z");
    await store.setAttention(ref, "idle", "2026-01-03T00:00:00.000Z");

    await expect(store.get(ref)).resolves.toEqual({ attentionState: "idle", starred: true });
    expect(JSON.parse(await readFile(join(directory, "jarvis-session-attention.json"), "utf8"))).toMatchObject({
      sessions: { [`${ref.workspaceId}:${ref.sessionId}`]: { starred: true } },
    });
  });

  it("removes an empty record when unstarring", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setStarred(ref, true);
    await store.setStarred(ref, false);

    await expect(store.get(ref)).resolves.toEqual({ attentionState: "idle" });
    expect(JSON.parse(await readFile(join(directory, "jarvis-session-attention.json"), "utf8"))).toEqual({
      version: 2,
      sessions: {},
    });
  });

  it("removes many session records in one write", async () => {
    const store = new SessionAttentionStore(directory);
    const other = { workspaceId: ref.workspaceId, sessionId: "33333333-3333-4333-8333-333333333333" };
    await store.setStarred(ref, true);
    await store.setStarred(other, true);
    await store.removeMany([ref, other]);
    expect(JSON.parse(await readFile(join(directory, "jarvis-session-attention.json"), "utf8"))).toEqual({
      version: 2,
      sessions: {},
    });
  });

  it("reads a starred flag from existing files", async () => {
    await writeFile(join(directory, "jarvis-session-attention.json"), `${JSON.stringify({
      version: 2,
      sessions: { [`${ref.workspaceId}:${ref.sessionId}`]: { starred: true, lastUserMessageAt: "2026-01-01T00:00:00.000Z" } },
    })}\n`, "utf8");
    const store = new SessionAttentionStore(directory);

    await expect(store.get(ref)).resolves.toEqual({
      attentionState: "idle",
      lastUserMessageAt: "2026-01-01T00:00:00.000Z",
      starred: true,
    });
  });
});

describe("SessionAttentionStore side chats", () => {
  it("maps a parent session to a hidden side chat id", async () => {
    const store = new SessionAttentionStore(directory);
    const sideId = "44444444-4444-4444-8444-444444444444";
    const source = { path: "C:\\sessions\\parent.jsonl", leafId: "entry-1" };
    await store.setSideChat(ref, sideId, source);
    await expect(store.getSideChatId(ref)).resolves.toBe(sideId);
    await expect(store.getSideChatSource({ workspaceId: ref.workspaceId, sessionId: sideId })).resolves.toEqual(source);
    await expect(store.isSideChat({ workspaceId: ref.workspaceId, sessionId: sideId })).resolves.toBe(true);
    await expect(store.sideChatIds(ref.workspaceId)).resolves.toEqual(new Set([sideId]));
    expect(JSON.parse(await readFile(join(directory, "jarvis-session-attention.json"), "utf8"))).toMatchObject({
      sideChats: { [`${ref.workspaceId}:${ref.sessionId}`]: { sessionId: sideId, source } },
    });
  });

  it("reads legacy side-chat id mappings", async () => {
    await writeFile(join(directory, "jarvis-session-attention.json"), `${JSON.stringify({
      version: 2,
      sessions: {},
      sideChats: { [`${ref.workspaceId}:${ref.sessionId}`]: "44444444-4444-4444-8444-444444444444" },
    })}\n`, "utf8");
    const store = new SessionAttentionStore(directory);
    await expect(store.getSideChatId(ref)).resolves.toBe("44444444-4444-4444-8444-444444444444");
    await expect(store.getSideChatSource({ workspaceId: ref.workspaceId, sessionId: "44444444-4444-4444-8444-444444444444" })).resolves.toBeUndefined();
  });

  it("clears the mapping when the parent is removed", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setSideChat(ref, "44444444-4444-4444-8444-444444444444", { path: "parent.jsonl" });
    await store.remove(ref);
    await expect(store.getSideChatId(ref)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(directory, "jarvis-session-attention.json"), "utf8"))).toEqual({
      version: 2,
      sessions: {},
    });
  });
});

describe("SessionAttentionStore list copy", () => {
  it("keeps the reply end time when attention returns to idle", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setLastReplyEndedAt(ref, "2026-01-05T00:00:00.000Z");
    await store.setLastUserMessageAt(ref, "2026-01-04T00:00:00.000Z");
    await store.setAttention(ref, "completed_unread", "2026-01-05T00:00:00.000Z");
    await store.setAttention(ref, "idle", "2026-01-06T00:00:00.000Z");
    await store.setStarred(ref, true);
    await store.setStarred(ref, false);

    await expect(store.get(ref)).resolves.toEqual({
      attentionState: "idle",
      lastUserMessageAt: "2026-01-04T00:00:00.000Z",
      lastReplyEndedAt: "2026-01-05T00:00:00.000Z",
    });
  });

  it("keeps sidebar title and preview when attention returns to idle", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setListCopies([{ ref, copy: { name: "继续导入", preview: "First question", listCopyMtime: 10 } }]);
    await store.setAttention(ref, "completed_unread", "2026-01-02T00:00:00.000Z");
    await store.setAttention(ref, "idle", "2026-01-03T00:00:00.000Z");

    await expect(store.get(ref)).resolves.toEqual({
      attentionState: "idle",
      name: "继续导入",
      preview: "First question",
      listCopyMtime: 10,
    });
  });

  it("clears a renamed-away title without dropping other meta", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setStarred(ref, true);
    await store.setListCopies([{ ref, copy: { name: "旧名", preview: "First question", listCopyMtime: 11 } }]);
    await store.setListCopies([{ ref, copy: { name: null, preview: "First question", listCopyMtime: 12 } }]);

    await expect(store.get(ref)).resolves.toEqual({
      attentionState: "idle",
      starred: true,
      preview: "First question",
      listCopyMtime: 12,
    });
  });
});

describe("SessionAttentionStore corruption recovery", () => {
  it("restores stars from the backup instead of silently wiping them", async () => {
    const { readdir } = await import("node:fs/promises");
    const store = new SessionAttentionStore(directory);
    await store.setStarred(ref, true);
    await writeFile(join(directory, "jarvis-session-attention.json"), "\0\0\0\0");

    const reopened = new SessionAttentionStore(directory);
    await expect(reopened.get(ref)).resolves.toMatchObject({ starred: true });
    expect((await readdir(directory)).some((name) => name.startsWith("jarvis-session-attention.json.corrupt-"))).toBe(true);
  });
});

describe("SessionAttentionStore interrupted runs", () => {
  it("marks a run that was still going when the process stopped as interrupted", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setStarred(ref, true);
    await store.setAttention(ref, "running", "2026-01-02T00:00:00.000Z");

    const restarted = new SessionAttentionStore(directory);
    await expect(restarted.get(ref)).resolves.toMatchObject({ attentionState: "failed", interruptedAt: "2026-01-02T00:00:00.000Z", starred: true });

    // 查看过（回到 idle）不清标记；下一轮开始才清。
    await restarted.setAttention(ref, "idle", "2026-01-03T00:00:00.000Z");
    await expect(restarted.get(ref)).resolves.toMatchObject({ attentionState: "idle", interruptedAt: "2026-01-02T00:00:00.000Z" });
    await restarted.setAttention(ref, "running", "2026-01-04T00:00:00.000Z");
    await expect(restarted.get(ref)).resolves.not.toHaveProperty("interruptedAt");
  });

  it("does not flag runs that finished normally", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setAttention(ref, "running", "2026-01-02T00:00:00.000Z");
    await store.setAttention(ref, "completed_unread", "2026-01-02T00:01:00.000Z");
    const restarted = new SessionAttentionStore(directory);
    const meta = await restarted.get(ref);
    expect(meta.attentionState).toBe("completed_unread");
    expect(meta.interruptedAt).toBeUndefined();
  });
});

describe("SessionAttentionStore pending queue", () => {
  it("keeps queued texts across a restart and hands them out once", async () => {
    const store = new SessionAttentionStore(directory);
    await store.setAttention(ref, "running", "2026-01-02T00:00:00.000Z");
    await store.setPendingQueue(ref, ["再跑一遍测试", "顺便更新文档"]);
    await store.setStarred(ref, true);

    const restarted = new SessionAttentionStore(directory);
    await expect(restarted.takePendingQueue(ref)).resolves.toEqual(["再跑一遍测试", "顺便更新文档"]);
    await expect(restarted.takePendingQueue(ref)).resolves.toEqual([]);
    await expect(restarted.get(ref)).resolves.toMatchObject({ starred: true, interruptedAt: "2026-01-02T00:00:00.000Z" });
  });
});
