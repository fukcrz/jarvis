import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import type {
  ComposerCommand,
  MessageTimelineItem,
  ModelDescriptor,
  PromptAccepted,
  SessionRef,
  SessionStatus,
  SessionStreamSnapshot,
  SessionSummary,
  TimelineItem,
  TimelinePage,
  ToolTimelineItem,
  Workspace,
} from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";
import { EventHub } from "./event-hub.js";
import { isUnsupportedExtensionInteraction, UNSUPPORTED_EXTENSION_INTERACTION, unsupportedExtensionUi } from "./extension-ui.js";
import { projectModelSnapshot } from "./model-projection.js";
import { assistantTextFromContent, messageFromPi, projectHistory, textFromContent, toolFromCall, toolWithPartial, toolWithResult } from "./projection.js";
import { WorkspaceStore } from "./workspace-store.js";

interface ActiveRun {
  id: string;
  startedAt: string;
}

interface ActiveSession {
  ref: SessionRef;
  cwd: string;
  session: AgentSession;
  modelRuntime: ModelRuntime;
  modelSwitching: boolean;
  unsubscribe: () => void;
  state: SessionStatus;
  requestRuns: Map<string, PromptAccepted>;
  liveMessages: Map<string, MessageTimelineItem>;
  partial?: MessageTimelineItem;
  activeTools: Map<string, ToolTimelineItem>;
  extensionFailure?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}

