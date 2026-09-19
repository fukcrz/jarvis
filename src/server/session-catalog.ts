import { sortSessionSummaries } from "../shared/session-sort.js";
import type { SessionFileReference, SessionRef, SessionSummary, Workspace } from "../shared/protocol.js";
import { AppError } from "./errors.js";
import type { ActiveSession } from "./session-active.js";
import type { SessionAttentionStore, SessionListCopy, SessionSortMeta } from "./session-attention-store.js";
import { listManagedSessions, listSessionFiles, readSessionFileHeader, readSessionListCopy, sessionModifiedAt } from "./session-files.js";
import { activeKey, attachSearchSnippet, firstUserMessage, isVisibleSessionId, sessionBranchSearchText } from "./session-helpers.js";
import type { WorkspaceStore } from "./workspace-store.js";

export interface SessionCatalogDeps {
  workspaces: WorkspaceStore;
  attention: SessionAttentionStore;
  active: Map<string, ActiveSession>;
}

export async function listWorkspaceSessions(deps: SessionCatalogDeps, workspaceId: string, query?: string): Promise<SessionSummary[]> {
  const needle = query?.trim().toLocaleLowerCase();
  if (needle !== undefined && needle !== "") return listBySearch(deps, workspaceId, needle);
  return listFromIndex(deps, workspaceId);
}

/** 侧栏列表：文件头 + 索引，不把每个 jsonl 通读成全文。 */
async function listFromIndex(deps: SessionCatalogDeps, workspaceId: string): Promise<SessionSummary[]> {
  const workspace = deps.workspaces.get(workspaceId);
  const sideIds = await deps.attention.sideChatIds(workspaceId);
  const files = (await listSessionFiles(workspace)).filter((file) => !sideIds.has(file.id));
  const sortMeta = await deps.attention.list(workspaceId);
  const seen = new Set(files.map((file) => file.id));
  const rows = await Promise.all(files.map(async (file) => {
    const ref = { workspaceId, sessionId: file.id };
    const active = deps.active.get(activeKey(ref));
    if (active !== undefined) return { summary: summaryFromActive(active) };
    const persisted = sortMeta.get(file.id);
    let name = persisted?.name;
    let preview = persisted?.preview;
    let copy: { ref: SessionRef; copy: SessionListCopy } | undefined;
    if (persisted?.listCopyMtime !== file.mtimeMs) {
      const scanned = await readSessionListCopy(file.path);
      name = scanned.name ?? undefined;
      preview = scanned.preview ?? undefined;
      copy = { ref, copy: { name: scanned.name, preview: scanned.preview, listCopyMtime: file.mtimeMs } };
    }
    const createdAt = file.timestamp !== undefined && Number.isFinite(Date.parse(file.timestamp))
      ? new Date(file.timestamp)
      : new Date(file.mtimeIso);
    return {
      summary: summaryFromList(deps.active, workspace, {
        id: file.id,
        ...(name === undefined ? {} : { name }),
        firstMessage: preview ?? "",
        created: createdAt,
        modified: new Date(file.mtimeIso),
      }, persisted),
      copy,
    };
  }));
  const summaries = rows.map((row) => row.summary);
  const copiesToPersist = rows.flatMap((row) => row.copy === undefined ? [] : [row.copy]);

  for (const active of deps.active.values()) {
    if (!isVisibleSessionId(active.ref.sessionId) || active.ref.workspaceId !== workspaceId || seen.has(active.ref.sessionId) || sideIds.has(active.ref.sessionId) || active.readOnly === true) continue;
    summaries.unshift(summaryFromActive(active));
  }

  if (copiesToPersist.length > 0) {
    void deps.attention.setListCopies(copiesToPersist).catch((error: unknown) => console.warn("Could not persist session list copy", error));
  }
  return sortSessionSummaries(summaries);
}

/** 全文搜索仍走 Pi list（主动搜才通读 jsonl）。 */
async function listBySearch(deps: SessionCatalogDeps, workspaceId: string, needle: string): Promise<SessionSummary[]> {
  const workspace = deps.workspaces.get(workspaceId);
  const sideIds = await deps.attention.sideChatIds(workspaceId);
  const listed = (await listManagedSessions(workspace.cwd)).filter((entry) => isVisibleSessionId(entry.id) && !sideIds.has(entry.id));
  const sortMeta = await deps.attention.list(workspaceId);
  const listedMatches = listed
    .map((entry) => ({
      summary: summaryFromList(deps.active, workspace, entry, sortMeta.get(entry.id)),
      searchText: `${entry.name ?? ""}\n${entry.firstMessage ?? ""}\n${entry.allMessagesText}`,
    }))
    .filter(({ searchText }) => searchText.toLocaleLowerCase().includes(needle));
  const summaries = listedMatches.map(({ summary, searchText }) => attachSearchSnippet(summary, searchText, needle));

  for (const active of deps.active.values()) {
    if (!isVisibleSessionId(active.ref.sessionId) || active.ref.workspaceId !== workspaceId || sideIds.has(active.ref.sessionId) || active.readOnly === true || summaries.some((summary) => summary.id === active.ref.sessionId)) continue;
    const summary = summaryFromActive(active);
    const searchText = sessionBranchSearchText(summary.name, summary.preview, active.session.sessionManager.getBranch());
    if (!searchText.toLocaleLowerCase().includes(needle)) continue;
    summaries.unshift(attachSearchSnippet(summary, searchText, needle));
  }

  return sortSessionSummaries(summaries);
}

