import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type {
  BashAccepted,
  CompactAccepted,
  ComposerCommand,
  ContextUsage,
  ImageAttachment,
  ModelDescriptor,
  PromptAccepted,
  QueuedMessage,
  QueuedPromptAccepted,
  SessionFileReference,
  SessionAttentionState,
  SessionRef,
  SessionStreamSnapshot,
  SessionCleanupResult,
  SessionSummary,
  SessionThinkingSnapshot,
  ThinkingLevel,
  TimelinePage,
  ToolTimelineItem,
  TimelineItem,
  Workspace,
} from "../shared/protocol.js";
import { emptySessionQueue, isRecord, PROTOCOL_VERSION } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";
import { stringValue, toIso } from "./values.js";
import { EventHub } from "./event-hub.js";
import { projectModelSnapshot } from "./model-projection.js";
import { bashExecutionItem, decodeTimelineMediaItemId, projectHistory, toExternalTimelineItem, toExternalTimelineItems } from "./projection.js";
import { WorkspaceStore } from "./workspace-store.js";
import {
  ALLOWED_IMAGE_TYPES,
  FORK_SNAPSHOT_RETRIES,
  FORK_SNAPSHOT_RETRY_DELAY_MS,
  JARVIS_COMPACT_COMMAND,
  JARVIS_RELOAD_COMMAND,
  MAX_ATTACHMENT_DATA_LENGTH,
  MAX_BASH_OUTPUT_CHARS,
  MAX_PROMPT_LENGTH,
  PAGE_LIMIT,
  PI_ABORT_TIMEOUT_MS,
  SETTLEMENT_MAX_WAIT_MS,
  SETTLEMENT_RETRY_INTERVAL_MS,
  type ActiveRun,
  type ActiveSession,
  type RunAccepted,
} from "./session-active.js";
import { SessionAttentionStore, type SessionSortMeta } from "./session-attention-store.js";
import {
  createManagedSession,
  findSessionFile,
  listSessionFiles,
  openManagedSession,
  openManagedSessionAt,
  removeSessionJsonl,
  sessionDirectoryFor,
  sessionFileMtimeMs,
} from "./session-files.js";
import {
  activeKey,
  clamp,
  decodeImageData,
  expandToUserBoundary,
  findUserMessageEntry,
  findVisibleMessageEntryId,
  isCompactionCancellation,
  isOperationCancellation,
  isVisibleSessionId,
  mergeQueuedMessages,
  queuedMessage,
  runtimeFailureCode,
  sameThinkingLevels,
  sessionForkEntryId,
  sleep,
} from "./session-helpers.js";
import { listFileReferences, listWorkspaceSessions, summaryFromActive, summaryFromList, summaryFromStored } from "./session-catalog.js";
import { bindOwnerSessionId, createActiveSession } from "./session-open.js";
import { SessionPiEvents } from "./session-pi-events.js";

