import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionAttentionState, SessionRef } from "../shared/protocol.js";

export interface SessionSortMeta {
  attentionState: SessionAttentionState;
  attentionAt?: string;
  lastUserMessageAt?: string;
  starred?: boolean;
  name?: string;
  preview?: string;
  listCopyMtime?: number;
}

export interface SessionListCopy {
  name: string | null;
  preview: string | null;
  listCopyMtime: number;
}

interface PersistedSessionMeta {
  attentionState?: Exclude<SessionAttentionState, "idle">;
  attentionAt?: string;
  lastUserMessageAt?: string;
  starred?: true;
  name?: string;
  preview?: string;
  listCopyMtime?: number;
}

interface PersistedAttentionFile {
  version: 2;
  sessions: Record<string, PersistedSessionMeta>;
}

/** Jarvis-owned UI state. Pi JSONL remains the source of conversation history. */
export class SessionAttentionStore {
  private readonly path: string;
  private data: PersistedAttentionFile | undefined;
  private operationChain = Promise.resolve();

  constructor(agentDir: string) {
    this.path = join(agentDir, "jarvis-session-attention.json");
  }

  async get(ref: SessionRef): Promise<SessionSortMeta> {
    return metaFromPersisted((await this.load()).sessions[key(ref)]);
  }

  async list(workspaceId: string): Promise<Map<string, SessionSortMeta>> {
    const sessions = (await this.load()).sessions;
    const prefix = `${workspaceId}:`;
    return new Map(Object.entries(sessions)
      .filter(([entryKey]) => entryKey.startsWith(prefix))
      .map(([entryKey, entry]) => [entryKey.slice(prefix.length), metaFromPersisted(entry)]));
  }

  async setAttention(ref: SessionRef, state: SessionAttentionState, at: string): Promise<void> {
    await this.update((data) => {
      const entryKey = key(ref);
      const current = data.sessions[entryKey] ?? {};
      // Running / waiting are reconstructed from the live session and must not survive a restart.
      if (state !== "completed_unread" && state !== "failed") {
        const next = compactPersistedMeta({
          ...listCopyFields(current),
          ...(current.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: current.lastUserMessageAt }),
          ...(current.starred === true ? { starred: true } : {}),
        });
        if (next === undefined) delete data.sessions[entryKey];
        else data.sessions[entryKey] = next;
        return;
      }
      data.sessions[entryKey] = { ...current, attentionState: state, attentionAt: at };
    });
  }

  async setLastUserMessageAt(ref: SessionRef, at: string): Promise<void> {
    await this.update((data) => {
      const entryKey = key(ref);
      data.sessions[entryKey] = { ...data.sessions[entryKey], lastUserMessageAt: at };
    });
  }

  async setStarred(ref: SessionRef, starred: boolean): Promise<void> {
    await this.update((data) => {
      const entryKey = key(ref);
      const current = data.sessions[entryKey] ?? {};
      if (starred) {
        data.sessions[entryKey] = { ...current, starred: true };
        return;
      }
      const next = compactPersistedMeta({
        ...listCopyFields(current),
        ...(current.attentionState === undefined ? {} : { attentionState: current.attentionState }),
        ...(current.attentionAt === undefined ? {} : { attentionAt: current.attentionAt }),
        ...(current.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: current.lastUserMessageAt }),
      });
      if (next === undefined) delete data.sessions[entryKey];
      else data.sessions[entryKey] = next;
    });
  }

  async setListCopies(entries: Array<{ ref: SessionRef; copy: SessionListCopy }>): Promise<void> {
    if (entries.length === 0) return;
    await this.update((data) => {
      for (const { ref, copy } of entries) {
        const entryKey = key(ref);
        const current = data.sessions[entryKey] ?? {};
        const next = compactPersistedMeta({
          ...(current.attentionState === undefined ? {} : { attentionState: current.attentionState }),
          ...(current.attentionAt === undefined ? {} : { attentionAt: current.attentionAt }),
          ...(current.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: current.lastUserMessageAt }),
          ...(current.starred === true ? { starred: true } : {}),
          ...listCopyFields({
            ...(copy.name === null || copy.name === "" ? {} : { name: copy.name }),
            ...(copy.preview === null || copy.preview === "" ? {} : { preview: copy.preview }),
            listCopyMtime: copy.listCopyMtime,
          }),
        });
        if (next === undefined) delete data.sessions[entryKey];
        else data.sessions[entryKey] = next;
      }
    });
  }

  async remove(ref: SessionRef): Promise<void> {
    await this.removeMany([ref]);
  }

  async removeMany(refs: SessionRef[]): Promise<void> {
    if (refs.length === 0) return;
    await this.update((data) => {
      for (const ref of refs) delete data.sessions[key(ref)];
    });
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
      const migrated = migratePersistedFile(parsed);
      if (migrated !== undefined) {
        this.data = migrated;
        return migrated;
      }
    } catch (error) {
      if (!isMissingFile(error)) console.warn("Could not read Jarvis session attention state", error);
    }
    this.data = { version: 2, sessions: {} };
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

