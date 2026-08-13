import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import type {
  BashAccepted,
  CompactAccepted,
  ComposerCommand,
  ContextUsage,
  ErrorTimelineItem,
  ImageAttachment,
  MessageTimelineItem,
  ModelDescriptor,
  PromptAccepted,
  QueuedMessage,
  QueuedPromptAccepted,
  RetryStatus,
  SessionQueue,
  SessionRef,
  SessionStatus,
  SessionStreamSnapshot,
  SessionSummary,
  SessionThinkingSnapshot,
  ThinkingLevel,
  ThinkingTimelineItem,
  TimelineItem,
  TimelinePage,
  ToolTimelineItem,
  Workspace,
} from "../shared/protocol.js";
import { emptySessionQueue } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";
import { EventHub } from "./event-hub.js";
import { ExtensionUiBridge, isUnsupportedExtensionInteraction, UNSUPPORTED_EXTENSION_INTERACTION, type ExtensionUiMessage } from "./extension-ui.js";
import { projectModelSnapshot } from "./model-projection.js";
import { assistantTextFromContent, bashExecutionItem, contextSummaryFromEntry, errorFromPi, messageFromPi, projectHistory, thinkingTextFromContent, toolFromCall, toolWithPartial, toolWithResult, userContentFromContent } from "./projection.js";
import { WorkspaceStore } from "./workspace-store.js";

interface ActiveRun {
  id: string;
  startedAt: string;
  kind: "llm" | "bash" | "compaction";
}

/** 所有运行类请求的幂等缓存值。 */
type RunAccepted = { accepted: true; runId?: string; queued?: boolean; behavior?: "steer" | "followUp" };

interface ActiveSession {
  ref: SessionRef;
  cwd: string;
  session: AgentSession;
  modelRuntime: ModelRuntime;
  modelSwitching: boolean;
  unsubscribe: () => void;
  state: SessionStatus;
  requestRuns: Map<string, RunAccepted>;
  liveMessages: Map<string, MessageTimelineItem>;
  /** Retry attempts which have not yet been reconciled with persisted history. */
  liveErrors: Map<string, ErrorTimelineItem>;
  partial?: MessageTimelineItem;
  /** 当前 run 正在流式的思考块（message_end 定稿前）。 */
  partialThinking?: ThinkingTimelineItem;
  /** 排队等待投递的用户消息镜像（来自 Pi 的 queue_update 事件）。 */
  queue: SessionQueue;
  /** clearQueue+重入队期间暂停镜像同步，避免发布中间态。 */
  queueSyncSuspended: boolean;
  activeTools: Map<string, ToolTimelineItem>;
  /** 正在执行的用户 !cmd 命令（流式输出尚未落盘）。 */
  activeBash?: ToolTimelineItem;
  /** Retains a stop click that arrives before Pi installs its compaction abort controller. */
  compactionAbortRequested: boolean;
  extensionFailure?: { code: string; message: string };
  /** 扩展 ctx.ui 请求桥（对话框待浏览器响应）。 */
  extensionUi: ExtensionUiBridge;
  /** Error from the last assistant message; applied at agent_settled once Pi's retries/compaction finish. */
  pendingRunError?: { code: string; message: string };
  /** A deferred settle lets extension-triggered compaction claim the active run. */
  settlementTimer?: ReturnType<typeof setTimeout>;
  /** The current compaction took over immediately after an agent_settled handoff. */
  compactionHandoff: boolean;
  createdAt: string;
  updatedAt: string;
}

const PAGE_LIMIT = 120;
const MAX_PROMPT_LENGTH = 40_000;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_DATA_LENGTH = 14_000_000; // ≈ 10 MiB decoded
const MAX_BASH_OUTPUT_CHARS = 100_000; // 流式气泡的最大输出长度，落盘结果由 Pi 自行截断
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);
const JARVIS_COMPACT_COMMAND: ComposerCommand = {
  name: "compact",
  description: "压缩当前会话上下文",
  source: "jarvis",
};

export class SessionService {
  private readonly active = new Map<string, ActiveSession>();
  private readonly pendingOpens = new Map<string, Promise<ActiveSession>>();
  private readonly deleting = new Set<string>();
  private modelRuntimePromise: Promise<ModelRuntime> | undefined;

  constructor(
    private readonly workspaces: WorkspaceStore,
    private readonly events: EventHub,
  ) {}

