import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
  type AgentSession,
  type ExtensionError,
  type ModelRuntime,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emptySessionQueue, type SessionAttentionState, type SessionRef, type Workspace } from "../shared/protocol.js";
import type { EventHub } from "./event-hub.js";
import type { BackgroundTaskService } from "./background-task-service.js";
import { ExtensionUiBridge, isUnsupportedExtensionInteraction, UNSUPPORTED_EXTENSION_INTERACTION, type ExtensionUiMessage } from "./extension-ui.js";
import { JARVIS_UI_NOTICE, SIDE_CHAT_NOTICE, SIDE_CHAT_TOOLS, type ActiveSession } from "./session-active.js";
import type { SessionAttentionStore } from "./session-attention-store.js";
import { sessionModifiedAt } from "./session-files.js";
import { activeKey } from "./session-helpers.js";
import type { SessionPiEvents } from "./session-pi-events.js";

export interface CreateActiveDeps {
  attention: SessionAttentionStore;
  events: EventHub;
  active: Map<string, ActiveSession>;
  ownerBoundSessions: WeakSet<AgentSession>;
  piEvents: SessionPiEvents;
  backgroundTasks: BackgroundTaskService;
  getModelRuntime(agentDir: string): Promise<ModelRuntime>;
  setAttention(active: ActiveSession, state: SessionAttentionState): void;
  publishSummary(active: ActiveSession): void;
}

export async function createActiveSession(
  deps: CreateActiveDeps,
  ref: SessionRef,
  workspace: Workspace,
  manager: SessionManager,
  options?: { readOnly?: boolean },
): Promise<ActiveSession> {
  const agentDir = getAgentDir();
  const readOnly = options?.readOnly === true || (ref.sessionId !== "" && await deps.attention.isSideChat(ref));
  const modelRuntime = await deps.getModelRuntime(agentDir);
  const settingsManager = SettingsManager.create(workspace.cwd, agentDir);
  const enabledModels = settingsManager.getEnabledModels();
  const { scopedModels, diagnostics } = enabledModels !== undefined && enabledModels.length > 0
    ? await resolveModelScopeWithDiagnostics(enabledModels, modelRuntime)
    : { scopedModels: [], diagnostics: [] };
  for (const diagnostic of diagnostics) console.warn(`Model scope warning: ${diagnostic.message}`);

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace.cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: readOnly ? [JARVIS_UI_NOTICE, SIDE_CHAT_NOTICE] : [JARVIS_UI_NOTICE],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: workspace.cwd,
    agentDir,
    modelRuntime,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    ...(!readOnly ? { customTools: [backgroundTaskTool(deps.backgroundTasks, workspace.id)] } : {}),
    ...(readOnly ? { tools: [...SIDE_CHAT_TOOLS], excludeTools: ["bash", "edit", "write", "powershell"] } : {}),
    ...(scopedModels.length === 0 ? {} : { scopedModels }),
  });
  bindOwnerSessionId(deps.ownerBoundSessions, session);
  const publishExtensionUi = (message: ExtensionUiMessage) => {
    // Notifications are application-level transient feedback. They use the
    // workspace stream so they are independent of the selected session.
    if (message.type === "request" && message.request.method === "notify") {
      deps.events.publishWorkspace(active.ref.workspaceId, {
        version: 1,
        type: "extension.notify",
        workspaceId: active.ref.workspaceId,
        notification: {
          id: message.request.id,
          message: message.request.message,
          ...(message.request.notifyType === undefined ? {} : { notifyType: message.request.notifyType }),
          sessionId: active.ref.sessionId,
        },
      });
      return;
    }
    // `bindExtensions` runs only after `active` is registered below, so startup
    // dialogs never disappear or deadlock.
    if (message.type === "request") {
      if (message.request.method === "select" || message.request.method === "confirm" || message.request.method === "input" || message.request.method === "editor") {
        deps.setAttention(active, "waiting_interaction");
        deps.publishSummary(active);
      }
      deps.events.publishSession(active.ref, { type: "extension.uiRequest", payload: { request: message.request } });
    } else {
      deps.events.publishSession(active.ref, {
        type: "extension.uiSettled",
        payload: { id: message.id, outcome: message.outcome, ...(message.value === undefined ? {} : { value: message.value }), ...(message.confirmed === undefined ? {} : { confirmed: message.confirmed }) },
      });
      if (!active.extensionUi.hasPendingDialogs) {
        deps.setAttention(active, active.state.runState === "idle" ? "idle" : "running");
        deps.publishSummary(active);
      }
    }
  };
  const extensionUi = new ExtensionUiBridge(publishExtensionUi);
  const actualRef: SessionRef = { workspaceId: workspace.id, sessionId: session.sessionId };
  const now = new Date().toISOString();
  const headerTimestamp = manager.getHeader()?.timestamp;
  const createdAt = typeof headerTimestamp === "string" && Number.isFinite(Date.parse(headerTimestamp)) ? new Date(headerTimestamp).toISOString() : now;
  const sortMeta = await deps.attention.get(actualRef);
  const active: ActiveSession = {
    ref: actualRef,
    cwd: workspace.cwd,
    session,
    modelRuntime,
    modelSwitching: false,
    extensionUi,
    extensionReady: Promise.resolve(),
    unsubscribe: () => undefined,
    state: { sessionId: session.sessionId, runState: "idle" },
    attentionState: sortMeta.attentionState,
    ...(sortMeta.attentionAt === undefined ? {} : { attentionAt: sortMeta.attentionAt }),
    ...(sortMeta.lastUserMessageAt === undefined ? {} : { lastUserMessageAt: sortMeta.lastUserMessageAt }),
    ...(sortMeta.starred === true ? { starred: true } : {}),
    requestRuns: new Map(),
    liveMessages: new Map(),
    liveErrors: new Map(),
    assistantStreamId: undefined,
    activeTools: new Map(),
    activeBash: undefined,
    queue: emptySessionQueue,
    queueSyncSuspended: false,
    compactionAbortRequested: false,
    pendingRunError: undefined,
    settlementTimer: undefined,
    compactionHandoff: false,
    ...(readOnly ? { readOnly: true } : {}),
    createdAt,
    updatedAt: await sessionModifiedAt(session.sessionFile, now),
  };
  active.unsubscribe = session.subscribe((event) => deps.piEvents.handle(active, event));
  deps.active.set(activeKey(actualRef), active);
  const onExtensionError = (error: ExtensionError) => {
    console.warn("Pi extension error", error);
    if (!isUnsupportedExtensionInteraction(error)) return;
    active.extensionFailure = { code: UNSUPPORTED_EXTENSION_INTERACTION, message: error.error };
  };
  // Register before binding so startup UI/events have a live ActiveSession,
  // but make all callers await extensionReady before using this session.
  active.extensionReady = session.bindExtensions({ mode: "rpc", uiContext: extensionUi.context, onError: onExtensionError }).then(() => {
    if (readOnly) session.setActiveToolsByName([...SIDE_CHAT_TOOLS]);
  }).catch((error: unknown) => {
    console.warn("Pi extension binding failed", error);
  });
  return active;
}

