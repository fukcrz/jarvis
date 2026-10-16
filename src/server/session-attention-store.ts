import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionAttentionState, SessionRef } from "../shared/protocol.js";
import { readJsonRecovering, writeWithBackup } from "./fs.js";

export interface SessionSortMeta {
  attentionState: SessionAttentionState;
  attentionAt?: string;
  lastUserMessageAt?: string;
  lastReplyEndedAt?: string;
  starred?: boolean;
  name?: string;
  preview?: string;
  listCopyMtime?: number;
  /** 上次运行开始的时间：服务重启或崩溃时这轮没跑完。 */
  interruptedAt?: string;
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
  lastReplyEndedAt?: string;
  starred?: true;
  name?: string;
  preview?: string;
  listCopyMtime?: number;
  /** 正在运行（开始时间）。进程重启后读到它，说明这轮被中断了。 */
  runningSince?: string;
  /** 被中断的那一轮的开始时间；下一轮开始时清掉。 */
  interruptedAt?: string;
  /** 还没投递给模型的排队消息（只存文字）。 */
  pendingQueue?: string[];
}

export interface SideChatSource {
  path: string;
  leafId?: string;
}

interface PersistedSideChatLink {
  sessionId: string;
  source?: SideChatSource;
}

interface PersistedAttentionFile {
  version: 2;
  sessions: Record<string, PersistedSessionMeta>;
  /** parentKey (`workspaceId:sessionId`) → hidden side-chat session and source */
  sideChats?: Record<string, PersistedSideChatLink>;
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
      // Running / waiting are reconstructed from the live session; only a
      // `runningSince` marker survives so a restart can tell the turn was cut off.
      if (state !== "completed_unread" && state !== "failed") {
        const running = state === "running" || state === "waiting_interaction";
        const next = compactPersistedMeta({
          ...listCopyFields(current),
          ...persistedSortTimes(current),
          ...(current.starred === true ? { starred: true } : {}),
          ...(running ? { runningSince: current.runningSince ?? at } : {}),
          // 查看过（回到 idle）不清"被中断"标记，下一轮开始才清。
          ...(!running && current.interruptedAt !== undefined ? { interruptedAt: current.interruptedAt } : {}),
          ...(current.pendingQueue === undefined ? {} : { pendingQueue: current.pendingQueue }),
        });
        if (next === undefined) delete data.sessions[entryKey];
        else data.sessions[entryKey] = next;
        return;
      }
      const rest = { ...current };
      delete rest.runningSince;
      data.sessions[entryKey] = { ...rest, attentionState: state, attentionAt: at };
    });
  }

  async setPendingQueue(ref: SessionRef, texts: string[]): Promise<void> {
    const entryKey = key(ref);
    const current = (await this.load()).sessions[entryKey];
    if (texts.length === 0 && current?.pendingQueue === undefined) return;
    await this.update((data) => {
      const entry = { ...data.sessions[entryKey] };
      if (texts.length === 0) delete entry.pendingQueue;
      else entry.pendingQueue = texts;
      if (Object.keys(entry).length === 0) delete data.sessions[entryKey];
      else data.sessions[entryKey] = entry;
    });
  }

  /** 取出并清掉上次进程留下的排队消息。 */
  async takePendingQueue(ref: SessionRef): Promise<string[]> {
    const entryKey = key(ref);
    const texts = (await this.load()).sessions[entryKey]?.pendingQueue ?? [];
    if (texts.length > 0) await this.setPendingQueue(ref, []);
    return texts;
  }

  async setLastUserMessageAt(ref: SessionRef, at: string): Promise<void> {
    await this.update((data) => {
      const entryKey = key(ref);
      data.sessions[entryKey] = { ...data.sessions[entryKey], lastUserMessageAt: at };
    });
  }

  async setLastReplyEndedAt(ref: SessionRef, at: string): Promise<void> {
    await this.update((data) => {
      const entryKey = key(ref);
      data.sessions[entryKey] = { ...data.sessions[entryKey], lastReplyEndedAt: at };
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
        ...persistedSortTimes(current),
        ...runMarkers(current),
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
          ...persistedSortTimes(current),
          ...(current.starred === true ? { starred: true } : {}),
          ...runMarkers(current),
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
    const keys = new Set(refs.map((ref) => key(ref)));
    const sessionIds = new Set(refs.map((ref) => ref.sessionId));
    await this.update((data) => {
      for (const ref of refs) delete data.sessions[key(ref)];
      const sideChats = data.sideChats;
      if (sideChats === undefined) return;
      for (const [entryKey, link] of Object.entries(sideChats)) {
        if (keys.has(entryKey) || sessionIds.has(link.sessionId)) delete sideChats[entryKey];
      }
    });
  }

  async getSideChatId(parent: SessionRef): Promise<string | undefined> {
    return (await this.load()).sideChats?.[key(parent)]?.sessionId;
  }

  async getSideChatSource(ref: SessionRef): Promise<SideChatSource | undefined> {
    const prefix = `${ref.workspaceId}:`;
    const sideChats = (await this.load()).sideChats ?? {};
    return Object.entries(sideChats).find(([entryKey, link]) => entryKey.startsWith(prefix) && link.sessionId === ref.sessionId)?.[1].source;
  }

  async sideChatIds(workspaceId: string): Promise<Set<string>> {
    const prefix = `${workspaceId}:`;
    const sideChats = (await this.load()).sideChats ?? {};
    return new Set(Object.entries(sideChats).flatMap(([entryKey, link]) => entryKey.startsWith(prefix) ? [link.sessionId] : []));
  }

  async isSideChat(ref: SessionRef): Promise<boolean> {
    const ids = await this.sideChatIds(ref.workspaceId);
    return ids.has(ref.sessionId);
  }

  async setSideChat(parent: SessionRef, sideSessionId: string, source?: SideChatSource): Promise<void> {
    await this.update((data) => {
      const sideChats = { ...data.sideChats };
      sideChats[key(parent)] = { sessionId: sideSessionId, ...(source === undefined ? {} : { source }) };
      data.sideChats = sideChats;
    });
  }

  async clearSideChat(parent: SessionRef): Promise<void> {
    await this.update((data) => {
      if (data.sideChats === undefined) return;
      delete data.sideChats[key(parent)];
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
    // 读坏时坏文件改名留存并用 .bak 恢复，不再悄悄用空数据覆盖星标、未读和侧聊关系。
    const loaded = await readJsonRecovering(this.path, (parsed) => {
      const migrated = migratePersistedFile(parsed);
      if (migrated === undefined) throw new Error("Unsupported session attention format");
      return migrated;
    }).catch((error: unknown) => {
      console.warn("Could not read Jarvis session attention state", error);
      return { value: undefined };
    });
    if (loaded.value !== undefined) {
      markInterruptedRuns(loaded.value);
      this.data = loaded.value;
      return loaded.value;
    }
    this.data = { version: 2, sessions: {} };
    return this.data;
  }

  private async persist(data: PersistedAttentionFile): Promise<void> {
    if (data.sideChats !== undefined && Object.keys(data.sideChats).length === 0) delete data.sideChats;
    await mkdir(dirname(this.path), { recursive: true });
    await writeWithBackup(this.path, `${JSON.stringify(data)}\n`);
  }
}

/**
 * 进程启动后第一次读状态文件时调用：还带着 `runningSince` 的会话，是上次进程退出时正在跑的，
 * 标记为"被中断"（并当作失败提醒），等用户点"继续"或发新消息。
 */
function markInterruptedRuns(data: PersistedAttentionFile): void {
  for (const entry of Object.values(data.sessions)) {
    if (entry.runningSince === undefined) continue;
    entry.interruptedAt = entry.runningSince;
    delete entry.runningSince;
    entry.attentionState = "failed";
    entry.attentionAt = entry.interruptedAt;
  }
}

function key(ref: SessionRef): string {
  return `${ref.workspaceId}:${ref.sessionId}`;
}

function persistedSortTimes(entry: PersistedSessionMeta): Pick<PersistedSessionMeta, "lastUserMessageAt" | "lastReplyEndedAt"> {
  return {
    ...(entry.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: entry.lastUserMessageAt }),
    ...(entry.lastReplyEndedAt === undefined ? {} : { lastReplyEndedAt: entry.lastReplyEndedAt }),
  };
}

function runMarkers(entry: PersistedSessionMeta): Pick<PersistedSessionMeta, "runningSince" | "interruptedAt" | "pendingQueue"> {
  return {
    ...(entry.pendingQueue === undefined ? {} : { pendingQueue: entry.pendingQueue }),
    ...(entry.runningSince === undefined ? {} : { runningSince: entry.runningSince }),
    ...(entry.interruptedAt === undefined ? {} : { interruptedAt: entry.interruptedAt }),
  };
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
    ...persistedSortTimes(entry),
    ...(entry.starred === true ? { starred: true } : {}),
    ...listCopyFields(entry),
    ...(entry.interruptedAt === undefined ? {} : { interruptedAt: entry.interruptedAt }),
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
  const sideChats = parseSideChats(record["sideChats"]);
  return { version: 2, sessions, ...(sideChats === undefined ? {} : { sideChats }) };
}

function parseSideChats(value: unknown): Record<string, PersistedSideChatLink> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const next: Record<string, PersistedSideChatLink> = {};
  for (const [entryKey, rawLink] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawLink === "string" && rawLink !== "") {
      next[entryKey] = { sessionId: rawLink };
      continue;
    }
    if (typeof rawLink !== "object" || rawLink === null || Array.isArray(rawLink)) continue;
    const link = rawLink as Record<string, unknown>;
    if (typeof link["sessionId"] !== "string" || link["sessionId"] === "") continue;
    const rawSource = link["source"];
    const source = typeof rawSource === "object" && rawSource !== null && !Array.isArray(rawSource)
      ? rawSource as Record<string, unknown>
      : undefined;
    const path = source === undefined ? undefined : stringField(source["path"]);
    const leafId = source === undefined ? undefined : stringField(source["leafId"]);
    next[entryKey] = {
      sessionId: link["sessionId"],
      ...(path === undefined ? {} : { source: { path, ...(leafId === undefined ? {} : { leafId }) } }),
    };
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

function migratePersistedEntry(value: unknown): PersistedSessionMeta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const next: PersistedSessionMeta = {};
  const lastUserMessageAt = stringTime(item["lastUserMessageAt"]);
  if (lastUserMessageAt !== undefined) next.lastUserMessageAt = lastUserMessageAt;
  const lastReplyEndedAt = stringTime(item["lastReplyEndedAt"]);
  if (lastReplyEndedAt !== undefined) next.lastReplyEndedAt = lastReplyEndedAt;
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
  const runningSince = stringTime(item["runningSince"]);
  if (runningSince !== undefined) next.runningSince = runningSince;
  const interruptedAt = stringTime(item["interruptedAt"]);
  if (interruptedAt !== undefined) next.interruptedAt = interruptedAt;
  if (Array.isArray(item["pendingQueue"])) {
    const pending = item["pendingQueue"].filter((text): text is string => typeof text === "string" && text !== "");
    if (pending.length > 0) next.pendingQueue = pending;
  }
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