  async list(workspaceId: string, query?: string): Promise<SessionSummary[]> {
    const workspace = this.workspaces.get(workspaceId);
    const sessionDir = sessionDirectoryFor(workspace.cwd, getAgentDir());
    const listed = sessionDir === undefined
      ? await SessionManager.list(workspace.cwd)
      : await SessionManager.list(workspace.cwd, sessionDir);
    const summaries = listed.map((entry) => this.summaryFromList(workspace, entry));

    for (const active of this.active.values()) {
      if (active.ref.workspaceId !== workspaceId || summaries.some((summary) => summary.id === active.ref.sessionId)) continue;
      summaries.unshift(this.summaryFromActive(active));
    }

    const needle = query?.trim().toLocaleLowerCase();
    return summaries
      .filter((summary) => needle === undefined || needle === "" || `${summary.name ?? ""}\n${summary.preview ?? ""}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(workspaceId: string): Promise<SessionSummary> {
    const workspace = this.workspaces.get(workspaceId);
    const sessionDir = sessionDirectoryFor(workspace.cwd, getAgentDir());
    const manager = sessionDir === undefined ? SessionManager.create(workspace.cwd) : SessionManager.create(workspace.cwd, sessionDir);
    const active = await this.createActive({ workspaceId, sessionId: "" }, workspace, manager);
    const summary = this.summaryFromActive(active);
    this.events.publishWorkspace(workspaceId, { version: 1, type: "session.created", workspaceId, session: summary });
    return summary;
  }

  async fork(ref: SessionRef, messageId: string): Promise<SessionSummary> {
    const active = await this.getActive(ref);
    this.assertSessionIdle(active, "Fork");
    const entryId = findVisibleMessageEntryId(active.session.sessionManager.getBranch(), messageId);
    if (entryId === undefined) throw new AppError("MESSAGE_NOT_FOUND", "Message not found in this session", 404);
    const sourcePath = active.session.sessionFile;
    if (sourcePath === undefined) throw new AppError("SESSION_NOT_READY", "Wait for this message to be saved before forking", 409);

    const sessionDir = sessionDirectoryFor(active.cwd, getAgentDir());
    // createBranchedSession mutates its manager, so never call it on the
    // currently active source manager.
    const manager = sessionDir === undefined ? SessionManager.open(sourcePath) : SessionManager.open(sourcePath, sessionDir);
    manager.createBranchedSession(entryId);
    const workspace = this.workspaces.get(ref.workspaceId);
    const forked = await this.createActive({ workspaceId: ref.workspaceId, sessionId: "" }, workspace, manager);
    const summary = this.summaryFromActive(forked);
    this.events.publishWorkspace(ref.workspaceId, { version: 1, type: "session.created", workspaceId: ref.workspaceId, session: summary });
    return summary;
  }

  async editAndResend(ref: SessionRef, messageId: string, text: string, clientRequestId: string, images?: ImageAttachment[]): Promise<PromptAccepted> {
    const active = await this.getActive(ref);
    this.assertSessionIdle(active, "Editing");
    const entry = findUserMessageEntry(active.session.sessionManager.getBranch(), messageId);
    if (entry === undefined) throw new AppError("MESSAGE_NOT_FOUND", "User message not found in this session", 404);

    const parentId = stringValue(entry["parentId"]) || undefined;
    if (parentId === undefined) active.session.sessionManager.resetLeaf();
    else active.session.sessionManager.branch(parentId);
    active.extensionUi.reset();
    this.events.publishSession(active.ref, {
      type: "session.rewritten",
      payload: { items: projectHistory(active.session.sessionManager.getBranch()), status: { sessionId: active.ref.sessionId, runState: "idle" } },
    });
    await this.reopenAtCurrentBranch(active);
    return this.prompt(ref, text, clientRequestId, images) as Promise<PromptAccepted>;
  }

  async rename(ref: SessionRef, name: string): Promise<SessionSummary> {
    const value = name.trim();
    if (value === "") throw new AppError("SESSION_NAME_INVALID", "Session name is required");
    if (value.length > 120) throw new AppError("SESSION_NAME_INVALID", "Session name must be at most 120 characters");
    const active = await this.getActive(ref);
    active.session.setSessionName(value);
    const summary = this.summaryFromActive(active);
    this.publishSummary(active, summary);
    return summary;
  }

  async remove(ref: SessionRef): Promise<void> {
    const key = activeKey(ref);
    if (this.deleting.has(key)) throw new AppError("SESSION_BUSY", "This session is already being deleted", 409);
    this.deleting.add(key);

    try {
      const workspace = this.workspaces.get(ref.workspaceId);
      const pending = this.pendingOpens.get(key);
      if (pending !== undefined) await pending.catch(() => undefined);

      const active = this.active.get(key);
      if (active !== undefined && (active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming)) {
        throw new AppError("SESSION_BUSY", "Stop the current run before deleting this session", 409);
      }

      const sessionDir = sessionDirectoryFor(workspace.cwd, getAgentDir());
      const listed = sessionDir === undefined
        ? await SessionManager.list(workspace.cwd)
        : await SessionManager.list(workspace.cwd, sessionDir);
      const match = listed.find((entry) => entry.id === ref.sessionId);
      if (match === undefined && active === undefined) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);

      if (active !== undefined) {
        this.clearSettlementTimer(active);
        active.unsubscribe();
        active.extensionUi.closeAll();
        active.session.dispose();
        this.active.delete(key);
      }

      if (match !== undefined) {
        try {
          await rm(match.path);
        } catch (error) {
          if (isMissingFile(error)) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
          throw new AppError("SESSION_DELETE_FAILED", "Unable to delete session history", 500);
        }
      }

      this.events.publishWorkspace(ref.workspaceId, { version: 1, type: "session.deleted", workspaceId: ref.workspaceId, sessionId: ref.sessionId });
    } finally {
      this.deleting.delete(key);
    }
  }

  async timeline(ref: SessionRef, before?: number, limit = PAGE_LIMIT): Promise<TimelinePage> {
    const active = await this.getActive(ref);
    const items = projectHistory(active.session.sessionManager.getBranch());
    const end = clamp(before ?? items.length, 0, items.length);
    const requestedStart = Math.max(0, end - clamp(limit, 1, 500));
    const start = expandToUserBoundary(items, requestedStart);
    return { items: items.slice(start, end), start, total: items.length, hasMore: start > 0 };
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

  /** Recreate Pi's in-memory agent context after moving a session leaf. */
  private async reopenAtCurrentBranch(active: ActiveSession): Promise<void> {
    const key = activeKey(active.ref);
    active.unsubscribe();
    active.extensionUi.closeAll();
    active.session.dispose();
    this.active.delete(key);
    await this.createActive(active.ref, this.workspaces.get(active.ref.workspaceId), active.session.sessionManager);
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
    return commands.some((command) => command.name === JARVIS_COMPACT_COMMAND.name)
      ? commands
      : [JARVIS_COMPACT_COMMAND, ...commands];
  }

  async runtime(ref: SessionRef): Promise<SessionStreamSnapshot> {
    const active = await this.getActive(ref);
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
      activeTools: [...active.activeTools.values()],
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

  async prompt(ref: SessionRef, text: string, clientRequestId: string, images?: ImageAttachment[], behavior?: "steer" | "followUp"): Promise<PromptAccepted | QueuedPromptAccepted> {
    const prompt = text.trim();
    if (prompt === "" && (images === undefined || images.length === 0)) throw new AppError("PROMPT_EMPTY", "Prompt cannot be empty");
    if (prompt.length > MAX_PROMPT_LENGTH) throw new AppError("PROMPT_TOO_LARGE", `Prompt must be at most ${String(MAX_PROMPT_LENGTH)} characters`);
    const attachments = this.validateAttachments(images);
    const active = await this.getActive(ref);
    const requestKey = `prompt:${clientRequestId}`;
    const previous = active.requestRuns.get(requestKey);
    if (previous !== undefined) return previous as PromptAccepted | QueuedPromptAccepted;
    const compact = attachments.length === 0 ? this.jarvisCompactCommand(active, prompt) : undefined;
    if (compact !== undefined) {
      const accepted = this.startCompaction(active, compact.customInstructions);
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
    active.updatedAt = run.startedAt;
    active.liveMessages.clear();
    active.liveErrors.clear();
    active.partial = undefined;
    active.partialThinking = undefined;
    active.activeTools.clear();
    active.extensionFailure = undefined;
    active.pendingRunError = undefined;
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
  private async enqueuePrompt(active: ActiveSession, kind: "steer" | "followUp", text: string, images: ImageAttachment[]): Promise<void> {
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
    const queue = active.queue;
    const match = [...queue.steering, ...queue.followUp].find((item) => item.id === messageId);
    if (match === undefined || match.kind === kind) return match;
    const { steering, followUp } = active.session.clearQueue();
    active.queueSyncSuspended = true;
    try {
      for (const [index, text] of steering.entries()) {
        if (match.kind === "steer" && match.text === text && queue.steering[index]?.id === match.id) continue;
        await active.session.steer(text);
      }
      for (const [index, text] of followUp.entries()) {
        if (match.kind === "followUp" && match.text === text && queue.followUp[index]?.id === match.id) continue;
        await active.session.followUp(text);
      }
      // 目标消息以新 kind 入队：steering 队列先于 followUp 投递，
      // 所以从“后续”切到“插队”会插到所有后续消息之前。
      if (kind === "steer") await active.session.steer(match.text);
      else await active.session.followUp(match.text);
    } finally {
      active.queueSyncSuspended = false;
      this.syncQueue(active);
    }
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
    const queue = active.queue;
    const match = [...queue.steering, ...queue.followUp].find((item) => item.id === messageId);
    if (match === undefined) return undefined;
    // Pi 只提供全量 clearQueue；取出后把其余消息按原顺序重新入队。
    // 重入期间 Pi 会同步 emit queue_update，先挂起镜像同步避免中间态闪烁。
    const { steering, followUp } = active.session.clearQueue();
    active.queueSyncSuspended = true;
    try {
      for (const [index, text] of steering.entries()) {
        if (match.kind === "steer" && match.text === text && queue.steering[index]?.id === match.id) continue;
        await active.session.steer(text);
      }
      for (const [index, text] of followUp.entries()) {
        if (match.kind === "followUp" && match.text === text && queue.followUp[index]?.id === match.id) continue;
        await active.session.followUp(text);
      }
    } finally {
      active.queueSyncSuspended = false;
      this.syncQueue(active);
    }
    return match;
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
    active.updatedAt = run.startedAt;
    active.liveMessages.clear();
    active.liveErrors.clear();
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

  private validateAttachments(images: ImageAttachment[] | undefined): ImageAttachment[] {
    const attachments = images ?? [];
    if (attachments.length > MAX_ATTACHMENTS) throw new AppError("ATTACHMENTS_TOO_MANY", `A message can include at most ${String(MAX_ATTACHMENTS)} images`);
    for (const image of attachments) {
      if (!ALLOWED_IMAGE_TYPES.has(image.mimeType)) {
        throw new AppError("ATTACHMENT_TYPE_UNSUPPORTED", `Image type ${image.mimeType} is not supported`);
      }
      if (typeof image.data !== "string" || image.data === "" || image.data.length > MAX_ATTACHMENT_DATA_LENGTH) {
        throw new AppError("ATTACHMENT_TOO_LARGE", "One of the attached images is too large");
      }
    }
    return attachments;
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
      return { aborted: true, ...(dequeued.steering.length > 0 || dequeued.followUp.length > 0 ? { dequeued } : {}) };
    }
    if (activeRun?.kind === "bash") {
      // executeBashRun 会在命令结束时自行 settle。
      active.session.abortBash();
      return { aborted: true, ...(dequeued.steering.length > 0 || dequeued.followUp.length > 0 ? { dequeued } : {}) };
    }

    try {
      await active.session.abort();
      if (activeRun !== undefined && active.state.activeRun?.id === activeRun.id) this.settleRun(active, activeRun.id);
      return { aborted: true, ...(dequeued.steering.length > 0 || dequeued.followUp.length > 0 ? { dequeued } : {}) };
    } catch (error) {
      this.failRun(active, active.state.activeRun?.id, "PI_RUNTIME_ERROR", asMessage(error));
      throw error;
    }
  }

  async resolveExtensionUi(ref: SessionRef, id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> {
    const active = await this.getActive(ref);
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
    const sessions = [...this.active.values()].filter((active) => active.ref.workspaceId === workspaceId);
    for (const active of sessions) {
      this.clearSettlementTimer(active);
      active.unsubscribe();
      active.extensionUi.closeAll();
      active.session.abortCompaction();
      active.session.abortRetry();
      active.session.abortBash();
      await active.session.abort().catch(() => undefined);
      active.session.dispose();
      this.active.delete(activeKey(active.ref));
    }
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) {
      this.clearSettlementTimer(active);
      active.unsubscribe();
      active.extensionUi.closeAll();
      active.session.abortCompaction();
      active.session.abortRetry();
      active.session.abortBash();
      await active.session.abort().catch(() => undefined);
      active.session.dispose();
    }
    this.active.clear();
    this.pendingOpens.clear();
    this.deleting.clear();
  }

  private async executePrompt(active: ActiveSession, prompt: string, runId: string, images: ImageAttachment[] = []): Promise<void> {
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

  private async getActive(ref: SessionRef): Promise<ActiveSession> {
    const key = activeKey(ref);
    if (this.deleting.has(key)) throw new AppError("SESSION_BUSY", "This session is being deleted", 409);
    const existing = this.active.get(key);
    if (existing !== undefined) return existing;
    const pending = this.pendingOpens.get(key);
    if (pending !== undefined) return pending;
    const promise = this.openActive(ref);
    this.pendingOpens.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.pendingOpens.get(key) === promise) this.pendingOpens.delete(key);
    }
  }

  private async openActive(ref: SessionRef): Promise<ActiveSession> {
    const workspace = this.workspaces.get(ref.workspaceId);
    const sessionDir = sessionDirectoryFor(workspace.cwd, getAgentDir());
    const sessions = sessionDir === undefined
      ? await SessionManager.list(workspace.cwd)
      : await SessionManager.list(workspace.cwd, sessionDir);
    const match = sessions.find((entry) => entry.id === ref.sessionId);
    if (match === undefined) throw new AppError("SESSION_NOT_FOUND", "Session not found", 404);
    const manager = sessionDir === undefined ? SessionManager.open(match.path) : SessionManager.open(match.path, sessionDir);
    return this.createActive(ref, workspace, manager);
  }

  private async createActive(ref: SessionRef, workspace: Workspace, manager: SessionManager): Promise<ActiveSession> {
    const agentDir = getAgentDir();
    const modelRuntime = await this.getModelRuntime(agentDir);
    const settingsManager = SettingsManager.create(workspace.cwd, agentDir);
    const enabledModels = settingsManager.getEnabledModels();
    const { scopedModels, diagnostics } = enabledModels !== undefined && enabledModels.length > 0
      ? await resolveModelScopeWithDiagnostics(enabledModels, modelRuntime)
      : { scopedModels: [], diagnostics: [] };
    for (const diagnostic of diagnostics) console.warn(`Model scope warning: ${diagnostic.message}`);

    const { session } = await createAgentSession({
      cwd: workspace.cwd,
      agentDir,
      modelRuntime,
      sessionManager: manager,
      settingsManager,
      ...(scopedModels.length === 0 ? {} : { scopedModels }),
    });
    const publishExtensionUi = (message: ExtensionUiMessage) => {
      // `bindExtensions` runs only after `active` is registered below, so startup
      // dialogs never disappear or deadlock.
      if (message.type === "request") {
        this.events.publishSession(active.ref, { type: "extension.uiRequest", payload: { request: message.request } });
      } else {
        this.events.publishSession(active.ref, {
          type: "extension.uiSettled",
          payload: { id: message.id, outcome: message.outcome, ...(message.value === undefined ? {} : { value: message.value }), ...(message.confirmed === undefined ? {} : { confirmed: message.confirmed }) },
        });
      }
    };
    const extensionUi = new ExtensionUiBridge(publishExtensionUi);
    const actualRef: SessionRef = { workspaceId: workspace.id, sessionId: session.sessionId };
    const now = new Date().toISOString();
    const headerTimestamp = manager.getHeader()?.timestamp;
    const createdAt = typeof headerTimestamp === "string" && Number.isFinite(Date.parse(headerTimestamp)) ? new Date(headerTimestamp).toISOString() : now;
    const active: ActiveSession = {
      ref: actualRef,
      cwd: workspace.cwd,
      session,
      modelRuntime,
      modelSwitching: false,
      extensionUi,
      unsubscribe: () => undefined,
      state: { sessionId: session.sessionId, runState: "idle" },
      requestRuns: new Map(),
      liveMessages: new Map(),
      liveErrors: new Map(),
      activeTools: new Map(),
      activeBash: undefined,
      queue: emptySessionQueue,
      queueSyncSuspended: false,
      compactionAbortRequested: false,
      pendingRunError: undefined,
      settlementTimer: undefined,
      compactionHandoff: false,
      createdAt,
      updatedAt: await sessionModifiedAt(session.sessionFile, now),
    };
    active.unsubscribe = session.subscribe((event) => this.handlePiEvent(active, event));
    this.active.set(activeKey(actualRef), active);
    const onExtensionError = (error: ExtensionError) => {
      console.warn("Pi extension error", error);
      if (!isUnsupportedExtensionInteraction(error)) return;
      active.extensionFailure = { code: UNSUPPORTED_EXTENSION_INTERACTION, message: error.error };
    };
    void session.bindExtensions({ mode: "rpc", uiContext: extensionUi.context, onError: onExtensionError }).catch((error: unknown) => {
      console.warn("Pi extension binding failed", error);
    });
    return active;
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

  private handlePiEvent(active: ActiveSession, event: AgentSessionEvent): void {
    active.updatedAt = new Date().toISOString();
    switch (event.type) {
      case "agent_start": {
        // Extensions can start a continuation without passing through Jarvis's
        // HTTP prompt endpoint. Pi is authoritative for that lifecycle.
        this.clearSettlementTimer(active);
        if (active.state.runState !== "idle") return;
        const run: ActiveRun = { id: randomUUID(), startedAt: new Date().toISOString(), kind: "llm" };
        active.state = { sessionId: active.ref.sessionId, runState: "running", activeRun: run };
        active.liveMessages.clear();
        active.liveErrors.clear();
        active.partial = undefined;
        active.partialThinking = undefined;
        active.activeTools.clear();
        active.extensionFailure = undefined;
        active.pendingRunError = undefined;
        this.events.publishSession(active.ref, { type: "run.started", runId: run.id, payload: { status: active.state } });
        this.publishSummary(active);
        return;
      }
      case "message_update": {
        if (event.assistantMessageEvent.type === "thinking_delta") {
          const runId = active.state.activeRun?.id;
          if (runId === undefined) return;
          const identity = messageFromPi(event.message, "assistant", "");
          const thinkingId = `${identity.id}:thinking`;
          active.partialThinking ??= {
            kind: "thinking",
            id: thinkingId,
            createdAt: identity.createdAt,
            state: "running",
            text: "",
          };
          active.partialThinking.text += event.assistantMessageEvent.delta;
          this.events.publishSession(active.ref, { type: "thinking.delta", runId, payload: { thinkingId, createdAt: active.partialThinking.createdAt, delta: event.assistantMessageEvent.delta } });
          return;
        }
        if (event.assistantMessageEvent.type !== "text_delta") return;
        const runId = active.state.activeRun?.id;
        if (runId === undefined) return;
        const identity = messageFromPi(event.message, "assistant", "");
        const partial = active.partial ?? {
          kind: "message" as const,
          id: identity.id,
          role: "assistant" as const,
          createdAt: identity.createdAt,
          text: "",
        };
        partial.text += event.assistantMessageEvent.delta;
        active.partial = partial;
        this.events.publishSession(active.ref, { type: "assistant.delta", runId, payload: { messageId: partial.id, delta: event.assistantMessageEvent.delta } });
        return;
      }
      case "message_end": {
        const runId = active.state.activeRun?.id;
        if (runId === undefined) return;
        if (isUserMessage(event.message)) {
          const { text, images } = userContentFromContent(event.message.content);
          if (text === "" && images.length === 0) return;
          const message = {
            ...messageFromPi(event.message, "user", text),
            ...(images.length === 0 ? {} : { images }),
          };
          active.liveMessages.set(message.id, message);
          this.events.publishSession(active.ref, { type: "message.created", runId, payload: { message } });
          // Pi emits message_end before it persists the message. Publish the
          // first prompt immediately with an explicit preview so the browser
          // does not have to wait for the whole agent run to settle before
          // replacing the "新会话" fallback title.
          if (firstUserMessage(active.session.sessionManager.getBranch()) === null && text !== "") {
            this.publishSummary(active, this.summaryFromActive(active, text));
          }
          return;
        }
        if (!isAssistantMessage(event.message)) return;
        const identity = messageFromPi(event.message, "assistant", "", active.partial?.createdAt);
        // 思考块定稿：以最终 content 里的 thinking 部分为准（流式期间部分 provider
        // 只在 message_end 才返回思考内容），兜底用流式累积的文本。
        const thinkingText = thinkingTextFromContent(event.message.content);
        if (active.partialThinking !== undefined || thinkingText !== "") {
          const thinking: ThinkingTimelineItem = {
            kind: "thinking",
            id: `${identity.id}:thinking`,
            createdAt: active.partialThinking?.createdAt ?? identity.createdAt,
            state: "completed",
            text: thinkingText !== "" ? thinkingText : (active.partialThinking?.text ?? ""),
          };
          active.partialThinking = undefined;
          this.events.publishSession(active.ref, { type: "thinking.completed", runId, payload: { thinkingId: thinking.id, createdAt: thinking.createdAt, text: thinking.text } });
        }
        const text = assistantTextFromContent(event.message.content);
        const completed = text === ""
          ? undefined
          : messageFromPi(event.message, "assistant", text, active.partial?.createdAt);
        if (completed !== undefined) {
          const message = active.partial === undefined ? completed : { ...completed, id: active.partial.id, createdAt: active.partial.createdAt };
          active.liveMessages.set(message.id, message);
          active.partial = undefined;
          this.events.publishSession(active.ref, { type: "assistant.completed", runId, payload: { message } });
        }
        // Assistant usage is the source for Pi's context estimate; refresh it.
        this.publishContextUsage(active, runId);
        if (stringValue(event.message["stopReason"]) === "error") {
          // Pi may auto-retry or compact after a failed message. Retain a
          // structured attempt now; auto_retry_start upgrades it to retrying.
          for (const previous of active.liveErrors.values()) {
            if (previous.state !== "retrying") continue;
            const settled = { ...previous, state: "failed" as const };
            active.liveErrors.set(settled.id, settled);
            this.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item: settled } });
          }
          const error = { ...errorFromPi(event.message, identity.createdAt, identity.id), groupId: runId };
          active.liveErrors.set(error.id, error);
          this.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item: error } });
          active.pendingRunError = { code: error.code, message: error.message };
        } else if (stringValue(event.message["stopReason"]) !== "aborted") {
          // A successful continuation recovers all earlier attempts in this run.
          for (const error of active.liveErrors.values()) {
            if (error.state === "recovered") continue;
            const recovered = { ...error, state: "recovered" as const };
            active.liveErrors.set(recovered.id, recovered);
            this.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item: recovered } });
          }
          active.pendingRunError = undefined;
        }
        return;
      }
      case "tool_execution_start": {
        const tool = toolFromCall(
          event.toolCallId,
          event.toolName,
          event.args,
          new Date().toISOString(),
          "running",
          event.toolName === "bash" ? { cwd: active.cwd } : undefined,
        );
        active.activeTools.set(tool.id, tool);
        this.events.publishSession(active.ref, { type: "tool.upsert", runId: active.state.activeRun?.id, payload: { tool } });
        return;
      }
      case "tool_execution_update": {
        const previous = active.activeTools.get(event.toolCallId) ?? toolFromCall(event.toolCallId, event.toolName, event.args);
        const tool = toolWithPartial(previous, event.partialResult);
        active.activeTools.set(tool.id, tool);
        this.events.publishSession(active.ref, { type: "tool.upsert", runId: active.state.activeRun?.id, payload: { tool } });
        return;
      }
      case "tool_execution_end": {
        const previous = active.activeTools.get(event.toolCallId) ?? toolFromCall(event.toolCallId, event.toolName, undefined, new Date().toISOString(), "running", event.toolName === "bash" ? { cwd: active.cwd } : undefined);
        const startedAt = Date.parse(previous.createdAt);
        const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined;
        const tool = toolWithResult(previous, event.result, event.isError, durationMs);
        active.activeTools.set(tool.id, tool);
        this.events.publishSession(active.ref, { type: "tool.upsert", runId: active.state.activeRun?.id, payload: { tool } });
        return;
      }
      case "compaction_start": {
        // Extension ctx.compact() resumes immediately after the agent_settled
        // event. It owns the run that would otherwise settle on this timer.
        if (active.settlementTimer !== undefined) {
          this.clearSettlementTimer(active);
          active.compactionHandoff = true;
        }
        const startedAt = active.state.compacting?.reason === event.reason
          ? active.state.compacting.startedAt
          : new Date().toISOString();
        active.state = {
          ...active.state,
          compacting: { reason: event.reason, startedAt },
        };
        if (active.compactionAbortRequested) this.cancelCompaction(active);
        this.events.publishSession(active.ref, {
          type: "run.compactionStarted",
          ...(active.state.activeRun === undefined ? {} : { runId: active.state.activeRun.id }),
          payload: { status: active.state },
        });
        this.publishSummary(active);
        return;
      }
      case "compaction_end": {
        const runId = active.state.activeRun?.id;
        const errorMessage = event.errorMessage;
        const handoff = active.compactionHandoff;
        active.compactionHandoff = false;
        active.compactionAbortRequested = false;
        active.state = { ...active.state, compacting: undefined };
        if (event.result !== undefined) {
          const saved = [...active.session.sessionManager.getBranch()]
            .reverse()
            .find((entry) => entry.type === "compaction" && entry.summary === event.result?.summary);
          const item = contextSummaryFromEntry(saved);
          if (item !== undefined) this.events.publishSession(active.ref, { type: "timeline.upsert", ...(runId === undefined ? {} : { runId }), payload: { item } });
        } else if (!event.aborted && errorMessage !== undefined) {
          if (event.reason === "overflow") {
            // Overflow recovery has no usable answer; the interrupted run fails.
            active.pendingRunError = { code: "PI_COMPACTION_FAILED", message: errorMessage };
          } else if (event.reason === "threshold") {
            // A threshold compaction happens after a valid answer. Preserve it as
            // visible context feedback rather than reclassifying the answer as failed.
            active.state = {
              ...active.state,
              lastError: { code: "PI_COMPACTION_FAILED", message: errorMessage, occurredAt: new Date().toISOString() },
            };
          } else {
            active.pendingRunError = { code: "PI_COMPACTION_FAILED", message: errorMessage };
          }
        }
        this.events.publishSession(active.ref, {
          type: "run.compactionEnded",
          ...(runId === undefined ? {} : { runId }),
          payload: { status: active.state, aborted: event.aborted, ...(errorMessage === undefined ? {} : { errorMessage }), willRetry: event.willRetry },
        });
        // After compaction the usage estimate resets; push the fresh value.
        this.publishContextUsage(active, runId);
        this.publishSummary(active);
        // A plugin continuation is scheduled after its onComplete callback
        // returns. Give it one event turn to start; otherwise settle/fail the
        // original run with the final compaction outcome.
        if (handoff) {
          if (event.aborted) active.pendingRunError = undefined;
          this.deferAgentSettlement(active);
        }
        return;
      }
      case "summarization_retry_scheduled": {
        if (active.state.compacting === undefined) return;
        active.state = {
          ...active.state,
          compacting: {
            ...active.state.compacting,
            retrying: retryStatus(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage),
          },
        };
        this.events.publishSession(active.ref, {
          type: "run.compactionRetrying",
          ...(active.state.activeRun === undefined ? {} : { runId: active.state.activeRun.id }),
          payload: { status: active.state },
        });
        this.publishSummary(active);
        return;
      }
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished": {
        if (active.state.compacting?.retrying === undefined) return;
        active.state = {
          ...active.state,
          compacting: { ...active.state.compacting, retrying: undefined },
        };
        this.events.publishSession(active.ref, {
          type: "run.compactionRetrying",
          ...(active.state.activeRun === undefined ? {} : { runId: active.state.activeRun.id }),
          payload: { status: active.state },
        });
        this.publishSummary(active);
        return;
      }
      case "auto_retry_start": {
        const runId = active.state.activeRun?.id;
        if (runId === undefined) return;
        const retrying = retryStatus(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage);
        active.state = { ...active.state, retrying };
        const latestError = [...active.liveErrors.values()].at(-1);
        if (latestError !== undefined) {
          const item = { ...latestError, state: "retrying" as const, attempt: retrying.attempt, maxAttempts: retrying.maxAttempts, retryAt: retrying.retryAt };
          active.liveErrors.set(item.id, item);
          this.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item } });
        }
        this.events.publishSession(active.ref, { type: "run.retrying", runId, payload: { status: active.state } });
        this.publishSummary(active);
        return;
      }
      case "auto_retry_end": {
        const runId = active.state.activeRun?.id;
        if (runId === undefined) return;
        active.state = { ...active.state, retrying: undefined };
        if (!event.success) {
          const latestError = [...active.liveErrors.values()].at(-1);
          if (latestError?.state === "retrying") {
            const item = { ...latestError, state: "failed" as const };
            active.liveErrors.set(item.id, item);
            this.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item } });
          }
        }
        this.events.publishSession(active.ref, { type: "run.retryEnd", runId, payload: { status: active.state } });
        this.publishSummary(active);
        return;
      }
      case "queue_update":
        if (active.queueSyncSuspended) return;
        this.syncQueue(active);
        return;
      case "agent_settled":
        this.deferAgentSettlement(active);
        return;
      case "thinking_level_changed":
        this.events.publishSession(active.ref, { type: "thinking.changed", payload: { thinking: this.thinkingSnapshot(active) } });
        return;
      case "session_info_changed":
        this.publishSummary(active);
        return;
      default:
        return;
    }
  }

  private settleRun(active: ActiveSession, runId: string | undefined): void {
    if (runId === undefined || active.state.activeRun?.id !== runId) return;
    for (const tool of active.activeTools.values()) {
      if (tool.state !== "queued" && tool.state !== "running") continue;
      const cancelled = { ...tool, state: "cancelled" as const };
      active.activeTools.set(tool.id, cancelled);
      this.events.publishSession(active.ref, { type: "tool.upsert", runId, payload: { tool: cancelled } });
    }
    const lastError = active.state.lastError;
    active.state = {
      sessionId: active.ref.sessionId,
      runState: "idle",
      ...(lastError === undefined ? {} : { lastError }),
    };
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
  }

  private failRun(active: ActiveSession, runId: string | undefined, code: string, message: string): void {
    if (runId === undefined || active.state.activeRun?.id !== runId) return;
    active.state = {
      sessionId: active.ref.sessionId,
      runState: "idle",
      lastError: { code, message, occurredAt: new Date().toISOString() },
    };
    for (const tool of active.activeTools.values()) {
      if (tool.state !== "queued" && tool.state !== "running") continue;
      const cancelled = { ...tool, state: "cancelled" as const };
      active.activeTools.set(tool.id, cancelled);
      this.events.publishSession(active.ref, { type: "tool.upsert", runId, payload: { tool: cancelled } });
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
    active.settlementTimer = setTimeout(() => {
      active.settlementTimer = undefined;
      // 排队消息（steering/follow-up）尚未投递完：保持 running，等 Pi 后续
      // 事件（agent_start 或最终 agent_settled）接管 run 生命周期。
      if (active.state.activeRun === undefined || active.state.compacting !== undefined || active.session.isStreaming || active.queue.steering.length > 0 || active.queue.followUp.length > 0) return;
      if (active.pendingRunError !== undefined) {
        const failure = active.pendingRunError;
        active.pendingRunError = undefined;
        this.failRun(active, active.state.activeRun.id, failure.code, failure.message);
      } else if (active.extensionFailure !== undefined) {
        this.failRun(active, active.state.activeRun.id, active.extensionFailure.code, active.extensionFailure.message);
      } else {
        this.settleRun(active, active.state.activeRun.id);
      }
    }, 0);
  }

  private clearSettlementTimer(active: ActiveSession): void {
    if (active.settlementTimer === undefined) return;
    clearTimeout(active.settlementTimer);
    active.settlementTimer = undefined;
  }

  private publishSummary(active: ActiveSession, supplied?: SessionSummary): void {
    const summary = supplied ?? this.summaryFromActive(active);
    this.events.publishSession(active.ref, { type: "session.updated", payload: { status: active.state, session: summary } });
    this.events.publishWorkspace(active.ref.workspaceId, { version: 1, type: "session.updated", workspaceId: active.ref.workspaceId, session: summary });
  }

  private summaryFromList(workspace: Workspace, entry: { id: string; name?: string; firstMessage: string; created: Date; modified: Date }): SessionSummary {
    const active = this.active.get(activeKey({ workspaceId: workspace.id, sessionId: entry.id }));
    return {
      id: entry.id,
      workspaceId: workspace.id,
      name: entry.name ?? null,
      preview: entry.firstMessage === "" ? null : entry.firstMessage,
      createdAt: entry.created.toISOString(),
      updatedAt: entry.modified.toISOString(),
      runState: active?.state.runState ?? "idle",
    };
  }

  private summaryFromActive(active: ActiveSession, previewOverride?: string): SessionSummary {
    return {
      id: active.ref.sessionId,
      workspaceId: active.ref.workspaceId,
      name: active.session.sessionName ?? null,
      preview: previewOverride ?? firstUserMessage(active.session.sessionManager.getBranch()),
      createdAt: active.createdAt,
      updatedAt: active.updatedAt,
      runState: active.state.runState,
    };
  }
}

function activeKey(ref: SessionRef): string {
  return `${ref.workspaceId}:${ref.sessionId}`;
}

/** Match Pi's environment-over-settings session directory precedence. */
function sessionDirectoryFor(cwd: string, agentDir: string): string | undefined {
  const environmentValue = process.env["PI_CODING_AGENT_SESSION_DIR"];
  if (environmentValue !== undefined && environmentValue.trim() !== "") return resolveConfiguredSessionDir(environmentValue, cwd);

  const globalSettings = readSessionDir(join(agentDir, "settings.json"));
  const projectSettings = readSessionDir(join(cwd, ".pi", "settings.json"));
  const configured = projectSettings ?? globalSettings;
  if (configured === undefined) return undefined;
  const base = projectSettings === undefined ? agentDir : join(cwd, ".pi");
  return resolveConfiguredSessionDir(configured, base);
}

function readSessionDir(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)["sessionDir"];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveConfiguredSessionDir(value: string, baseDir: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

async function sessionModifiedAt(sessionFile: string | undefined, fallback: string): Promise<string> {
  if (sessionFile === undefined) return fallback;
  try {
    return (await stat(sessionFile)).mtime.toISOString();
  } catch {
    return fallback;
  }
}

function retryStatus(attempt: number, maxAttempts: number, delayMs: number, errorMessage: string): RetryStatus {
  return {
    attempt,
    maxAttempts,
    delayMs,
    retryAt: new Date(Date.now() + delayMs).toISOString(),
    errorMessage,
  };
}

function isCompactionCancellation(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return asMessage(error) === "Compaction cancelled";
}

function sameThinkingLevels(left: readonly ThinkingLevel[], right: readonly ThinkingLevel[]): boolean {
  return left.length === right.length && left.every((level, index) => level === right[index]);
}

/** 稳定 id：同一文本重复排队也保持独立条目。 */
function queuedMessage(kind: "steer" | "followUp", text: string): QueuedMessage {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  const createdAt = new Date().toISOString();
  return { id: `${kind}:${hash.toString(36)}:${createdAt}`, kind, text, createdAt };
}

/** 增量合并：按顺序复用已有条目（文本相同）以保持 id 稳定，新增/剩余条目补全新 id。 */
function mergeQueuedMessages(previous: QueuedMessage[], current: readonly string[], kind: "steer" | "followUp"): QueuedMessage[] {
  const result: QueuedMessage[] = [];
  const used = new Set<number>();
  for (const text of current) {
    const matchIndex = previous.findIndex((item, index) => !used.has(index) && item.kind === kind && item.text === text);
    if (matchIndex === -1) {
      result.push(queuedMessage(kind, text));
    } else {
      used.add(matchIndex);
      result.push(previous[matchIndex]!);
    }
  }
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function expandToUserBoundary(items: TimelineItem[], start: number): number {
  if (start === 0 || items[start]?.kind === "message" && items[start].role === "user") return start;
  for (let index = start - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "message" && item.role === "user") return index;
  }
  return 0;
}

function findVisibleMessageEntryId(entries: readonly unknown[], messageId: string): string | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const projected = projectHistory([entry]).find((item): item is MessageTimelineItem => item.kind === "message");
    if (projected?.id === messageId) return stringValue(entry["id"]) || undefined;
  }
  return undefined;
}

function findUserMessageEntry(entries: readonly unknown[], messageId: string): Record<string, unknown> | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message) || message["role"] !== "user") continue;
    const projected = projectHistory([entry]).find((item): item is MessageTimelineItem => item.kind === "message");
    if (projected?.id === messageId) return entry;
  }
  return undefined;
}

function firstUserMessage(entries: readonly unknown[]): string | null {
  const history = projectHistory(entries);
  return history.find((item): item is MessageTimelineItem => item.kind === "message" && item.role === "user")?.text ?? null;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Record<string, unknown>)["code"] === "ENOENT";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function runtimeFailureCode(error: unknown): string {
  return isUnsupportedExtensionInteraction(error) ? UNSUPPORTED_EXTENSION_INTERACTION : "PI_RUNTIME_ERROR";
}

function isOperationCancellation(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = asMessage(error);
  return message === "Operation aborted" || message === "This operation was aborted";
}

function isAssistantMessage(message: unknown): message is { role: "assistant"; content: unknown; timestamp?: number | string } {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)["role"] === "assistant";
}

function isUserMessage(message: unknown): message is { role: "user"; content: unknown; timestamp?: number | string } {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)["role"] === "user";
}