const backgroundTaskParameters = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("log"), Type.Literal("stop"), Type.Literal("restart")]),
  command: Type.Optional(Type.String({ description: "Command to start. Required for start." })),
  cwd: Type.Optional(Type.String({ description: "Working directory within the workspace. Defaults to its root." })),
  taskId: Type.Optional(Type.String({ description: "Task ID. Required for log, stop and restart." })),
});

function backgroundTaskTool(tasks: BackgroundTaskService, workspaceId: string): ToolDefinition<typeof backgroundTaskParameters> {
  return {
    name: "background_task",
    label: "Background task",
    description: "Manage long-running workspace commands. Use start for dev servers instead of a blocking bash command; list, log, stop or restart by task ID. Tasks stop when Jarvis exits.",
    promptSnippet: "Start and manage long-running workspace commands with logs and explicit stop/restart",
    parameters: backgroundTaskParameters,
    async execute(_toolCallId, { action, command, cwd, taskId }) {
      let result: unknown;
      if (action === "start") {
        if (!command?.trim()) throw new Error("start requires command");
        result = await tasks.start(workspaceId, command, cwd);
      } else if (action === "list") {
        result = tasks.list(workspaceId);
      } else {
        if (!taskId) throw new Error(`${action} requires taskId`);
        result = action === "log" ? await tasks.logs(workspaceId, taskId)
          : action === "stop" ? await tasks.stop(workspaceId, taskId)
            : await tasks.restart(workspaceId, taskId);
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: undefined };
    },
  };
}

/**
 * Keep every provider request tied to this AgentSession. Pi's compaction
 * intentionally substitutes a random sessionId for isolated summary requests,
 * so model-group routing needs a separate stable owner identifier.
 */
export function bindOwnerSessionId(ownerBoundSessions: WeakSet<AgentSession>, session: AgentSession): void {
  if (ownerBoundSessions.has(session)) return;
  ownerBoundSessions.add(session);
  const ownerSessionId = session.sessionId;
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => stream(model, context, {
    ...options,
    ownerSessionId,
  });
}