function listCopyFields(entry: PersistedSessionMeta): PersistedSessionMeta {
  return {
    ...(typeof entry.name === "string" && entry.name !== "" ? { name: entry.name } : {}),
    ...(typeof entry.preview === "string" && entry.preview !== "" ? { preview: entry.preview } : {}),
    ...(typeof entry.listCopyMtime === "number" && Number.isFinite(entry.listCopyMtime) ? { listCopyMtime: entry.listCopyMtime } : {}),
  };
}

function metaFromPersisted(entry: PersistedSessionMeta | undefined): SessionSortMeta {
  if (entry === undefined) return { attentionState: "idle" };
  return {
    attentionState: entry.attentionState ?? "idle",
    ...(entry.attentionAt === undefined ? {} : { attentionAt: entry.attentionAt }),
    ...(entry.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: entry.lastUserMessageAt }),
    ...(entry.starred === true ? { starred: true } : {}),
    ...listCopyFields(entry),
  };
}

function compactPersistedMeta(entry: PersistedSessionMeta): PersistedSessionMeta | undefined {
  return Object.keys(entry).length === 0 ? undefined : entry;
}

function migratePersistedFile(value: unknown): PersistedAttentionFile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["sessions"] !== "object" || record["sessions"] === null || Array.isArray(record["sessions"])) return undefined;
  const sessions: Record<string, PersistedSessionMeta> = {};
  for (const [entryKey, entry] of Object.entries(record["sessions"] as Record<string, unknown>)) {
    const migrated = migratePersistedEntry(entry);
    if (migrated !== undefined) sessions[entryKey] = migrated;
  }
  return { version: 2, sessions };
}

function migratePersistedEntry(value: unknown): PersistedSessionMeta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const next: PersistedSessionMeta = {};
  const lastUserMessageAt = stringTime(item["lastUserMessageAt"]);
  if (lastUserMessageAt !== undefined) next.lastUserMessageAt = lastUserMessageAt;
  if (item["starred"] === true) next.starred = true;
  const state = item["attentionState"] ?? item["state"];
  if (state === "completed_unread" || state === "failed") {
    next.attentionState = state;
    next.attentionAt = stringTime(item["attentionAt"]) ?? stringTime(item["updatedAt"]);
  }
  const name = stringField(item["name"]);
  if (name !== undefined) next.name = name;
  const preview = stringField(item["preview"]);
  if (preview !== undefined) next.preview = preview;
  const listCopyMtime = numberField(item["listCopyMtime"]);
  if (listCopyMtime !== undefined) next.listCopyMtime = listCopyMtime;
  return Object.keys(next).length === 0 ? undefined : next;
}

function stringTime(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