export class SessionService {
  private readonly active = new Map<string, ActiveSession>();
  private readonly ownerBoundSessions = new WeakSet<AgentSession>();
  private readonly pendingOpens = new Map<string, Promise<ActiveSession>>();
  private readonly deleting = new Set<string>();
  /** Serialize operations which replace or tear down an in-memory session. */
  private readonly sessionTransitions = new Map<string, Promise<void>>();
  private readonly sideChatEnsures = new Map<string, Promise<SessionSummary>>();
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;
  private readonly attention = new SessionAttentionStore(getAgentDir());
  private readonly piEvents: SessionPiEvents;

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly events: EventHub,
  ) {
    this.piEvents = new SessionPiEvents({
      events: this.events,
      clearSettlementTimer: (active) => this.clearSettlementTimer(active),
      setAttention: (active, state, at) => this.setAttention(active, state, at),
      resetLiveStream: (active) => this.resetLiveStream(active),
      publishSummary: (active, supplied) => this.publishSummary(active, supplied),
      persistListCopy: (active, summary) => this.persistListCopy(active, summary),
      summaryFromActive: (active, preview) => this.summaryFromActive(active, preview),
      thinkingSnapshot: (active) => this.thinkingSnapshot(active),
      publishContextUsage: (active, runId) => this.publishContextUsage(active, runId),
      publishTool: (active, tool, runId) => this.publishTool(active, tool, runId),
      cancelCompaction: (active) => this.cancelCompaction(active),
      syncQueue: (active) => this.syncQueue(active),
      deferAgentSettlement: (active) => this.deferAgentSettlement(active),
    });
  }

  async list(workspaceId: string, query?: string): Promise<SessionSummary[]> {
    return listWorkspaceSessions(this.catalogDeps(), workspaceId, query);
  }

  async markViewed(ref: SessionRef): Promise<SessionSummary> {
    const key = activeKey(ref);
    const transition = this.sessionTransitions.get(key);
    if (transition !== undefined) await transition;
    if (this.deleting.has(key)) throw new AppError("SESSION_BUSY", "This session is being deleted", 409);

    const pending = this.pendingOpens.get(key);
    const active = this.active.get(key) ?? (pending === undefined ? undefined : await pending);
    if (active !== undefined) {
      if (active.state.runState === "idle" && !active.extensionUi.hasPendingDialogs) {
        this.setAttention(active, "idle");
        this.publishSummary(active);
      }
      return this.summaryFromActive(active);
    }

    if (!isVisibleSessionId(ref.sessionId)) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    const workspace = this.workspaces.get(ref.workspaceId);
    const path = await findSessionFile(workspace, ref.sessionId);
    if (path === undefined) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    await this.attention.setAttention(ref, "idle", new Date().toISOString());
    return this.summaryFromStored(workspace, ref, path);
  }

  async fileReferences(workspaceId: string, query?: string): Promise<SessionFileReference[]> {
    return listFileReferences(this.catalogDeps(), workspaceId, query);
  }

  /** Shared Pi runtime used by the global settings surface. */
  async globalModelRuntime(): Promise<ModelRuntime> {
    return this.getModelRuntime(getAgentDir());
  }

  /** Rebuild global provider configuration and publish fresh model pickers. */
  async refreshModelConfiguration(): Promise<void> {
    const runtime = await this.getModelRuntime(getAgentDir());
    const result = await runtime.refresh({ allowNetwork: false });
    const firstError = result.errors.values().next().value as Error | undefined;
    if (firstError !== undefined) throw firstError;
    for (const active of this.active.values()) {
      const settingsManager = SettingsManager.create(active.cwd, getAgentDir());
      const enabledModels = settingsManager.getEnabledModels();
      const { scopedModels } = enabledModels !== undefined && enabledModels.length > 0
        ? await resolveModelScopeWithDiagnostics(enabledModels, runtime)
        : { scopedModels: [] };
      active.session.setScopedModels(scopedModels);
      this.events.publishSession(active.ref, { type: "model.changed", payload: { model: this.modelSnapshot(active) } });
    }
  }

  async create(workspaceId: string): Promise<SessionSummary> {
    const workspace = this.workspaces.get(workspaceId);
    const manager = createManagedSession(workspace.cwd);
    const active = await this.createActive({ workspaceId, sessionId: "" }, workspace, manager);
    const summary = this.summaryFromActive(active);
    this.events.publishWorkspace(workspaceId, { version: 1, type: "session.created", workspaceId, session: summary });
    return summary;
  }

  async fork(ref: SessionRef, messageId?: string): Promise<SessionSummary> {
    const active = await this.getActive(ref);
    const branch = active.session.sessionManager.getBranch();
    const running = active.state.runState !== "idle" || active.session.isStreaming;
    const entryId = messageId === undefined ? sessionForkEntryId(branch, running) : findVisibleMessageEntryId(branch, messageId);
    if (entryId === undefined) {
      throw new AppError("MESSAGE_NOT_FOUND", messageId === undefined ? "This session has no message to fork from" : "Message not found in this session", 404);
    }
    const sourcePath = active.session.sessionFile;
    if (sourcePath === undefined) throw new AppError("SESSION_NOT_READY", "Wait for this message to be saved before forking", 409);

    const sessionDir = sessionDirectoryFor(active.cwd, getAgentDir());
    // Forking a running session is safe: the branch derives from a snapshot of
    // the append-only history and never mutates the live session. The only real
    // hazard is the fork point entry not being on disk yet (prompt persistence
    // windows / delayed first flush), so retry briefly until the snapshot
    // provably contains the entry instead of rejecting the action wholesale.
    const manager = await this.openSnapshotWithEntry(sessionDir, sourcePath, entryId);
    // createBranchedSession mutates its manager, so never call it on the
    // currently active source manager.
    manager.createBranchedSession(entryId);
    const workspace = this.workspaces.get(ref.workspaceId);
    const forked = await this.createActive({ workspaceId: ref.workspaceId, sessionId: "" }, workspace, manager);
    const summary = this.summaryFromActive(forked);
    this.events.publishWorkspace(ref.workspaceId, { version: 1, type: "session.created", workspaceId: ref.workspaceId, session: summary });
    return summary;
  }

  async peekSideChat(parent: SessionRef): Promise<SessionSummary | null> {
    if (!isVisibleSessionId(parent.sessionId)) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    this.workspaces.get(parent.workspaceId);
    if (await this.attention.isSideChat(parent)) throw new AppError("SIDE_CHAT_INVALID", "Cannot open a side chat from a side chat", 400);
    const sideId = await this.attention.getSideChatId(parent);
    if (sideId === undefined) return null;
    const ref = { workspaceId: parent.workspaceId, sessionId: sideId };
    const active = this.peekActive(ref);
    if (active !== undefined) return this.summaryFromActive(active);
    const workspace = this.workspaces.get(parent.workspaceId);
    const path = await findSessionFile(workspace, sideId);
    if (path === undefined) {
      await this.attention.clearSideChat(parent);
      return null;
    }
    return this.summaryFromStored(workspace, ref, path);
  }

  async ensureSideChat(parent: SessionRef): Promise<SessionSummary> {
    const key = activeKey(parent);
    const pending = this.sideChatEnsures.get(key);
    if (pending !== undefined) return pending;
    const promise = this.createSideChat(parent).finally(() => {
      if (this.sideChatEnsures.get(key) === promise) this.sideChatEnsures.delete(key);
    });
    this.sideChatEnsures.set(key, promise);
    return promise;
  }

  async resetSideChat(parent: SessionRef): Promise<SessionSummary> {
    if (await this.attention.isSideChat(parent)) throw new AppError("SIDE_CHAT_INVALID", "Cannot open a side chat from a side chat", 400);
    const sideId = await this.attention.getSideChatId(parent);
    if (sideId !== undefined) {
      await this.deleteSession({ workspaceId: parent.workspaceId, sessionId: sideId }, undefined, { force: true, skipCascade: true });
      await this.attention.clearSideChat(parent);
    }
    return this.ensureSideChat(parent);
  }

  private async createSideChat(parent: SessionRef): Promise<SessionSummary> {
    if (!isVisibleSessionId(parent.sessionId)) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    if (await this.attention.isSideChat(parent)) throw new AppError("SIDE_CHAT_INVALID", "Cannot open a side chat from a side chat", 400);
    const existing = await this.peekSideChat(parent);
    if (existing !== null) {
      return this.summaryFromActive(await this.getActive({ workspaceId: parent.workspaceId, sessionId: existing.id }));
    }
    const parentActive = await this.getActive(parent);
    const branch = parentActive.session.sessionManager.getBranch();
    const running = parentActive.state.runState !== "idle" || parentActive.session.isStreaming;
    const entryId = sessionForkEntryId(branch, running);
    const workspace = this.workspaces.get(parent.workspaceId);
    let side: ActiveSession;
    if (entryId === undefined) {
      const manager = createManagedSession(workspace.cwd);
      side = await this.createActive({ workspaceId: parent.workspaceId, sessionId: "" }, workspace, manager, { readOnly: true });
    } else {
      const sourcePath = parentActive.session.sessionFile;
      if (sourcePath === undefined) throw new AppError("SESSION_NOT_READY", "Wait for this message to be saved before opening a side chat", 409);
      const sessionDir = sessionDirectoryFor(parentActive.cwd, getAgentDir());
      const manager = await this.openSnapshotWithEntry(sessionDir, sourcePath, entryId);
      manager.createBranchedSession(entryId);
      side = await this.createActive({ workspaceId: parent.workspaceId, sessionId: "" }, workspace, manager, { readOnly: true });
    }
    await this.attention.setSideChat(parent, side.ref.sessionId);
    return this.summaryFromActive(side);
  }

  async editAndResend(ref: SessionRef, messageId: string, text: string, clientRequestId: string, images?: ImageAttachment[]): Promise<PromptAccepted> {
    return this.withSessionTransition(ref, async () => {
      const active = await this.getActive(ref, { waitForTransition: false });
      this.assertSessionIdle(active, "Editing");
      const entry = findUserMessageEntry(active.session.sessionManager.getBranch(), messageId);
      if (entry === undefined) throw new AppError("MESSAGE_NOT_FOUND", "User message not found in this session", 404);

      const parentId = stringValue(entry["parentId"]) || undefined;
      if (parentId === undefined) active.session.sessionManager.resetLeaf();
      else active.session.sessionManager.branch(parentId);
      active.extensionUi.reset();
      this.events.publishSession(active.ref, {
        type: "session.rewritten",
        payload: { items: toExternalTimelineItems(this.timelineItems(active), active.ref), status: { sessionId: active.ref.sessionId, runState: "idle" } },
      });
      await this.reopenAtCurrentBranch(active);
      return this.prompt(ref, text, clientRequestId, images, { skipTransitionWait: true }) as Promise<PromptAccepted>;
    });
  }

  async rename(ref: SessionRef, name: string): Promise<SessionSummary> {
    const value = name.trim();
    if (value === "") throw new AppError("SESSION_NAME_INVALID", "Session name is required");
    if (value.length > 120) throw new AppError("SESSION_NAME_INVALID", "Session name must be at most 120 characters");
    const active = await this.getActive(ref);
    active.session.setSessionName(value);
    const summary = this.summaryFromActive(active);
    this.publishSummary(active, summary);
    this.persistListCopy(active, summary);
    return summary;
  }

  async setStarred(ref: SessionRef, starred: boolean): Promise<SessionSummary> {
    const active = await this.getActive(ref);
    if ((active.starred === true) === starred) return this.summaryFromActive(active);
    await this.attention.setStarred(active.ref, starred);
    if (starred) active.starred = true;
    else delete active.starred;
    const summary = this.summaryFromActive(active);
    this.publishSummary(active, summary);
    return summary;
  }

  async patch(ref: SessionRef, input: { name?: string; starred?: boolean }): Promise<SessionSummary> {
    if (input.name !== undefined) await this.rename(ref, input.name);
    if (input.starred !== undefined) return this.setStarred(ref, input.starred);
    return this.summaryFromActive(await this.getActive(ref));
  }

  async remove(ref: SessionRef): Promise<void> {
    await this.deleteSession(ref);
    await this.attention.remove(ref);
  }

  async cleanup(workspaceId: string, keepSessionId?: string): Promise<SessionCleanupResult> {
    const workspace = this.workspaces.get(workspaceId);
    const files = await listSessionFiles(workspace);
    const pathById = new Map(files.map((file) => [file.id, file.path]));
    const sortMeta = await this.attention.list(workspaceId);
    const sideIds = await this.attention.sideChatIds(workspaceId);
    const candidates = new Set(pathById.keys());
    for (const active of this.active.values()) {
      if (active.ref.workspaceId === workspaceId && isVisibleSessionId(active.ref.sessionId)) candidates.add(active.ref.sessionId);
    }
    for (const sideId of sideIds) candidates.delete(sideId);

    const removed: string[] = [];
    const skipped: SessionCleanupResult["skipped"] = [];
    const removedRefs: SessionRef[] = [];
    for (const sessionId of candidates) {
      if (sessionId === keepSessionId) continue;
      const ref = { workspaceId, sessionId };
      const active = this.active.get(activeKey(ref));
      if (active?.starred === true || sortMeta.get(sessionId)?.starred === true) continue;
      if (active !== undefined && this.isBusy(active)) {
        skipped.push({ id: sessionId, reason: "busy" });
        continue;
      }
      try {
        await this.deleteSession(ref, pathById.get(sessionId) ?? active?.session.sessionFile);
        removed.push(sessionId);
        removedRefs.push(ref);
      } catch (error) {
        if (error instanceof AppError && error.code === "SESSION_BUSY") {
          skipped.push({ id: sessionId, reason: "busy" });
          continue;
        }
        if (error instanceof AppError && error.code === "SESSION_NOT_FOUND") {
          removed.push(sessionId);
          removedRefs.push(ref);
          continue;
        }
        skipped.push({ id: sessionId, reason: "error" });
      }
    }
    await this.attention.removeMany(removedRefs);
    return { removed, skipped };
  }

  private async deleteSession(ref: SessionRef, knownPath?: string, options?: { force?: boolean; skipCascade?: boolean }): Promise<void> {
    if (!isVisibleSessionId(ref.sessionId)) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    await this.attention.flush();
    const sideId = options?.skipCascade === true ? undefined : await this.attention.getSideChatId(ref);
    return this.withSessionTransition(ref, async () => {
      const key = activeKey(ref);
      if (this.deleting.has(key)) throw new AppError("SESSION_BUSY", "This session is already being deleted", 409);
      this.deleting.add(key);

      try {
        const workspace = this.workspaces.get(ref.workspaceId);
        const pending = this.pendingOpens.get(key);
        if (pending !== undefined) await pending.catch(() => undefined);

        const active = this.active.get(key);
        if (active !== undefined && this.isBusy(active) && options?.force !== true) {
          throw new AppError("SESSION_BUSY", "Stop the current run before deleting this session", 409);
        }

        const path = knownPath ?? active?.session.sessionFile ?? await findSessionFile(workspace, ref.sessionId);
        if (active !== undefined) await this.disposeActive(active, "quit");

        try {
          if (path !== undefined) await rm(path, { force: true });
          await removeSessionJsonl(workspace, ref.sessionId);
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError("SESSION_DELETE_FAILED", "Unable to delete session history", 500);
        }

        if (path === undefined && active === undefined) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);

        this.events.publishWorkspace(ref.workspaceId, { version: 1, type: "session.deleted", workspaceId: ref.workspaceId, sessionId: ref.sessionId });
      } finally {
        this.deleting.delete(key);
      }
    }).then(async () => {
      if (sideId === undefined) return;
      try {
        await this.deleteSession({ workspaceId: ref.workspaceId, sessionId: sideId }, undefined, { force: true, skipCascade: true });
      } catch (error) {
        if (!(error instanceof AppError && error.code === "SESSION_NOT_FOUND")) throw error;
      }
    });
  }

  async timeline(ref: SessionRef, before?: number, limit = PAGE_LIMIT): Promise<TimelinePage> {
    const active = await this.getActive(ref, { waitForExtensions: false });
    const items = this.timelineItems(active);
    const end = clamp(before ?? items.length, 0, items.length);
    const requestedStart = Math.max(0, end - clamp(limit, 1, 500));
    const start = expandToUserBoundary(items, requestedStart);
    return { items: toExternalTimelineItems(items.slice(start, end), active.ref), start, total: items.length, hasMore: start > 0 };
  }

  /** Serve one tool-result image from an already-open session. Does not start AgentSession. */
  toolImage(ref: SessionRef, encodedItemId: string, index: number): { mimeType: string; bytes: Buffer } {
    if (!Number.isInteger(index) || index < 0) throw new AppError("MEDIA_NOT_FOUND", "Image not found", 404);
    const itemId = decodeTimelineMediaItemId(encodedItemId);
    if (itemId === "") throw new AppError("MEDIA_NOT_FOUND", "Image not found", 404);
    const active = this.peekActive(ref);
    if (active === undefined) throw new AppError("MEDIA_NOT_FOUND", "Image not found", 404);
    const live = active.activeTools.get(itemId)?.images?.[index];
    if (live?.data !== undefined && live.data !== "") return decodeImageData(live.mimeType, live.data);
    const history = this.timelineItems(active);
    const item = history.find((entry): entry is ToolTimelineItem => entry.kind === "tool" && entry.id === itemId);
    const image = item?.images?.[index];
    if (image?.data === undefined || image.data === "") throw new AppError("MEDIA_NOT_FOUND", "Image not found", 404);
    return decodeImageData(image.mimeType, image.data);
  }

  async commands(ref: SessionRef): Promise<ComposerCommand[]> {
    const active = await this.getActive(ref);
    return this.composerCommands(active);
  }

  private assertSessionIdle(active: ActiveSession, action: string): void {
    if (active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming) {
      throw new AppError("SESSION_BUSY", `${action} requires an idle session`, 409);
    }
  }

  /**
   * Open a persisted session snapshot that provably contains `entryId`,
   * retrying briefly while the running writer catches up with disk.
   */
  private async openSnapshotWithEntry(sessionDir: string | undefined, sourcePath: string, entryId: string): Promise<SessionManager> {
    for (let attempt = 0; attempt < FORK_SNAPSHOT_RETRIES; attempt++) {
      try {
        const manager = openManagedSessionAt(sourcePath, sessionDir);
        if (manager.getEntry(entryId) !== undefined) return manager;
      } catch {
        // Snapshot may be mid-rewrite (e.g. first assistant flush); retry.
      }
      await sleep(FORK_SNAPSHOT_RETRY_DELAY_MS);
    }
    throw new AppError("SESSION_NOT_READY", "Wait for this message to be saved before forking", 409);
  }

  /** Recreate Pi's in-memory agent context after moving a session leaf. */
  private async reopenAtCurrentBranch(active: ActiveSession): Promise<void> {
    const manager = active.session.sessionManager;
    const targetSessionFile = active.session.sessionFile;
    await this.disposeActive(active, "resume", targetSessionFile);
    await this.createActive(active.ref, this.workspaces.get(active.ref.workspaceId), manager, active.readOnly === true ? { readOnly: true } : undefined);
  }

  /**
   * Serialize a session replacement/teardown without blocking unrelated sessions.
   * The promise stored in the map never rejects; callers receive the operation's
   * own error while the next operation can always proceed.
   */
  private async withSessionTransition<T>(ref: SessionRef, operation: () => Promise<T>): Promise<T> {
    const key = activeKey(ref);
    const previous = this.sessionTransitions.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.sessionTransitions.set(key, current);
    if (previous !== undefined) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionTransitions.get(key) === current) this.sessionTransitions.delete(key);
    }
  }

  /**
   * Follow Pi's replacement teardown order: abort work, let extensions clean up
   * in session_shutdown, then invalidate the old extension context via dispose().
   */
  private async disposeActive(active: ActiveSession, reason: "quit" | "resume" | "fork", targetSessionFile?: string): Promise<void> {
    this.clearSettlementTimer(active);
    if (this.isBusy(active)) {
      active.session.abortCompaction();
      active.session.abortRetry();
      active.session.abortBranchSummary();
      active.session.abortBash();
      await this.abortPiWithTimeout(active.session).catch(() => false);
    }
    // A startup extension dialog can keep bindExtensions() pending. Close the
    // browser bridge first so session_start can unwind before session_shutdown;
    // otherwise a late session_start could reactivate the stale runtime.
    active.extensionUi.closeAll();
    await active.extensionReady.catch(() => undefined);
    try {
      if (active.session.extensionRunner.hasHandlers("session_shutdown")) {
        await active.session.extensionRunner.emit({ type: "session_shutdown", reason, ...(targetSessionFile === undefined ? {} : { targetSessionFile }) });
      }
    } catch (error) {
      console.warn("Pi extension shutdown failed", error);
    }
    active.unsubscribe();
    active.session.dispose();
    const key = activeKey(active.ref);
    if (this.active.get(key) === active) this.active.delete(key);
  }

  private composerCommands(active: ActiveSession): ComposerCommand[] {
    const commands: ComposerCommand[] = [
      ...active.session.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        ...(command.description === undefined ? {} : { description: command.description }),
        source: "extension" as const,
      })),
      ...active.session.promptTemplates.map((template) => ({
        name: template.name,
        ...(template.description === undefined ? {} : { description: template.description }),
        source: "prompt" as const,
      })),
      ...active.session.resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        source: "skill" as const,
      })),
    ];
    const withCompact = commands.some((command) => command.name === JARVIS_COMPACT_COMMAND.name)
      ? commands
      : [JARVIS_COMPACT_COMMAND, ...commands];
    return withCompact.some((command) => command.name === JARVIS_RELOAD_COMMAND.name)
      ? withCompact
      : [JARVIS_RELOAD_COMMAND, ...withCompact];
  }

  async runtime(ref: SessionRef): Promise<SessionStreamSnapshot> {
    const active = await this.getActive(ref, { waitForExtensions: false });
    const contextUsage = this.contextUsageSnapshot(active);
    return {
      // Read all fields without an await so this projection and its seq form
      // one join-time snapshot for the client-side watermark algorithm.
      seq: this.events.currentSeq(active.ref),
      status: active.state,
      model: this.modelSnapshot(active),
      thinking: this.thinkingSnapshot(active),
      liveMessages: [...active.liveMessages.values()],
      ...(active.liveErrors.size === 0 ? {} : { liveErrors: [...active.liveErrors.values()] }),
      ...(active.partial === undefined ? {} : { partial: active.partial }),
      ...(active.partialThinking === undefined ? {} : { partialThinking: active.partialThinking }),
      activeTools: toExternalTimelineItems([...active.activeTools.values()], active.ref) as ToolTimelineItem[],
      ...(active.activeBash === undefined ? {} : { activeBash: active.activeBash }),
      ...(contextUsage === undefined ? {} : { contextUsage }),
      queue: active.queue,
      extensionUi: active.extensionUi.snapshot(),
    };
  }

  async setModel(ref: SessionRef, provider: string, modelId: string): Promise<ModelDescriptor> {
    const active = await this.getActive(ref);
    // Pi itself allows model switches while streaming (the official TUI does
    // this freely); the switch applies to the next LLM call of the current run.
    if (active.modelSwitching) {
      throw new AppError("SESSION_BUSY", "A model switch is already in progress", 409);
    }

    active.modelSwitching = true;
    try {
      const available = await this.availableModels(active.modelRuntime);
      const model = available.find((candidate) => candidate.provider === provider && candidate.id === modelId);
      if (model === undefined) throw new AppError("MODEL_NOT_AVAILABLE", "This model is not available for the current Pi profile", 404);

      const snapshot = projectModelSnapshot(active.session.model, available, this.inScopeKeys(active));
      const previousThinking = this.thinkingSnapshot(active);
      if (active.session.model?.provider === provider && active.session.model?.id === modelId) {
        if (snapshot.current === undefined) throw new AppError("MODEL_NOT_AVAILABLE", "Pi did not select the requested model", 409);
        return snapshot.current;
      }

      await active.session.setModel(model);
      active.updatedAt = new Date().toISOString();
      const updated = projectModelSnapshot(active.session.model, available, this.inScopeKeys(active));
      const updatedThinking = this.thinkingSnapshot(active);
      if (updated.current === undefined) throw new AppError("MODEL_NOT_AVAILABLE", "Pi did not select the requested model", 409);
      this.events.publishSession(active.ref, { type: "model.changed", payload: { model: updated } });
      // Pi emits thinking_level_changed when it clamps the current value. A
      // capability-only change needs an explicit browser update as well.
      if (previousThinking.current === updatedThinking.current && !sameThinkingLevels(previousThinking.available, updatedThinking.available)) {
        this.events.publishSession(active.ref, { type: "thinking.changed", payload: { thinking: updatedThinking } });
      }
      this.publishSummary(active);
      return updated.current;
    } finally {
      active.modelSwitching = false;
    }
  }

  async setThinkingLevel(ref: SessionRef, level: ThinkingLevel): Promise<SessionThinkingSnapshot> {
    const active = await this.getActive(ref);
    // Pi applies the new level to the next LLM call, so switching mid-run is safe.
    if (active.modelSwitching) {
      throw new AppError("SESSION_BUSY", "A model switch is already in progress", 409);
    }

    const previous = active.session.thinkingLevel;
    active.session.setThinkingLevel(level);
    if (active.session.thinkingLevel !== previous) {
      active.updatedAt = new Date().toISOString();
      this.publishSummary(active);
    }
    return this.thinkingSnapshot(active);
  }

  async prompt(ref: SessionRef, text: string, clientRequestId: string, images?: ImageAttachment[], options?: { behavior?: "steer" | "followUp"; skipTransitionWait?: boolean }): Promise<PromptAccepted | QueuedPromptAccepted> {
    const prompt = text.trim();
    if (prompt === "" && (images === undefined || images.length === 0)) throw new AppError("PROMPT_EMPTY", "Prompt cannot be empty");
    if (prompt.length > MAX_PROMPT_LENGTH) throw new AppError("PROMPT_TOO_LARGE", `Prompt must be at most ${String(MAX_PROMPT_LENGTH)} characters`);
    const attachments = this.validateAttachments(images);
    const behavior = options?.behavior;
    const active = await this.getActive(ref, { waitForTransition: options?.skipTransitionWait !== true });
    const requestKey = `prompt:${clientRequestId}`;
    const previous = active.requestRuns.get(requestKey);
    if (previous !== undefined) return previous as PromptAccepted | QueuedPromptAccepted;
    const compact = attachments.length === 0 ? this.jarvisCompactCommand(active, prompt) : undefined;
    if (compact !== undefined) {
      const accepted = this.startCompaction(active, compact.customInstructions);
      this.rememberRequest(active, requestKey, accepted);
      return accepted;
    }
    const reload = attachments.length === 0 && this.jarvisReloadCommand(active, prompt);
    if (reload) {
      const accepted = this.startReload(active);
      this.rememberRequest(active, requestKey, accepted);
      return accepted;
    }
    // 会话忙（流式/压缩/切模型）：不拒绝发送，改为排队。缺省排队为
    // follow-up（agent 全部完成后投递），与用户默认“后续消息”预期一致；
    // 需要插队时由客户端显式传 behavior="steer"。
    if (this.isBusy(active)) {
      const kind = behavior ?? "followUp";
      await this.enqueuePrompt(active, kind, prompt, attachments);
      const accepted: QueuedPromptAccepted = { accepted: true, queued: true, behavior: kind };
      this.rememberRequest(active, requestKey, accepted);
      return accepted;
    }

    const run: ActiveRun = { id: randomUUID(), startedAt: new Date().toISOString(), kind: "llm" };
    active.state = { sessionId: ref.sessionId, runState: "running", activeRun: run };
    this.setAttention(active, "running", run.startedAt);
    this.markUserMessage(active, run.startedAt);
    active.updatedAt = run.startedAt;
    this.resetLiveStream(active);
    const accepted: PromptAccepted = { accepted: true, runId: run.id };
    this.rememberRequest(active, requestKey, accepted);

    this.events.publishSession(active.ref, { type: "run.started", runId: run.id, payload: { status: active.state } });
    this.publishSummary(active);
    void this.executePrompt(active, prompt, run.id, attachments);
    return accepted;
  }

  private isBusy(active: ActiveSession): boolean {
    return active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming;
  }

  /** 把消息排入 Pi 的 steering/follow-up 队列；Pi 同步发出 queue_update 驱动镜像。 */
  private async enqueuePrompt(active: ActiveSession, kind: "steer" | "followUp", text: string, images: Array<ImageAttachment & { data: string }>): Promise<void> {
    this.markUserMessage(active, new Date().toISOString());
    this.publishSummary(active);
    const imageContent = images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
    if (kind === "followUp") {
      await active.session.followUp(text, imageContent);
    } else {
      await active.session.steer(text, imageContent);
    }
  }

  /** 切换一条排队消息的投递方式（followUp ↔ steer）；其余消息按原顺序重入队。 */
  async setQueuedKind(ref: SessionRef, messageId: string, kind: "steer" | "followUp"): Promise<QueuedMessage | undefined> {
    const active = await this.getActive(ref);
    const match = [...active.queue.steering, ...active.queue.followUp].find((item) => item.id === messageId);
    if (match === undefined || match.kind === kind) return match;
    // 目标消息以新 kind 入队：steering 队列先于 followUp 投递，
    // 所以从“后续”切到“插队”会插到所有后续消息之前。
    await this.replayQueue(active, match, { ...match, kind });
    return { ...match, kind };
  }

  /** 全部取回排队消息（对齐 Pi TUI 的 Alt+Up / Escape 行为），返回给调用方恢复草稿。 */
  async dequeueQueue(ref: SessionRef): Promise<{ steering: QueuedMessage[]; followUp: QueuedMessage[] }> {
    const active = await this.getActive(ref);
    const { steering, followUp } = active.session.clearQueue();
    const removed = {
      steering: steering.map((text) => queuedMessage("steer", text)),
      followUp: followUp.map((text) => queuedMessage("followUp", text)),
    };
    this.syncQueue(active);
    return removed;
  }

  /** 删除（或取回）一条排队消息；其余消息按原顺序重新入队。 */
  async removeQueued(ref: SessionRef, messageId: string): Promise<QueuedMessage | undefined> {
    const active = await this.getActive(ref);
    const match = [...active.queue.steering, ...active.queue.followUp].find((item) => item.id === messageId);
    if (match === undefined) return undefined;
    await this.replayQueue(active, match);
    return match;
  }

  /** Pi 只提供全量 clearQueue；取出后把其余消息按原顺序重新入队。 */
  private async replayQueue(active: ActiveSession, skip: QueuedMessage, append?: QueuedMessage): Promise<void> {
    const queue = active.queue;
    const { steering, followUp } = active.session.clearQueue();
    active.queueSyncSuspended = true;
    try {
      for (const [index, text] of steering.entries()) {
        if (skip.kind === "steer" && skip.text === text && queue.steering[index]?.id === skip.id) continue;
        await active.session.steer(text);
      }
      for (const [index, text] of followUp.entries()) {
        if (skip.kind === "followUp" && skip.text === text && queue.followUp[index]?.id === skip.id) continue;
        await active.session.followUp(text);
      }
      if (append?.kind === "steer") await active.session.steer(append.text);
      else if (append?.kind === "followUp") await active.session.followUp(append.text);
    } finally {
      active.queueSyncSuspended = false;
      this.syncQueue(active);
    }
  }

  /** 把 Pi 的 queue_update 载荷同步为镜像并发布给浏览器。 */
  private publishQueue(active: ActiveSession): void {
    this.events.publishSession(active.ref, {
      type: "queue.updated",
      ...(active.state.activeRun === undefined ? {} : { runId: active.state.activeRun.id }),
      payload: { steering: active.queue.steering, followUp: active.queue.followUp },
    });
  }

  private syncQueue(active: ActiveSession): void {
    const previous = active.queue;
    active.queue = {
      steering: mergeQueuedMessages(previous.steering, active.session.getSteeringMessages(), "steer"),
      followUp: mergeQueuedMessages(previous.followUp, active.session.getFollowUpMessages(), "followUp"),
    };
    this.publishQueue(active);
  }

  /**
   * 执行用户输入框的 !cmd 命令（! 输出进上下文，!! 不进）。
   * 流式中禁用；执行期间会话进入 running 状态，停止按钮/ESC 会中止命令。
   */
  async bash(ref: SessionRef, command: string, excludeFromContext: boolean, clientRequestId: string): Promise<BashAccepted> {
    const value = command.trim();
    if (value === "") throw new AppError("COMMAND_EMPTY", "Command cannot be empty");
    if (value.length > MAX_PROMPT_LENGTH) throw new AppError("COMMAND_TOO_LARGE", `Command must be at most ${String(MAX_PROMPT_LENGTH)} characters`);
    const active = await this.getActive(ref);
    if (active.readOnly === true) throw new AppError("SIDE_CHAT_READ_ONLY", "This side chat is read-only", 403);
    const requestKey = `bash:${clientRequestId}`;
    const previous = active.requestRuns.get(requestKey);
    if (previous !== undefined) return previous as BashAccepted;
    if (active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming) {
      throw new AppError("SESSION_BUSY", "This session is already running", 409);
    }

    const run: ActiveRun = { id: randomUUID(), startedAt: new Date().toISOString(), kind: "bash" };
    const item: ToolTimelineItem = {
      kind: "tool",
      id: `bash:${run.id}`,
      createdAt: run.startedAt,
      name: "bash",
      title: "Run command",
      state: "running",
      target: value,
      inputPreview: value,
      ...(excludeFromContext ? { excludeFromContext: true } : {}),
      output: "",
    };
    active.state = { sessionId: ref.sessionId, runState: "running", activeRun: run };
    this.setAttention(active, "running", run.startedAt);
    this.markUserMessage(active, run.startedAt);
    active.updatedAt = run.startedAt;
    active.liveMessages.clear();
    active.liveErrors.clear();
    active.assistantStreamId = undefined;
    active.partial = undefined;
    active.partialThinking = undefined;
    active.activeTools.clear();
    active.activeBash = item;
    active.extensionFailure = undefined;
    active.pendingRunError = undefined;
    const accepted: BashAccepted = { accepted: true, runId: run.id };
    this.rememberRequest(active, requestKey, accepted);

    this.events.publishSession(active.ref, { type: "run.started", runId: run.id, payload: { status: active.state, bash: item } });
    this.publishSummary(active);
    void this.executeBashRun(active, value, excludeFromContext, run.id);
    return accepted;
  }

  private validateAttachments(images: ImageAttachment[] | undefined): Array<ImageAttachment & { data: string }> {
    const attachments = images ?? [];
    const accepted: Array<ImageAttachment & { data: string }> = [];
    for (const image of attachments) {
      if (!ALLOWED_IMAGE_TYPES.has(image.mimeType)) {
        throw new AppError("ATTACHMENT_TYPE_UNSUPPORTED", `Image type ${image.mimeType} is not supported`);
      }
      if (typeof image.data !== "string" || image.data === "" || image.data.length > MAX_ATTACHMENT_DATA_LENGTH) {
        throw new AppError("ATTACHMENT_TOO_LARGE", "One of the attached images is too large");
      }
      accepted.push({ mimeType: image.mimeType, data: image.data });
    }
    return accepted;
  }

  async compact(ref: SessionRef, customInstructions?: string, clientRequestId?: string): Promise<CompactAccepted> {
    const active = await this.getActive(ref);
    if (clientRequestId === undefined) return this.startCompaction(active, customInstructions);

    const requestKey = `compact:${clientRequestId}`;
    const previous = active.requestRuns.get(requestKey);
    if (previous !== undefined) return previous as CompactAccepted;
    const accepted = this.startCompaction(active, customInstructions);
    this.rememberRequest(active, requestKey, accepted);
    return accepted;
  }

  private startCompaction(active: ActiveSession, customInstructions?: string): CompactAccepted {
    if (active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming) {
      throw new AppError("SESSION_BUSY", "Stop the current run before compacting this session", 409);
    }

    const run: ActiveRun = { id: randomUUID(), startedAt: new Date().toISOString(), kind: "compaction" };
    active.state = {
      sessionId: active.ref.sessionId,
      runState: "running",
      activeRun: run,
      compacting: { reason: "manual", startedAt: run.startedAt },
    };
    this.setAttention(active, "running");
    active.updatedAt = run.startedAt;
    active.extensionFailure = undefined;
    active.pendingRunError = undefined;
    this.events.publishSession(active.ref, { type: "run.started", runId: run.id, payload: { status: active.state } });
    this.publishSummary(active);
    void this.executeCompaction(active, customInstructions?.trim() || undefined, run.id);
    return { accepted: true, runId: run.id };
  }

  private jarvisCompactCommand(active: ActiveSession, prompt: string): { customInstructions?: string } | undefined {
    if (this.hasPiCommand(active, JARVIS_COMPACT_COMMAND.name)) return undefined;
    const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(prompt);
    if (match === null) return undefined;
    const customInstructions = match[1]?.trim();
    return customInstructions === undefined || customInstructions === "" ? {} : { customInstructions };
  }

  /** 命中 /reload 且 Pi 未注册同名命令时返回 true（拦截并交给 startReload）。 */
  private jarvisReloadCommand(active: ActiveSession, prompt: string): boolean {
    if (this.hasPiCommand(active, JARVIS_RELOAD_COMMAND.name)) return false;
    return /^\/reload\s*$/.test(prompt);
  }

  private startReload(active: ActiveSession): PromptAccepted {
    if (active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming) {
      throw new AppError("SESSION_BUSY", "Stop the current run before reloading resources", 409);
    }

    const run: ActiveRun = { id: randomUUID(), startedAt: new Date().toISOString(), kind: "reload" };
    active.state = {
      sessionId: active.ref.sessionId,
      runState: "running",
      activeRun: run,
    };
    this.setAttention(active, "running");
    active.updatedAt = run.startedAt;
    active.extensionFailure = undefined;
    active.pendingRunError = undefined;
    this.events.publishSession(active.ref, { type: "run.started", runId: run.id, payload: { status: active.state } });
    this.publishSummary(active);
    void this.executeReload(active, run.id);
    return { accepted: true, runId: run.id };
  }

  private async executeReload(active: ActiveSession, runId: string): Promise<void> {
    try {
      await active.session.reload();
      bindOwnerSessionId(this.ownerBoundSessions, active.session);
      if (active.state.activeRun?.id !== runId) return;
      this.events.publishWorkspace(active.ref.workspaceId, {
        version: PROTOCOL_VERSION,
        type: "extension.notify",
        workspaceId: active.ref.workspaceId,
        notification: { id: randomUUID(), message: "已重新加载 AGENTS.md / 插件 / 技能 / 提示词" },
      });
      this.settleRun(active, runId);
    } catch (error) {
      if (active.state.activeRun?.id !== runId) return;
      const message = asMessage(error);
      this.events.publishWorkspace(active.ref.workspaceId, {
        version: PROTOCOL_VERSION,
        type: "extension.notify",
        workspaceId: active.ref.workspaceId,
        notification: { id: randomUUID(), message: `重新加载失败：${message}`, notifyType: "error" },
      });
      this.failRun(active, runId, "RESOURCE_RELOAD_FAILED", message);
    }
  }

  private hasPiCommand(active: ActiveSession, name: string): boolean {
    return active.session.extensionRunner.getRegisteredCommands().some((command) => command.invocationName === name)
      || active.session.promptTemplates.some((template) => template.name === name);
  }

  private rememberRequest(active: ActiveSession, clientRequestId: string, accepted: RunAccepted): void {
    active.requestRuns.set(clientRequestId, accepted);
    if (active.requestRuns.size > 48) active.requestRuns.delete(active.requestRuns.keys().next().value as string);
  }

  async abort(ref: SessionRef, runId?: string): Promise<{ aborted: true; dequeued?: { steering: QueuedMessage[]; followUp: QueuedMessage[] } }> {
    const active = await this.getActive(ref);
    const activeRun = active.state.activeRun;
    if (activeRun === undefined && active.state.compacting === undefined) {
      throw new AppError("RUN_NOT_ACTIVE", "This session does not have an active run", 409);
    }
    if (runId !== undefined && activeRun?.id !== runId) throw new AppError("RUN_NOT_ACTIVE", "This run is no longer active", 409);
    // 停止前取回排队消息（对齐 Pi TUI Escape：清队列并把消息恢复到编辑器），
    // 避免 agent 空闲后 follow-up 自动触发新 run 继续执行。
    const { steering, followUp } = active.session.clearQueue();
    const dequeued: { steering: QueuedMessage[]; followUp: QueuedMessage[] } = {
      steering: steering.map((text) => queuedMessage("steer", text)),
      followUp: followUp.map((text) => queuedMessage("followUp", text)),
    };
    if (dequeued.steering.length > 0 || dequeued.followUp.length > 0) this.syncQueue(active);
    active.state = { ...active.state, runState: "stopping" };
    this.events.publishSession(active.ref, { type: "run.stopping", ...(activeRun === undefined ? {} : { runId: activeRun.id }), payload: { status: active.state } });
    this.publishSummary(active);

    if (active.state.compacting !== undefined) {
      this.cancelCompaction(active);
      this.scheduleStopFallback(active, activeRun?.id);
      return { aborted: true, ...(dequeued.steering.length > 0 || dequeued.followUp.length > 0 ? { dequeued } : {}) };
    }
    if (activeRun?.kind === "bash") {
      // executeBashRun 会在命令结束时自行 settle；异常情况下由超时兜底收敛。
      active.session.abortBash();
      this.scheduleStopFallback(active, activeRun.id);
      return { aborted: true, ...(dequeued.steering.length > 0 || dequeued.followUp.length > 0 ? { dequeued } : {}) };
    }

    try {
      await this.abortPiWithTimeout(active.session);
      if (activeRun !== undefined && active.state.activeRun?.id === activeRun.id) this.settleRun(active, activeRun.id);
      return { aborted: true, ...(dequeued.steering.length > 0 || dequeued.followUp.length > 0 ? { dequeued } : {}) };
    } catch (error) {
      this.failRun(active, active.state.activeRun?.id, "PI_RUNTIME_ERROR", asMessage(error));
      throw error;
    }
  }

  async resolveExtensionUi(ref: SessionRef, id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
    // This endpoint must not wait for bindExtensions(): a startup dialog is
    // precisely what may be keeping that promise pending.
    const active = await this.getActive(ref, { waitForExtensions: false });
    if (!active.extensionUi.respond({ id, ...response })) {
      // A stale id and a malformed response deliberately share the same public
      // result: callers cannot probe another pending dialog's shape.
      throw new AppError("UI_REQUEST_NOT_FOUND", "This extension UI request is no longer pending", 404);
    }
  }

  hasActiveWorkspace(workspaceId: string): boolean {
    return [...this.active.values()].some((active) => active.ref.workspaceId === workspaceId && active.state.runState !== "idle");
  }

  async disposeWorkspace(workspaceId: string): Promise<void> {
    const refs = [...this.active.values()]
      .filter((active) => active.ref.workspaceId === workspaceId)
      .map((active) => active.ref);
    for (const ref of refs) {
      await this.withSessionTransition(ref, async () => {
        const active = this.active.get(activeKey(ref));
        if (active !== undefined && active.ref.workspaceId === workspaceId) await this.disposeActive(active, "quit");
      });
    }
  }

  async dispose(): Promise<void> {
    const refs = [...this.active.values()].map((active) => active.ref);
    for (const ref of refs) {
      await this.withSessionTransition(ref, async () => {
        const active = this.active.get(activeKey(ref));
        if (active !== undefined) await this.disposeActive(active, "quit");
      });
    }
    this.active.clear();
    this.pendingOpens.clear();
    this.deleting.clear();
    this.sessionTransitions.clear();
    await this.attention.flush();
  }

  private async executePrompt(active: ActiveSession, prompt: string, runId: string, images: Array<ImageAttachment & { data: string }> = []): Promise<void> {
    try {
      await active.session.prompt(prompt, {
        source: "rpc",
        ...(images.length === 0
          ? {}
          : { images: images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })) }),
      });
      if (active.state.activeRun?.id === runId && active.session.isIdle) this.deferAgentSettlement(active);
    } catch (error) {
      // A normal Pi run settles through agent_settled. Keep preflight failures
      // here, but do not let an extension compaction's abort win the lifecycle race.
      if (active.state.activeRun?.id === runId && !isOperationCancellation(error)) this.failRun(active, runId, runtimeFailureCode(error), asMessage(error));
    }
  }

  private async executeCompaction(active: ActiveSession, customInstructions: string | undefined, runId: string): Promise<void> {
    try {
      await active.session.compact(customInstructions);
      if (active.state.activeRun?.id === runId) this.settleRun(active, runId);
    } catch (error) {
      if (active.state.activeRun?.id !== runId) return;
      if (isCompactionCancellation(error)) this.settleRun(active, runId);
      else this.failRun(active, runId, "PI_COMPACTION_FAILED", asMessage(error));
    }
  }

  private async executeBashRun(active: ActiveSession, command: string, excludeFromContext: boolean, runId: string): Promise<void> {
    try {
      const result = await active.session.executeBash(command, (delta) => {
        const item = active.activeBash;
        if (item === undefined || delta === "") return;
        if (item.truncated === true) return;
        const appended = (item.output ?? "") + delta;
        if (appended.length > MAX_BASH_OUTPUT_CHARS) {
          // 流式视图截断；落盘结果由 Pi 完整截断并保留完整输出文件。
          item.output = appended.slice(0, MAX_BASH_OUTPUT_CHARS);
          item.truncated = true;
        } else {
          item.output = appended;
        }
        this.events.publishSession(active.ref, { type: "bash.delta", runId, payload: { delta } });
      }, { excludeFromContext, id: runId });
      if (active.state.activeRun?.id !== runId) return;
      // Pi 在空闲时会立即把 bashExecution 结果写入会话文件；从分支重新投影出落盘条目。
      const item = this.lastBashItem(active, command);
      active.activeBash = undefined;
      this.events.publishSession(active.ref, {
        type: "bash.settled",
        runId,
        payload: {
          ...(item === undefined ? {} : { item }),
          cancelled: result.cancelled,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
          ...(result.truncated ? { truncated: true } : {}),
          ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
        },
      });
      this.settleRun(active, runId);
    } catch (error) {
      if (active.state.activeRun?.id !== runId) return;
      const message = asMessage(error);
      const failed = active.activeBash === undefined
        ? undefined
        : { ...active.activeBash, state: "failed" as const, output: undefined, error: message, truncated: false };
      active.activeBash = undefined;
      this.events.publishSession(active.ref, {
        type: "bash.settled",
        runId,
        payload: { ...(failed === undefined ? {} : { item: failed }), failed: true, errorMessage: message },
      });
      this.failRun(active, runId, "BASH_EXECUTION_FAILED", message);
    }
  }

  /** 从会话分支中找出最近一条命令相同的 bashExecution 落盘条目。 */
  private lastBashItem(active: ActiveSession, command: string): ToolTimelineItem | undefined {
    for (const entry of [...active.session.sessionManager.getBranch()].reverse()) {
      if (!isRecord(entry) || entry["type"] !== "message") continue;
      const message = entry["message"];
      if (!isRecord(message) || message["role"] !== "bashExecution") continue;
      if (stringValue(message["command"]) !== command) continue;
      const entryId = stringValue(entry["id"]) || crypto.randomUUID();
      const createdAt = toIso(entry["timestamp"] ?? message["timestamp"]);
      return bashExecutionItem(entryId, createdAt, message);
    }
    return undefined;
  }

  private contextUsageSnapshot(active: ActiveSession): ContextUsage | undefined {
    return active.session.getContextUsage();
  }

  /**
   * Session branches are append-only. A projection remains valid while its
   * leaf id is unchanged, so repeated pagination and hydration requests do
   * not have to traverse and project the full branch again.
   */
  private timelineItems(active: ActiveSession): TimelineItem[] {
    const leafId = active.session.sessionManager.getLeafId();
    const cached = active.timelineCache;
    if (cached?.leafId === leafId) return cached.items;
    const items = projectHistory(active.session.sessionManager.getBranch());
    active.timelineCache = { leafId, items };
    return items;
  }

  /** Push the latest estimated context usage to browsers (fires rarely). */
  private publishContextUsage(active: ActiveSession, runId?: string): void {
    const contextUsage = this.contextUsageSnapshot(active);
    if (contextUsage === undefined) return;
    this.events.publishSession(active.ref, {
      type: "context.updated",
      ...(runId === undefined ? {} : { runId }),
      payload: { contextUsage },
    });
  }

  /** Already-open session only. Media requests must not start AgentSession. */
  private peekActive(ref: SessionRef): ActiveSession | undefined {
    return this.active.get(activeKey(ref));
  }

  private async getActive(ref: SessionRef, options: { waitForExtensions?: boolean; waitForTransition?: boolean } = {}): Promise<ActiveSession> {
    const waitForExtensions = options.waitForExtensions ?? true;
    const waitForTransition = options.waitForTransition ?? true;
    const key = activeKey(ref);
    if (waitForTransition) {
      const transition = this.sessionTransitions.get(key);
      if (transition !== undefined) await transition;
    }
    if (this.deleting.has(key)) throw new AppError("SESSION_BUSY", "This session is being deleted", 409);
    const existing = this.active.get(key);
    if (existing !== undefined) {
      if (waitForExtensions) await existing.extensionReady;
      return existing;
    }
    const pending = this.pendingOpens.get(key);
    if (pending !== undefined) {
      const active = await pending;
      if (waitForExtensions) await active.extensionReady;
      return active;
    }
    const promise = this.openActive(ref);
    this.pendingOpens.set(key, promise);
    try {
      const active = await promise;
      if (waitForExtensions) await active.extensionReady;
      return active;
    } finally {
      if (this.pendingOpens.get(key) === promise) this.pendingOpens.delete(key);
    }
  }

  private async openActive(ref: SessionRef): Promise<ActiveSession> {
    if (!isVisibleSessionId(ref.sessionId)) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    const workspace = this.workspaces.get(ref.workspaceId);
    const path = await findSessionFile(workspace, ref.sessionId);
    if (path === undefined) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    return this.createActive(ref, workspace, openManagedSession(workspace.cwd, path));
  }

  private async createActive(ref: SessionRef, workspace: Workspace, manager: SessionManager, options?: { readOnly?: boolean }): Promise<ActiveSession> {
    return createActiveSession({
      attention: this.attention,
      events: this.events,
      active: this.active,
      ownerBoundSessions: this.ownerBoundSessions,
      piEvents: this.piEvents,
      getModelRuntime: (agentDir) => this.getModelRuntime(agentDir),
      setAttention: (active, state) => this.setAttention(active, state),
      publishSummary: (active) => this.publishSummary(active),
    }, ref, workspace, manager, options);
  }

  private modelSnapshot(active: ActiveSession) {
    // Mark instead of filter: the model selector keeps the enabled scope by
    // default, but a "show all" toggle can surface every available model.
    return projectModelSnapshot(active.session.model, active.modelRuntime.getAvailableSnapshot(), this.inScopeKeys(active));
  }

  /** Pi's `enabledModels` becomes `session.scopedModels`; an empty scope means all models. */
  private inScopeKeys(active: ActiveSession): ReadonlySet<string> | undefined {
    if (active.session.scopedModels.length === 0) return undefined;
    return new Set(active.session.scopedModels.map(({ model }) => `${model.provider}\u0000${model.id}`));
  }

  private thinkingSnapshot(active: ActiveSession): SessionThinkingSnapshot {
    return {
      current: active.session.thinkingLevel,
      available: [...active.session.getAvailableThinkingLevels()],
    };
  }

  private async availableModels(runtime: ModelRuntime) {
    const cached = runtime.getAvailableSnapshot();
    return cached.length > 0 ? cached : await runtime.getAvailable();
  }

  private async getModelRuntime(agentDir: string): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    return this.modelRuntimePromise;
  }

  private resetLiveStream(active: ActiveSession): void {
    active.liveMessages.clear();
    active.liveErrors.clear();
    active.assistantStreamId = undefined;
    active.partial = undefined;
    active.partialThinking = undefined;
    active.activeTools.clear();
    active.extensionFailure = undefined;
    active.pendingRunError = undefined;
  }

  private publishTool(active: ActiveSession, tool: ToolTimelineItem, runId?: string): void {
    const id = runId ?? active.state.activeRun?.id;
    active.activeTools.set(tool.id, tool);
    this.events.publishSession(active.ref, { type: "tool.upsert", runId: id, payload: { tool: toExternalTimelineItem(tool, active.ref) } });
  }

  private settleRun(active: ActiveSession, runId: string | undefined): void {
    if (runId === undefined || active.state.activeRun?.id !== runId) return;
    for (const tool of active.activeTools.values()) {
      if (tool.state !== "queued" && tool.state !== "running") continue;
      const cancelled = { ...tool, state: "cancelled" as const };
      active.activeTools.set(tool.id, cancelled);
      this.events.publishSession(active.ref, { type: "tool.upsert", runId, payload: { tool: toExternalTimelineItem(cancelled, active.ref) } });
    }
    const lastError = active.state.lastError;
    active.state = {
      sessionId: active.ref.sessionId,
      runState: "idle",
      ...(lastError === undefined ? {} : { lastError }),
    };
    this.setAttention(active, "completed_unread");
    active.liveMessages.clear();
    active.liveErrors.clear();
    active.partial = undefined;
    active.partialThinking = undefined;
    active.activeTools.clear();
    active.activeBash = undefined;
    active.compactionAbortRequested = false;
    active.extensionFailure = undefined;
    active.pendingRunError = undefined;
    active.compactionHandoff = false;
    this.clearSettlementTimer(active);
    // 队列在此刻应已为空（Pi 投递完才会 settle）；异常残留时强制清空展示。
    if (active.queue.steering.length > 0 || active.queue.followUp.length > 0) {
      active.queue = emptySessionQueue;
      this.publishQueue(active);
    }
    this.events.publishSession(active.ref, { type: "run.settled", runId, payload: { status: active.state } });
    this.publishSummary(active);
    this.persistListCopy(active, this.summaryFromActive(active));
  }

  private failRun(active: ActiveSession, runId: string | undefined, code: string, message: string): void {
    if (runId === undefined || active.state.activeRun?.id !== runId) return;
    active.state = {
      sessionId: active.ref.sessionId,
      runState: "idle",
      lastError: { code, message, occurredAt: new Date().toISOString() },
    };
    this.setAttention(active, "failed");
    for (const tool of active.activeTools.values()) {
      if (tool.state !== "queued" && tool.state !== "running") continue;
      const cancelled = { ...tool, state: "cancelled" as const };
      active.activeTools.set(tool.id, cancelled);
      this.events.publishSession(active.ref, { type: "tool.upsert", runId, payload: { tool: toExternalTimelineItem(cancelled, active.ref) } });
    }
    active.liveMessages.clear();
    active.liveErrors.clear();
    active.partial = undefined;
    active.partialThinking = undefined;
    active.activeTools.clear();
    active.activeBash = undefined;
    active.compactionAbortRequested = false;
    active.extensionFailure = undefined;
    active.pendingRunError = undefined;
    active.compactionHandoff = false;
    this.clearSettlementTimer(active);
    if (active.queue.steering.length > 0 || active.queue.followUp.length > 0) {
      active.queue = emptySessionQueue;
      this.publishQueue(active);
    }
    this.events.publishSession(active.ref, { type: "run.failed", runId, payload: { status: active.state } });
    this.persistListCopy(active, this.summaryFromActive(active));
    this.publishSummary(active);
  }

  private cancelCompaction(active: ActiveSession): void {
    active.compactionAbortRequested = true;
    active.session.abortCompaction();
    // Pi emits compaction_start before it creates the controller. Re-run after
    // that synchronous event stack so a stop click cannot be lost in that gap.
    queueMicrotask(() => {
      if (active.compactionAbortRequested && active.state.compacting !== undefined) active.session.abortCompaction();
    });
  }

  /**
   * ctx.compact() first aborts and waits for Pi to emit agent_settled, then
   * emits compaction_start. Deferring this decision lets that handoff retain
   * the external run instead of publishing a false idle state in between.
   */
  private deferAgentSettlement(active: ActiveSession): void {
    this.clearSettlementTimer(active);
    const deadline = Date.now() + SETTLEMENT_MAX_WAIT_MS;
    const attempt = () => {
      active.settlementTimer = setTimeout(() => {
        active.settlementTimer = undefined;
        if (active.state.activeRun === undefined || active.state.compacting !== undefined) return;
        const blocked = active.session.isStreaming || active.queue.steering.length > 0 || active.queue.followUp.length > 0;
        if (blocked && Date.now() < deadline) {
          attempt();
          return;
        }
        // A missing agent_settled/queue_update must not leave the external run
        // alive forever. At the deadline, settle and clear stale queued UI state.
        if (active.pendingRunError !== undefined) {
          const failure = active.pendingRunError;
          active.pendingRunError = undefined;
          this.failRun(active, active.state.activeRun.id, failure.code, failure.message);
        } else if (active.extensionFailure !== undefined) {
          this.failRun(active, active.state.activeRun.id, active.extensionFailure.code, active.extensionFailure.message);
        } else {
          this.settleRun(active, active.state.activeRun.id);
        }
      }, blockedDelay(active, deadline));
    };
    const blockedDelay = (_current: ActiveSession, target: number) => Math.max(0, Math.min(SETTLEMENT_RETRY_INTERVAL_MS, target - Date.now()));
    attempt();
  }

  private scheduleStopFallback(active: ActiveSession, runId: string | undefined): void {
    if (runId === undefined) return;
    this.clearSettlementTimer(active);
    active.settlementTimer = setTimeout(() => {
      active.settlementTimer = undefined;
      if (active.state.runState === "stopping" && active.state.activeRun?.id === runId) this.settleRun(active, runId);
    }, PI_ABORT_TIMEOUT_MS);
  }

  private async abortPiWithTimeout(session: AgentSession): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = session.abort();
    try {
      return await Promise.race([
        abort.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), PI_ABORT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private clearSettlementTimer(active: ActiveSession): void {
    if (active.settlementTimer === undefined) return;
    clearTimeout(active.settlementTimer);
    active.settlementTimer = undefined;
  }

  private setAttention(active: ActiveSession, state: SessionAttentionState, at?: string): void {
    const when = at ?? new Date().toISOString();
    if (active.attentionState === state) return;
    active.attentionState = state;
    if (state === "idle") delete active.attentionAt;
    else active.attentionAt = when;
    void this.attention.setAttention(active.ref, state, when).catch((error: unknown) => console.warn("Could not persist session attention state", error));
  }

  private markUserMessage(active: ActiveSession, at: string): void {
    active.lastUserMessageAt = at;
    void this.attention.setLastUserMessageAt(active.ref, at).catch((error: unknown) => console.warn("Could not persist last user message time", error));
  }

  private persistListCopy(active: ActiveSession, summary: SessionSummary): void {
    const path = active.session.sessionFile;
    if (path === undefined) return;
    void sessionFileMtimeMs(path).then((mtimeMs) => {
      if (mtimeMs === undefined) return;
      return this.attention.setListCopies([{ ref: active.ref, copy: { name: summary.name, preview: summary.preview, listCopyMtime: mtimeMs } }]);
    }).catch((error: unknown) => console.warn("Could not persist session list copy", error));
  }

  private publishSummary(active: ActiveSession, supplied?: SessionSummary): void {
    const summary = supplied ?? this.summaryFromActive(active);
    this.events.publishSession(active.ref, { type: "session.updated", payload: { status: active.state, session: summary } });
    if (active.readOnly === true) return;
    this.events.publishWorkspace(active.ref.workspaceId, { version: 1, type: "session.updated", workspaceId: active.ref.workspaceId, session: summary });
  }

  private summaryFromList(workspace: Workspace, entry: { id: string; name?: string; firstMessage: string; created: Date; modified: Date }, persisted?: SessionSortMeta): SessionSummary {
    return summaryFromList(this.active, workspace, entry, persisted);
  }

  private async summaryFromStored(workspace: Workspace, ref: SessionRef, path: string): Promise<SessionSummary> {
    return summaryFromStored(this.catalogDeps(), workspace, ref, path);
  }

  private summaryFromActive(active: ActiveSession, previewOverride?: string): SessionSummary {
    return summaryFromActive(active, previewOverride);
  }

  private catalogDeps() {
    return { workspaces: this.workspaces, attention: this.attention, active: this.active };
  }
}