const PAGE_LIMIT = 120;
const MAX_PROMPT_LENGTH = 40_000;

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
        active.unsubscribe();
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
    return [
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
  }

  async runtime(ref: SessionRef): Promise<SessionStreamSnapshot> {
    const active = await this.getActive(ref);
    return {
      // Read all fields without an await so this projection and its seq form
      // one join-time snapshot for the client-side watermark algorithm.
      seq: this.events.currentSeq(active.ref),
      status: active.state,
      model: this.modelSnapshot(active),
      liveMessages: [...active.liveMessages.values()],
      ...(active.partial === undefined ? {} : { partial: active.partial }),
      activeTools: [...active.activeTools.values()],
    };
  }

  async setModel(ref: SessionRef, provider: string, modelId: string): Promise<ModelDescriptor> {
    const active = await this.getActive(ref);
    if (active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming) {
      throw new AppError("SESSION_BUSY", "Stop the current run before changing models", 409);
    }

    active.modelSwitching = true;
    try {
      const available = await this.availableModels(active.modelRuntime);
      const model = available.find((candidate) => candidate.provider === provider && candidate.id === modelId);
      if (model === undefined) throw new AppError("MODEL_NOT_AVAILABLE", "This model is not available for the current Pi profile", 404);

      const snapshot = projectModelSnapshot(active.session.model, available);
      if (active.session.model?.provider === provider && active.session.model?.id === modelId) {
        if (snapshot.current === undefined) throw new AppError("MODEL_NOT_AVAILABLE", "Pi did not select the requested model", 409);
        return snapshot.current;
      }

      await active.session.setModel(model);
      active.updatedAt = new Date().toISOString();
      const updated = projectModelSnapshot(active.session.model, available);
      if (updated.current === undefined) throw new AppError("MODEL_NOT_AVAILABLE", "Pi did not select the requested model", 409);
      this.events.publishSession(active.ref, { type: "model.changed", payload: { model: updated } });
      this.publishSummary(active);
      return updated.current;
    } finally {
      active.modelSwitching = false;
    }
  }

  async prompt(ref: SessionRef, text: string, clientRequestId: string): Promise<PromptAccepted> {
    const prompt = text.trim();
    if (prompt === "") throw new AppError("PROMPT_EMPTY", "Prompt cannot be empty");
    if (prompt.length > MAX_PROMPT_LENGTH) throw new AppError("PROMPT_TOO_LARGE", `Prompt must be at most ${String(MAX_PROMPT_LENGTH)} characters`);
    const active = await this.getActive(ref);
    const previous = active.requestRuns.get(clientRequestId);
    if (previous !== undefined) return previous;
    if (active.modelSwitching || active.state.runState !== "idle" || active.session.isStreaming) throw new AppError("SESSION_BUSY", "This session is already running", 409);

    const run: ActiveRun = { id: randomUUID(), startedAt: new Date().toISOString() };
    active.state = { sessionId: ref.sessionId, runState: "running", activeRun: run };
    active.updatedAt = run.startedAt;
    active.liveMessages.clear();
    active.partial = undefined;
    active.activeTools.clear();
    active.extensionFailure = undefined;
    const accepted: PromptAccepted = { accepted: true, runId: run.id };
    active.requestRuns.set(clientRequestId, accepted);
    if (active.requestRuns.size > 48) active.requestRuns.delete(active.requestRuns.keys().next().value as string);

    this.events.publishSession(active.ref, { type: "run.started", runId: run.id, payload: { status: active.state } });
    this.publishSummary(active);
    void this.executePrompt(active, prompt, run.id);
    return accepted;
  }

  async abort(ref: SessionRef, runId?: string): Promise<void> {
    const active = await this.getActive(ref);
    const activeRun = active.state.activeRun;
    if (activeRun === undefined) throw new AppError("RUN_NOT_ACTIVE", "This session does not have an active run", 409);
    if (runId !== undefined && activeRun.id !== runId) throw new AppError("RUN_NOT_ACTIVE", "This run is no longer active", 409);
    active.state = { ...active.state, runState: "stopping" };
    this.events.publishSession(active.ref, { type: "run.stopping", runId: activeRun.id, payload: { status: active.state } });
    this.publishSummary(active);
    try {
      await active.session.abort();
      if (active.state.activeRun?.id === activeRun.id) this.settleRun(active, activeRun.id);
    } catch (error) {
      this.failRun(active, active.state.activeRun?.id, "PI_RUNTIME_ERROR", asMessage(error));
      throw error;
    }
  }

  hasActiveWorkspace(workspaceId: string): boolean {
    return [...this.active.values()].some((active) => active.ref.workspaceId === workspaceId && active.state.runState !== "idle");
  }

  async disposeWorkspace(workspaceId: string): Promise<void> {
    const sessions = [...this.active.values()].filter((active) => active.ref.workspaceId === workspaceId);
    for (const active of sessions) {
      active.unsubscribe();
      await active.session.abort().catch(() => undefined);
      active.session.dispose();
      this.active.delete(activeKey(active.ref));
    }
  }

  async dispose(): Promise<void> {
    for (const active of this.active.values()) {
      active.unsubscribe();
      await active.session.abort().catch(() => undefined);
      active.session.dispose();
    }
    this.active.clear();
    this.pendingOpens.clear();
    this.deleting.clear();
  }

  private async executePrompt(active: ActiveSession, prompt: string, runId: string): Promise<void> {
    try {
      await active.session.prompt(prompt, { source: "rpc" });
      if (active.state.activeRun?.id === runId && active.session.isIdle) this.settleRun(active, runId);
    } catch (error) {
      if (active.state.activeRun?.id === runId) this.failRun(active, runId, runtimeFailureCode(error), asMessage(error));
    }
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
    const { session } = await createAgentSession({
      cwd: workspace.cwd,
      agentDir,
      modelRuntime,
      sessionManager: manager,
    });
    const extensionState: { active?: ActiveSession; startupFailure?: { code: string; message: string } } = {};
    const onExtensionError = (error: ExtensionError) => {
      console.warn("Pi extension error", error);
      if (!isUnsupportedExtensionInteraction(error)) return;
      const failure = { code: UNSUPPORTED_EXTENSION_INTERACTION, message: error.error };
      if (extensionState.active === undefined) extensionState.startupFailure = failure;
      else extensionState.active.extensionFailure = failure;
    };
    try {
      await session.bindExtensions({ mode: "rpc", uiContext: unsupportedExtensionUi, onError: onExtensionError });
    } catch (error) {
      console.warn("Pi extension binding failed", error);
    }

    const actualRef: SessionRef = { workspaceId: workspace.id, sessionId: session.sessionId };
    const now = new Date().toISOString();
    const header = manager.getHeader();
    const headerTimestamp = header?.timestamp;
    const createdAt = typeof headerTimestamp === "string" && Number.isFinite(Date.parse(headerTimestamp))
      ? new Date(headerTimestamp).toISOString()
      : now;
    const updatedAt = await sessionModifiedAt(session.sessionFile, now);
    const active: ActiveSession = {
      ref: actualRef,
      cwd: workspace.cwd,
      session,
      modelRuntime,
      modelSwitching: false,
      unsubscribe: () => undefined,
      state: extensionState.startupFailure === undefined
        ? { sessionId: session.sessionId, runState: "idle" }
        : { sessionId: session.sessionId, runState: "idle", lastError: { ...extensionState.startupFailure, occurredAt: now } },
      requestRuns: new Map(),
      liveMessages: new Map(),
      activeTools: new Map(),
      createdAt,
      updatedAt,
    };
    extensionState.active = active;
    active.unsubscribe = session.subscribe((event) => this.handlePiEvent(active, event));
    this.active.set(activeKey(actualRef), active);
    return active;
  }

  private modelSnapshot(active: ActiveSession) {
    return projectModelSnapshot(active.session.model, active.modelRuntime.getAvailableSnapshot());
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
      case "message_update": {
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
          const text = textFromContent(event.message.content);
          if (text === "") return;
          const message = messageFromPi(event.message, "user", text);
          active.liveMessages.set(message.id, message);
          this.events.publishSession(active.ref, { type: "message.created", runId, payload: { message } });
          return;
        }
        if (!isAssistantMessage(event.message)) return;
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
        if (stringValue(event.message["stopReason"]) === "error") {
          const errorMessage = stringValue(event.message["errorMessage"]) || "The model response failed.";
          this.failRun(active, runId, "PI_RUNTIME_ERROR", errorMessage);
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
      case "agent_settled":
        if (active.extensionFailure !== undefined) {
          this.failRun(active, active.state.activeRun?.id, active.extensionFailure.code, active.extensionFailure.message);
        } else {
          this.settleRun(active, active.state.activeRun?.id);
        }
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
    active.state = { sessionId: active.ref.sessionId, runState: "idle" };
    active.liveMessages.clear();
    active.partial = undefined;
    active.activeTools.clear();
    active.extensionFailure = undefined;
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
    active.partial = undefined;
    active.activeTools.clear();
    active.extensionFailure = undefined;
    this.events.publishSession(active.ref, { type: "run.failed", runId, payload: { status: active.state } });
    this.publishSummary(active);
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

  private summaryFromActive(active: ActiveSession): SessionSummary {
    return {
      id: active.ref.sessionId,
      workspaceId: active.ref.workspaceId,
      name: active.session.sessionName ?? null,
      preview: firstUserMessage(active.session.sessionManager.getBranch()),
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

function runtimeFailureCode(error: unknown): string {
  return isUnsupportedExtensionInteraction(error) ? UNSUPPORTED_EXTENSION_INTERACTION : "PI_RUNTIME_ERROR";
}

function isAssistantMessage(message: unknown): message is { role: "assistant"; content: unknown; timestamp?: number | string } {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)["role"] === "assistant";
}

function isUserMessage(message: unknown): message is { role: "user"; content: unknown; timestamp?: number | string } {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)["role"] === "user";
}
