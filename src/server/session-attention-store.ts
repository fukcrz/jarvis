import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionAttentionState, SessionRef } from "../shared/protocol.js";

interface PersistedAttention {
  state: Exclude<SessionAttentionState, "idle">;
  updatedAt: string;
}

interface PersistedAttentionFile {
  version: 1;
  sessions: Record<string, PersistedAttention>;
}

/** Jarvis-owned UI state. Pi JSONL remains the source of conversation history. */
export class SessionAttentionStore {
  private readonly path: string;
  private data: PersistedAttentionFile | undefined;
  private operationChain = Promise.resolve();

  constructor(agentDir: string) {
    this.path = join(agentDir, "jarvis-session-attention.json");
  }

  async get(ref: SessionRef): Promise<SessionAttentionState> {
    return (await this.load()).sessions[key(ref)]?.state ?? "idle";
  }

  async list(workspaceId: string): Promise<Map<string, SessionAttentionState>> {
    const sessions = (await this.load()).sessions;
    const prefix = `${workspaceId}:`;
    return new Map(Object.entries(sessions)
      .filter(([entryKey]) => entryKey.startsWith(prefix))
      .map(([entryKey, entry]) => [entryKey.slice(prefix.length), entry.state]));
  }

  async set(ref: SessionRef, state: SessionAttentionState): Promise<void> {
    await this.update((data) => {
      const entryKey = key(ref);
      // Running and waiting-interaction are ephemeral runtime states. They are
      // reconstructed from the active session and must not survive a restart.
      if (state !== "completed_unread" && state !== "failed") delete data.sessions[entryKey];
      else data.sessions[entryKey] = { state, updatedAt: new Date().toISOString() };
    });
  }

  async remove(ref: SessionRef): Promise<void> {
    await this.update((data) => { delete data.sessions[key(ref)]; });
  }

  async flush(): Promise<void> {
    await this.operationChain;
  }

  private async update(mutator: (data: PersistedAttentionFile) => void): Promise<void> {
    const operation = this.operationChain.then(async () => {
      const data = await this.load();
      mutator(data);
      await this.persist(data);
    });
    this.operationChain = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async load(): Promise<PersistedAttentionFile> {
    if (this.data !== undefined) return this.data;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (isPersistedFile(parsed)) {
        this.data = parsed;
        return parsed;
      }
    } catch (error) {
      if (!isMissingFile(error)) console.warn("Could not read Jarvis session attention state", error);
    }
    this.data = { version: 1, sessions: {} };
    return this.data;
  }

  private async persist(data: PersistedAttentionFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data)}\n`, "utf8");
    await rename(temporary, this.path);
  }
}

function key(ref: SessionRef): string {
  return `${ref.workspaceId}:${ref.sessionId}`;
}

function isPersistedFile(value: unknown): value is PersistedAttentionFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1 || typeof record["sessions"] !== "object" || record["sessions"] === null || Array.isArray(record["sessions"])) return false;
  return Object.values(record["sessions"] as Record<string, unknown>).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return (item["state"] === "running" || item["state"] === "completed_unread" || item["state"] === "failed" || item["state"] === "waiting_interaction") && typeof item["updatedAt"] === "string";
  });
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
