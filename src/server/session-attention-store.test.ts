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