export async function listFileReferences(deps: SessionCatalogDeps, workspaceId: string, query?: string): Promise<SessionFileReference[]> {
  const workspace = deps.workspaces.get(workspaceId);
  const sideIds = await deps.attention.sideChatIds(workspaceId);
  const listed = (await listManagedSessions(workspace.cwd)).filter((entry) => isVisibleSessionId(entry.id) && !sideIds.has(entry.id));
  const activeById = new Map(
    [...deps.active.values()]
      .filter((active) => active.ref.workspaceId === workspaceId && isVisibleSessionId(active.ref.sessionId) && !sideIds.has(active.ref.sessionId) && active.readOnly !== true)
      .map((active) => [active.ref.sessionId, active]),
  );
  const needle = query?.trim().toLocaleLowerCase() ?? "";
  return listed
    .map((entry) => ({
      id: entry.id,
      name: entry.name ?? null,
      preview: entry.firstMessage || null,
      path: entry.path,
      active: activeById.get(entry.id),
    }))
    .concat([...activeById.values()]
      .filter((active) => !listed.some((entry) => entry.id === active.ref.sessionId) && active.session.sessionFile !== undefined)
      .map((active) => ({
        id: active.ref.sessionId,
        name: active.session.sessionName ?? null,
        preview: firstUserMessage(active.session.sessionManager.getBranch()),
        path: active.session.sessionFile!,
        active,
      })))
    .filter((entry) => needle === "" || `${entry.name ?? ""}\n${entry.preview ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => (right.active?.updatedAt ?? "").localeCompare(left.active?.updatedAt ?? ""))
    .map(({ id, name, preview, path }) => ({ id, name, preview, path }));
}

export function summaryFromList(
  activeSessions: Map<string, ActiveSession>,
  workspace: Workspace,
  entry: { id: string; name?: string; firstMessage: string; created: Date; modified: Date },
  persisted?: SessionSortMeta,
): SessionSummary {
  const active = activeSessions.get(activeKey({ workspaceId: workspace.id, sessionId: entry.id }));
  const attentionState = active?.attentionState ?? persisted?.attentionState ?? "idle";
  const attentionAt = active?.attentionAt ?? persisted?.attentionAt;
  const lastUserMessageAt = active?.lastUserMessageAt ?? persisted?.lastUserMessageAt;
  const starred = active?.starred === true || persisted?.starred === true;
  return {
    id: entry.id,
    workspaceId: workspace.id,
    name: entry.name ?? null,
    preview: entry.firstMessage === "" || entry.firstMessage === "(no messages)" ? null : entry.firstMessage,
    createdAt: entry.created.toISOString(),
    updatedAt: entry.modified.toISOString(),
    runState: active?.state.runState ?? "idle",
    attentionState,
    ...(attentionState === "idle" || attentionAt === undefined ? {} : { attentionAt }),
    ...(lastUserMessageAt === undefined ? {} : { lastUserMessageAt }),
    ...(starred ? { starred: true } : {}),
  };
}

export async function summaryFromStored(deps: SessionCatalogDeps, workspace: Workspace, ref: SessionRef, path: string): Promise<SessionSummary> {
  const header = await readSessionFileHeader(path);
  if (header === undefined || header.id !== ref.sessionId) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
  const persisted = await deps.attention.get(ref);
  const updatedAt = await sessionModifiedAt(path, new Date().toISOString());
  const createdAt = header.timestamp !== undefined && Number.isFinite(Date.parse(header.timestamp))
    ? new Date(header.timestamp).toISOString()
    : updatedAt;
  const attentionState = persisted.attentionState;
  return {
    id: ref.sessionId,
    workspaceId: workspace.id,
    name: persisted.name ?? null,
    preview: persisted.preview ?? null,
    createdAt,
    updatedAt,
    runState: "idle",
    attentionState,
    ...(attentionState === "idle" || persisted.attentionAt === undefined ? {} : { attentionAt: persisted.attentionAt }),
    ...(persisted.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: persisted.lastUserMessageAt }),
    ...(persisted.starred === true ? { starred: true } : {}),
  };
}

export function summaryFromActive(active: ActiveSession, previewOverride?: string): SessionSummary {
  return {
    id: active.ref.sessionId,
    workspaceId: active.ref.workspaceId,
    name: active.session.sessionName ?? null,
    preview: previewOverride ?? firstUserMessage(active.session.sessionManager.getBranch()),
    createdAt: active.createdAt,
    updatedAt: active.updatedAt,
    runState: active.state.runState,
    attentionState: active.attentionState,
    ...(active.attentionState === "idle" || active.attentionAt === undefined ? {} : { attentionAt: active.attentionAt }),
    ...(active.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: active.lastUserMessageAt }),
    ...(active.starred === true ? { starred: true } : {}),
  };
}

