import {
  CAPABILITY_PROBE_CHANNEL,
  respondDiagnosticCapability,
  diagnosticAgentText,
} from "./orch/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { buildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { ConfigStore } from "./prefs/config.ts";
import {
  IMPORT_REQUEST_PREFIX,
  markImportOffered,
  offerAgentImport,
} from "./prefs/agent-import.ts";
import { ThreadManager } from "./orch/manager.ts";
import { loadManagerSettings } from "./prefs/settings.ts";
import { configureAgents } from "./ui/settings-ui.ts";
import { AgentNavigationController } from "./ui/status-ui.ts";
import { AgentNavigationEditor } from "./ui/agent-navigation-editor.ts";
import { createDriverFactory } from "./orch/runtime.ts";
import {
  createHousekeepingCompleter,
  HousekeepingSummarizer,
  resolveHousekeepingModel,
} from "./orch/housekeeping.ts";
import { createInheritedToolSource } from "./orch/inherited-tools.ts";
import { subagentPrompt } from "./orch/prompt.ts";
import { ChecklistMetaMirror, checklistStatus } from "./orch/checklist-integration.ts";
import { agentTools } from "./orch/tools.ts";
import { editAgentTypes, updateWidget } from "./ui/ui.ts";
import { canOpenDialog, dialogMenu } from "./ui/dialog.ts";
import type { SubagentStreamItem, ThreadEvent, ThreadView } from "./types.ts";
import { COST_ENTRY, CostLedger } from "./orch/cost-ledger.ts";
import { readRegistry, RegistryWriter } from "./orch/registry.ts";
import { CostFooterController } from "./ui/cost-footer.ts";

const ROOT_MAILBOX_ENTRY = "pi-subagent:root-mailbox:v1";
const ROOT_SUMMARY_MESSAGE = "pi-subagent:final-recap";
const ROOT_WAKE_MESSAGE = "pi-subagent:wake";
const LIVE_UPDATE_CHANNEL = "pi-subagent:live:v1";
const LIVE_UPDATE_THROTTLE_MS = 150;
/** 子会话实时输出片段：与快照通道并行，自己合批，不参与持久化。 */
const STREAM_CHANNEL = "pi-subagent:stream:v1";
const STREAM_THROTTLE_MS = 200;
type RootNotification = {
  rootSessionId: string;
  content: string;
  finalRecap?: boolean;
  /** Start a main-agent turn so it reacts to this event (async completion, spawn timeout). */
  trigger?: boolean;
  details: { mailboxId: string; path: string; state: string };
};

export default function piSubagent(pi: ExtensionAPI): void {
  let capabilityActive = true;
  pi.events.on(CAPABILITY_PROBE_CHANNEL, (payload) => {
    if (capabilityActive && limits.subagentMode !== "off") respondDiagnosticCapability(payload);
  });
  let context: ExtensionContext | undefined;
  const inheritedTools = createInheritedToolSource(pi);
  let store = new ConfigStore({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    includeProject: false,
  });
  let manager: ThreadManager | undefined;
  let costLedger = new CostLedger();
  const costFooter = new CostFooterController(
    pi,
    () => costLedger.totalUsd,
    () => limits.nerdFontIcons,
    () => limits.costDisplay,
    () => limits.costValue,
    () => limits.costIcon,
  );
  const refreshCostFooter = (ctx: ExtensionContext) => costFooter.refresh(ctx);
  const rollupCost = (thread: ThreadView) => {
    costLedger.settle(thread, (record) => pi.appendEntry(COST_ENTRY, record));
    if (context) refreshCostFooter(context);
  };
  let limits = loadManagerSettings({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    includeProject: false,
  }).settings;
  // [labs] Housekeeping: inert unless opted in, a model is chosen, and it resolves with credentials.
  const housekeeping = new HousekeepingSummarizer({
    isEnabled: () =>
      limits.subagentMode !== "off" &&
      limits.housekeepingEnabled &&
      limits.housekeepingModel !== "" &&
      context !== undefined &&
      resolveHousekeepingModel(context, limits.housekeepingModel) !== undefined,
    complete: createHousekeepingCompleter(
      () => context,
      () => limits.housekeepingModel,
      refreshCostFooter,
    ),
    apply: (path, run, summary) => manager?.setSummary(path, run, summary) ?? false,
    clear: (path, run) => void manager?.clearSummary(path, run),
    onFailure: (message) =>
      context?.ui.notify(
        `Housekeeping summaries failed (${message}); showing normal agent status instead.`,
        "warning",
      ),
  });
  let housekeepingKey = "";
  /** Settings changed: drop in-flight work and stale summaries so the new choice starts clean. */
  const syncHousekeeping = () => {
    const key = `${limits.subagentMode === "off"}|${limits.housekeepingEnabled}|${limits.housekeepingModel}`;
    if (key === housekeepingKey) return;
    housekeepingKey = key;
    housekeeping.cancelAll();
    manager?.clearSummaries();
  };
  const loadLimits = (ctx: ExtensionContext) => {
    const loaded = loadManagerSettings({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      includeProject: ctx.isProjectTrusted(),
    });
    limits = loaded.settings;
    syncHousekeeping();
    refreshCostFooter(ctx);
    return loaded.diagnostics;
  };
  const checklistMirror = new ChecklistMetaMirror(() => getAgentDir());
  const currentChecklistStatus = (ctx: ExtensionContext) =>
    checklistStatus(pi, checklistMirror, ctx);
  let generation = 0;
  let rootTurnEnded = false;
  const hiddenWidgetThreads = new Set<string>();
  let widgetCollapsed = false;
  let rootTurnRunning = false;
  let suspendingSummaries = false;
  // One arbiter owns both timeout wakes and completion/continuation turns.
  let rootTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeRequested = false;
  const liveUpdateAt = new Map<string, number>();
  const liveUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const liveUpdatePending = new Map<string, ThreadView>();
  const publishLiveUpdate = (thread: ThreadView, immediate = false) => {
    if (limits.subagentMode === "off") return;
    const path = thread.path;
    liveUpdatePending.set(path, thread);
    const emit = () => {
      const latest = liveUpdatePending.get(path);
      liveUpdatePending.delete(path);
      liveUpdateTimers.delete(path);
      if (latest === undefined) return;
      liveUpdateAt.set(path, Date.now());
      try {
        // Runtime-only: streaming metrics must not grow the root JSONL.
        pi.events.emit(LIVE_UPDATE_CHANNEL, { version: 1, thread: latest });
      } catch (error) {
        warnDelivery(error);
      }
    };
    const previous = liveUpdateAt.get(path) ?? 0;
    const delay = immediate ? 0 : LIVE_UPDATE_THROTTLE_MS - (Date.now() - previous);
    if (delay <= 0) {
      const timer = liveUpdateTimers.get(path);
      if (timer !== undefined) clearTimeout(timer);
      emit();
      return;
    }
    if (!liveUpdateTimers.has(path)) liveUpdateTimers.set(path, setTimeout(emit, delay));
  };
  const clearLiveUpdates = () => {
    for (const timer of liveUpdateTimers.values()) clearTimeout(timer);
    liveUpdateTimers.clear();
    liveUpdatePending.clear();
    liveUpdateAt.clear();
  };
  // 每线程一个待发缓冲：同一 id 的多次增量只留最后一版，200ms 一批。
  const streamPending = new Map<string, Map<string, SubagentStreamItem>>();
  const streamTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const flushStream = (path: string) => {
    const timer = streamTimers.get(path);
    if (timer !== undefined) clearTimeout(timer);
    streamTimers.delete(path);
    const batch = streamPending.get(path);
    streamPending.delete(path);
    if (batch === undefined || batch.size === 0 || limits.subagentMode === "off") return;
    try {
      // Runtime-only: 子会话过程不进根会话 JSONL。
      pi.events.emit(STREAM_CHANNEL, { version: 1, path, items: [...batch.values()] });
    } catch (error) {
      warnDelivery(error);
    }
  };
  const queueStream = (path: string, items: readonly SubagentStreamItem[], immediate = false) => {
    if (limits.subagentMode === "off") return;
    let batch = streamPending.get(path);
    if (batch === undefined) {
      batch = new Map();
      streamPending.set(path, batch);
    }
    for (const item of items) batch.set(item.id, item);
    if (immediate) {
      flushStream(path);
      return;
    }
    if (streamTimers.has(path)) return;
    streamTimers.set(path, setTimeout(() => flushStream(path), STREAM_THROTTLE_MS));
  };
  const clearStreams = () => {
    for (const timer of streamTimers.values()) clearTimeout(timer);
    streamTimers.clear();
    streamPending.clear();
  };
  const cancelSummary = () => {
    if (rootTurnTimer !== undefined) clearTimeout(rootTurnTimer);
    rootTurnTimer = undefined;
    wakeRequested = false;
    rootTurnRunning = false;
  };
  // Right at a tree leaf steps tree → full: leave any session collapse behind.
  const returnToWidget = () => {
    if (!widgetCollapsed) return;
    widgetCollapsed = false;
    if (context) refreshWidget(context);
  };
  let navigation = new AgentNavigationController(returnToWidget);
  let navigationEditor: AgentNavigationEditor | undefined;
  let navigationEditorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  let navigationGeneration = 0;
  const closeNavigation = (disposeEditor = false) => {
    navigationGeneration++;
    navigation.close();
    if (disposeEditor) {
      navigationEditor?.dispose();
      navigationEditor = undefined;
    }
  };
  const installNavigationEditor = (ctx: ExtensionContext, seedHistory: boolean) => {
    // Pi has one custom-editor slot: do not replace another integration.
    if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui.setEditorComponent) return;
    const existingFactory = ctx.ui.getEditorComponent?.();
    if (existingFactory && existingFactory !== navigationEditorFactory) return;
    // The host only transfers raw text, not cursor/undo/expanded-paste state.
    if (ctx.ui.getEditorText?.()) return;
    const history = buildSessionContext(ctx.sessionManager.getBranch()).messages.flatMap(
      (message) => {
        if (message.role !== "user") return [];
        const content = message.content;
        return [
          typeof content === "string"
            ? content
            : content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
        ];
      },
    );
    navigationEditorFactory = (tui, theme, keys) => {
      const editor = new AgentNavigationEditor(tui, theme, keys, {
        // Initial startup hydrates after session_start; replacement editors do not.
        initialHistory: seedHistory ? history : undefined,
        generation: () => navigationGeneration,
        canOpen: () =>
          manager !== undefined &&
          context?.mode === "tui" &&
          limits.subagentMode !== "off" &&
          !navigation.isOpen &&
          manager
            .list()
            .some(
              (thread) =>
                thread.path !== "/root" &&
                (thread.state === "starting" || thread.state === "running"),
            ),
        openTree: () =>
          manager && context
            ? navigation.open(
                context,
                manager.scope("/root"),
                undefined,
                limits.nerdFontIcons,
                limits.loaderStyle,
              )
            : undefined,
        canCollapse: () =>
          manager !== undefined &&
          context?.mode === "tui" &&
          limits.subagentMode !== "off" &&
          !navigation.isOpen &&
          !widgetCollapsed &&
          limits.widgetMode === "full" &&
          widgetThreads().some((thread) => thread.path !== "/root"),
        collapseWidget: () => {
          widgetCollapsed = true;
          if (context) refreshWidget(context);
        },
        // Left from the session-collapsed one-liner returns to full before the tree.
        canExpand: () =>
          manager !== undefined &&
          context?.mode === "tui" &&
          limits.subagentMode !== "off" &&
          !navigation.isOpen &&
          widgetCollapsed &&
          limits.widgetMode === "full" &&
          widgetThreads().some((thread) => thread.path !== "/root"),
        expandWidget: () => {
          widgetCollapsed = false;
          if (context) refreshWidget(context);
        },
        onError: (error) =>
          context?.ui.notify(error instanceof Error ? error.message : String(error), "error"),
      });
      navigationEditor = editor;
      return editor;
    };
    ctx.ui.setEditorComponent(navigationEditorFactory);
  };
  const registryWriter = new RegistryWriter((customType, data) => pi.appendEntry(customType, data));
  let migrationRequested = false;
  let importInProgress = false;
  const importAgents = async (ctx: ExtensionContext, firstRun: boolean) => {
    // Migration requires the root's file tools and must not delegate source prompts.
    if (limits.subagentMode === "orchestration") {
      if (!firstRun)
        ctx.ui.notify(
          "Agent import requires Opportunistic mode. Change Subagent Mode in /agents settings.",
          "info",
        );
      return;
    }
    if (importInProgress) return;
    importInProgress = true;
    try {
      migrationRequested =
        (await offerAgentImport(pi, ctx, {
          agentDir: getAgentDir(),
          store,
          firstRun,
        })) || migrationRequested;
    } finally {
      importInProgress = false;
    }
  };
  const requireManager = () => {
    if (!manager) throw new Error("Subagent threads are not initialized; start a Pi session first");
    return manager;
  };
  const widgetThreads = () =>
    requireManager()
      .list()
      .filter((thread) => {
        // Resuming a retained session makes it visible for this task, even after it settles again.
        if (thread.state === "starting" || thread.state === "running")
          hiddenWidgetThreads.delete(thread.path);
        return !hiddenWidgetThreads.has(thread.path);
      });
  const requireContext = () => {
    if (!context) throw new Error("No active Pi session");
    return context;
  };
  const persist = () => {
    if (!manager) return;
    registryWriter.write(requireContext().sessionManager.getSessionId(), manager.saved());
  };
  const warnDelivery = (error: unknown) => {
    if (limits.subagentMode === "off") return;
    const message = error instanceof Error ? error.message : String(error);
    context?.ui.notify(`Subagent delivery failed: ${message}`, "warning");
  };
  const sendRootNotification = (notification: RootNotification) => {
    if (limits.subagentMode === "off" || context?.isIdle?.() === false) return;
    // Never submit to Pi's streaming queue: off must also suppress pending delivery.
    pi.sendMessage(
      {
        customType: "pi-subagent:update",
        content: notification.content,
        // Keep asynchronous child updates in model context, not the main chat.
        // Idle/settlement delivery can follow the root's final answer; rendering it
        // would leave a child's output as the last visible message. The widget and
        // agent browser provide status/output without displacing the root response.
        display: false,
        details: notification.details,
      },
      { triggerTurn: false },
    );
    if (notification.trigger === true) wakeRequested = true;
  };
  const pendingSummaries = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch();
    const summarized = new Set(
      entries.flatMap((entry) => {
        if (entry.type !== "custom_message" || entry.customType !== ROOT_SUMMARY_MESSAGE) return [];
        const ids = (entry.details as { mailboxIds?: unknown } | undefined)?.mailboxIds;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      }),
    );
    return entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== ROOT_MAILBOX_ENTRY) return [];
      const notification = entry.data as RootNotification | undefined;
      return notification?.rootSessionId === ctx.sessionManager.getSessionId() &&
        notification.finalRecap === true &&
        typeof notification.content === "string" &&
        typeof notification.details?.mailboxId === "string" &&
        !summarized.has(notification.details.mailboxId)
        ? [notification]
        : [];
    });
  };
  const pendingRootNotifications = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch();
    const delivered = new Set(
      entries.flatMap((entry) => {
        if (entry.type !== "custom_message" || entry.customType !== "pi-subagent:update") return [];
        const id = (entry.details as { mailboxId?: unknown } | undefined)?.mailboxId;
        return typeof id === "string" ? [id] : [];
      }),
    );
    return entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== ROOT_MAILBOX_ENTRY) return [];
      const notification = entry.data as RootNotification | undefined;
      if (
        notification?.rootSessionId !== ctx.sessionManager.getSessionId() ||
        typeof notification.content !== "string" ||
        typeof notification.details?.mailboxId !== "string" ||
        delivered.has(notification.details.mailboxId)
      )
        return [];
      delivered.add(notification.details.mailboxId);
      return [notification];
    });
  };
  const scheduleRootTurn = (ctx: ExtensionContext) => {
    if (
      limits.subagentMode === "off" ||
      rootTurnRunning ||
      suspendingSummaries ||
      rootTurnTimer !== undefined
    )
      return;
    // Include undelivered mailbox entries: a completion may arrive while Pi is
    // compacting, which does not necessarily produce an agent_settled event.
    if (
      !wakeRequested &&
      !(
        limits.finalRecap &&
        (manager?.outstandingAsync() ?? 0) === 0 &&
        pendingSummaries(ctx).length > 0
      ) &&
      !pendingRootNotifications(ctx).some((notification) => notification.trigger === true)
    )
      return;
    const currentGeneration = generation;
    // Zero-delay deferral crosses the SDK settlement boundary; busy retries also
    // cover compaction and other non-agent busy periods. Reporting timers are
    // deliberately irrelevant to completion readiness.
    rootTurnTimer = setTimeout(
      () => {
        rootTurnTimer = undefined;
        if (
          currentGeneration !== generation ||
          context?.sessionManager !== ctx.sessionManager ||
          limits.subagentMode === "off" ||
          suspendingSummaries ||
          rootTurnRunning
        )
          return;
        if (ctx.isIdle() === false) {
          scheduleRootTurn(ctx);
          return;
        }
        drainRootMailbox(ctx);
        const notifications =
          limits.finalRecap && (manager?.outstandingAsync() ?? 0) === 0
            ? pendingSummaries(ctx)
            : [];
        if (!notifications.length && !wakeRequested) return;
        const wasWakeRequested = wakeRequested;
        wakeRequested = false;
        rootTurnRunning = true; // Also reserves a normal wake until agent_settled.
        try {
          pi.sendMessage(
            notifications.length
              ? {
                  customType: ROOT_SUMMARY_MESSAGE,
                  content:
                    "The asynchronous subagent batch has finished. Collect and inspect its results " +
                    "(use agent_output if more detail is needed), then continue any unfinished work in the user's task. " +
                    "If the overall task is complete, give a concise final recap covering results and failures. " +
                    "Do not spawn or resume agents solely to summarize.\nAgents: " +
                    [
                      ...new Set(notifications.map((notification) => notification.details.path)),
                    ].join(", "),
                  display: false,
                  details: {
                    mailboxIds: notifications.map((notification) => notification.details.mailboxId),
                  },
                }
              : {
                  customType: ROOT_WAKE_MESSAGE,
                  content:
                    "Asynchronous subagent event(s) arrived (see the preceding subagent notifications). " +
                    "Collect results with agent_output and continue any unfinished work; recap when the overall task is complete. " +
                    "For a timeout event decide to wait, steer, stop or re-arm with agent_steer using path and timeoutMs only " +
                    "(omit message; resets the reporting timer from now without interrupting the running agent).",
                  display: false,
                  details: {},
                },
            { triggerTurn: true },
          );
        } catch (error) {
          rootTurnRunning = false;
          wakeRequested = wasWakeRequested;
          warnDelivery(error);
        }
      },
      ctx.isIdle() === false ? 100 : 0,
    );
    rootTurnTimer.unref?.();
  };
  const drainRootMailbox = (ctx: ExtensionContext) => {
    if (limits.subagentMode === "off" || ctx.isIdle?.() === false) return;
    for (const notification of pendingRootNotifications(ctx)) sendRootNotification(notification);
  };
  const restoreRootMailbox = (ctx: ExtensionContext) => {
    drainRootMailbox(ctx);
    scheduleRootTurn(ctx);
  };
  const queueRootNotification = (notification: RootNotification) => {
    pi.appendEntry(ROOT_MAILBOX_ENTRY, notification);
    restoreRootMailbox(requireContext());
  };
  pi.on("agent_settled", async (_event, ctx) => {
    if (context?.sessionManager === ctx.sessionManager) {
      rootTurnRunning = false;
      restoreRootMailbox(ctx);
    }
  });
  const delivery = (event: ThreadEvent) => {
    if (event.kind === "change" || event.kind === "metrics") return;
    const thread = event.thread;
    const fmtMs = (ms: number) => `${Math.round(ms / 1000)}s`;
    const elapsed =
      (thread.elapsedMs ?? 0) + (thread.startedAt ? Date.now() - thread.startedAt : 0);
    const message =
      event.kind === "diagnostic"
        ? diagnosticAgentText(thread.path, event.diagnostic)
        : event.kind === "update"
          ? `Progress from ${thread.path}: ${event.message}`
          : event.kind === "timeout"
            ? `Agent ${thread.path} hit its ${fmtMs(event.timeoutMs)} spawn timeout and is STILL RUNNING (not stopped). ` +
              `State: ${thread.state}; status: ${thread.status}; elapsed: ${fmtMs(elapsed)}; ` +
              `tokens: ${thread.inputTokens ?? 0} in / ${thread.outputTokens ?? 0} out.\n` +
              `Recent output:\n${event.recentOutput || "(none yet)"}\n` +
              "Decide: agent_steer with timeoutMs only (no message) to be notified again later without disturbing it, agent_wait for it, agent_steer to redirect, agent_stop to cancel, or let it continue."
            : thread.state === "completed"
              ? `Agent ${thread.path} completed. Final answer:\n${thread.output?.slice(0, 16000) ?? "(no text)"}${(thread.output?.length ?? 0) > 16000 ? "\n[Output truncated; use agent_output for more.]" : ""}`
              : `Agent ${thread.path} is ${thread.state}: ${thread.status}. ${thread.state === "paused" ? "No answer handback; send input to resume the same session." : "Session retained for further input."}`;
    try {
      if (event.recipient === "/root") {
        const recap =
          limits.finalRecap &&
          !suspendingSummaries &&
          event.kind === "settled" &&
          event.async &&
          ["completed", "failed", "stopped"].includes(thread.state);
        const notification: RootNotification = {
          rootSessionId: requireContext().sessionManager.getSessionId(),
          content: message,
          // Foreground results already handled by a busy main thread do not need
          // another turn. Completions during a summary do need a follow-up summary.
          finalRecap: recap,
          // Recap mode defers the turn until every outstanding async agent has reported.
          trigger:
            !suspendingSummaries &&
            (event.kind === "timeout" || (event.kind === "settled" && event.async && !recap)),
          details: {
            mailboxId: randomUUID(),
            path: thread.path,
            state: thread.state,
          },
        };
        // Persist first; defer delivery until the root is idle and the plugin is enabled.
        // The eventual transcript message carries its ID for branch-local recovery.
        queueRootNotification(notification);
      } else {
        const recipient = event.recipient;
        void requireManager().deliver(recipient, message).catch(warnDelivery);
        // A nested async child can outlive its parent. Once that parent has settled,
        // its session can no longer wake the root, so retain a root mailbox copy.
        if (event.kind === "settled") {
          const parent = requireManager().list().find((thread) => thread.path === recipient);
          if (parent === undefined || (parent.state !== "starting" && parent.state !== "running")) {
            queueRootNotification({
              rootSessionId: requireContext().sessionManager.getSessionId(),
              content: message,
              trigger: true,
              details: { mailboxId: randomUUID(), path: thread.path, state: thread.state },
            });
          } else {
            // Global outstandingAsync includes nested descendants, so their last
            // settlement must unblock a root batch even when its parent is still active.
            restoreRootMailbox(requireContext());
          }
        }
      }
    } catch (error) {
      warnDelivery(error);
    }
  };

  const makeDriverFactory = () =>
    createDriverFactory(
      requireContext,
      () => limits.modelSelection,
      () => limits.toolFiltering,
      () => inheritedTools.snapshot(),
      () => limits.subagentExtensions,
    );
  let driverFactory = makeDriverFactory();
  const toolsFor = (path: string) =>
    agentTools(
      requireManager,
      path,
      () => store.list(),
      (type) => driverFactory.resolveAgentSettings(type, path),
      () => driverFactory.availableModels(),
    );
  const rootTools = toolsFor("/root");
  let toolsEnabled: boolean | undefined;
  const syncTools = () => {
    const enabled = limits.subagentMode !== "off";
    if (toolsEnabled === enabled) return;
    toolsEnabled = enabled;
    for (const tool of rootTools) {
      pi.registerTool({
        ...tool,
        // Hidden tools are neither model-visible nor discoverable/callable via codemode.
        exposure: enabled ? "direct" : "hidden",
        prepareLoadout: inheritedTools.captureLoadout,
        execute: (...args) => {
          if (limits.subagentMode === "off") throw new Error("Subagent Mode is off");
          inheritedTools.captureContext(args[4]);
          return tool.execute(...args);
        },
      });
    }
  };
  const refreshWidget = (ctx: ExtensionContext) => {
    if (limits.subagentMode === "off") {
      if (ctx.hasUI) ctx.ui.setWidget("pi-subagent", undefined);
    } else
      updateWidget(
        ctx,
        widgetThreads(),
        widgetCollapsed ? "minimal" : limits.widgetMode,
        limits.nerdFontIcons,
        rootTurnEnded,
        limits.loaderStyle,
        widgetCollapsed && limits.widgetMode === "full",
      );
  };
  pi.on("agent_start", async (_event, ctx) => {
    // A new task must not resurrect the previous task's settled agents. Automatic
    // final-recap turns still belong to that task and keep its results visible.
    if (manager && !rootTurnRunning) {
      for (const thread of manager.list()) {
        if (thread.state !== "starting" && thread.state !== "running")
          hiddenWidgetThreads.add(thread.path);
      }
    }
    rootTurnEnded = false;
    if (manager) refreshWidget(ctx);
  });
  pi.on("agent_end", async (_event, ctx) => {
    rootTurnEnded = true;
    if (manager) refreshWidget(ctx);
    refreshCostFooter(ctx);
    // A migration can span clarification turns. Reload after each root turn, without converting files.
    if (limits.subagentMode === "off" || !migrationRequested) return;
    store.reload();
    if (store.diagnostics.length) context?.ui.notify(store.diagnostics.join("\n"), "warning");
  });

  // The footer normally refreshes when subagents report metrics or when a root turn ends.
  // Without any subagents running there are no metric events, so refresh on main-session
  // turn boundaries to keep the ongoing total accurate.
  pi.on("message_end", async (_event, ctx) => {
    refreshCostFooter(ctx);
  });
  pi.on("tool_execution_end", async (_event, ctx) => {
    refreshCostFooter(ctx);
  });
  syncTools();
  pi.on("before_agent_start", async (event, ctx) => {
    // Re-verify on every turn: the Labs opt-in AND live checklist eligibility must both hold.
    const prompt = subagentPrompt(
      limits,
      limits.checklistIntegration &&
        limits.subagentMode !== "off" &&
        currentChecklistStatus(ctx).eligible,
    );
    if (!prompt) return;
    if (
      limits.subagentMode === "opportunistic" &&
      "prompt" in event &&
      event.prompt.startsWith(IMPORT_REQUEST_PREFIX)
    ) {
      try {
        markImportOffered(getAgentDir());
      } catch (error) {
        ctx.ui.notify(`Could not save import onboarding state: ${String(error)}`, "warning");
      }
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    };
  });

  const attachSession = async (
    ctx: ExtensionContext,
    installEditor = false,
    seedHistory = true,
  ) => {
    cancelSummary();
    clearLiveUpdates();
    clearStreams();
    housekeeping.cancelAll();
    const token = ++generation;
    closeNavigation(installEditor);
    navigation = new AgentNavigationController(returnToWidget);
    // session_start already belongs to the replacement session: never append the old registry here.
    if (manager) await manager.shutdown();
    inheritedTools.reset();
    // pi-checklist reseeds its own state on these same lifecycle events.
    checklistMirror.reset(ctx);
    context = ctx;
    costLedger = new CostLedger();
    costLedger.restore(ctx.sessionManager.getEntries());
    costFooter.reset(ctx);
    rootTurnEnded = false;
    if (installEditor) {
      widgetCollapsed = false;
      hiddenWidgetThreads.clear();
    }
    store = new ConfigStore({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      includeProject: ctx.isProjectTrusted(),
    });
    registryWriter.reset();
    const settingsDiagnostics = loadLimits(ctx);
    syncTools();
    driverFactory = makeDriverFactory();
    const instance = new ThreadManager({
      ...limits,
      createDriver: driverFactory,
      rootSnapshot: () => buildSessionContext(requireContext().sessionManager.getBranch()).messages,
      getType: (name) => store.get(name),
      toolsFor,
      onEventError: (error, event) => {
        const message = error instanceof Error ? error.message : String(error);
        context?.ui.notify(`Subagent ${event.kind} notification failed: ${message}`, "warning");
      },
      onActivity: (activity) => {
        if (token === generation) housekeeping.notify(activity);
      },
      onEvent: (event) => {
        if (token !== generation) return;
        if (event.kind === "stream") {
          queueStream(event.thread.path, event.items);
          return;
        }
        if (event.kind === "change" || event.kind === "metrics") publishLiveUpdate(event.thread);
        else publishLiveUpdate(event.thread, true);
        // 终态把还没发出去的尾批立即推走，避免最后几句正文丢掉。
        if (event.thread.state !== "starting" && event.thread.state !== "running")
          flushStream(event.thread.path);
        // Settled agents and explicit progress reports (which replace the summary) cancel pending
        // housekeeping so an older request cannot reapply stale text; fresh activity reschedules.
        if (
          event.kind === "update" ||
          (event.thread.state !== "starting" && event.thread.state !== "running")
        )
          housekeeping.settle(event.thread.path);
        refreshWidget(requireContext());
        if (event.kind !== "metrics") persist();
        if (event.kind === "settled") rollupCost(event.thread);
        else refreshCostFooter(requireContext());
        delivery(event);
      },
    });
    manager = instance;
    if (installEditor) installNavigationEditor(ctx, seedHistory);
    try {
      const saved = readRegistry(ctx.sessionManager.getBranch());
      // Forked parents own a new registry; they must not share writable child transcripts.
      if (saved?.rootSessionId === ctx.sessionManager.getSessionId())
        instance.restore(saved.threads);
      else if (saved) persist();
    } catch (error) {
      if (limits.subagentMode !== "off")
        ctx.ui.notify(`Could not restore subagent registry: ${String(error)}`, "error");
    }
    // Recover a persisted settlement whose ledger append was interrupted, including runs paused on reload.
    for (const saved of instance.saved()) rollupCost({ ...saved.view, updatedAt: Date.now() });
    for (const thread of instance.list()) publishLiveUpdate(thread, true);
    restoreRootMailbox(ctx);
    refreshWidget(ctx);
    const diagnostics = [...store.diagnostics, ...settingsDiagnostics];
    if (limits.subagentMode !== "off" && diagnostics.length)
      ctx.ui.notify(diagnostics.join("\n"), "warning");
  };
  pi.on("session_start", async (event, ctx) => {
    capabilityActive = true;
    await attachSession(ctx, true, event.reason !== "startup");
    if (limits.subagentMode !== "off") await importAgents(ctx, true);
  });
  pi.on("session_tree", async (_event, ctx) => attachSession(ctx));
  const stopWorkingThreads = async () => {
    cancelSummary();
    closeNavigation();
    suspendingSummaries = true;
    try {
      if (!manager) return;
      for (const thread of manager.list()) {
        const state = manager.get(thread.path).state;
        if (state === "starting" || state === "running") await manager.stop("/root", thread.path);
      }
    } finally {
      cancelSummary();
      suspendingSummaries = false;
    }
  };
  // Finish old-thread cancellation while appendEntry still points to the old branch/session.
  pi.on("session_before_tree", stopWorkingThreads);
  pi.on("session_before_switch", stopWorkingThreads);
  pi.on("session_before_fork", stopWorkingThreads);
  pi.on("session_shutdown", async () => {
    capabilityActive = false;
    cancelSummary();
    clearLiveUpdates();
    clearStreams();
    housekeeping.cancelAll();
    generation++;
    closeNavigation(true);
    await manager?.shutdown();
    costFooter.clear();
    // A clean close leaves an exact checkpoint for releases that cannot read deltas.
    registryWriter.reset();
    persist();
    if (context?.hasUI) context.ui.setWidget("pi-subagent", undefined);
    manager = undefined;
    context = undefined;
  });
  const agentSubcommands = ["tree", "settings", "types", "import", "reload", "reap"] as const;
  const spawnModes = ["fork", "fresh"] as const;
  /** `/agents fork:<type> <task>` inherits the main conversation; `fresh:` starts with no context. */
  const spawnFromCommand = async (
    ctx: ExtensionContext,
    mode: (typeof spawnModes)[number],
    typeName: string,
    task: string,
  ) => {
    if (limits.subagentMode === "off") {
      ctx.ui.notify("Subagent Mode is off. Change it in /agents settings.", "warning");
      return;
    }
    const current = requireManager();
    if (!store.list().some((type) => type.name === typeName)) {
      ctx.ui.notify(`Unknown agent type: ${typeName}`, "error");
      return;
    }
    const base = typeName.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "agent";
    const taken = new Set(current.list().map((thread) => thread.path));
    const prefix = mode === "fork" ? "/root/" : "/";
    let n = 1;
    while (taken.has(`${prefix}${base}-${n}`)) n++;
    const path = `${prefix}${base}-${n}`;
    try {
      await current.scope("/root").spawn({ path, type: typeName, task, wait: false });
      persist();
      refreshWidget(ctx);
      ctx.ui.notify(
        `Started ${typeName} (${mode === "fork" ? "forked context" : "fresh context"}) at ${path}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  pi.registerCommand("agents", {
    description:
      "Configure agent settings, show the live tree, or run /agents fork:<agent> | fresh:<agent> <task>",
    getArgumentCompletions: (argumentText) => {
      const text = argumentText.trimStart();
      const completed = text.match(/^(\S+)(\s+)([\s\S]*)$/);
      if (completed) {
        const command = completed[1]!.toLowerCase();
        if (command === "tree") {
          const paths = (manager?.list() ?? [])
            .map((thread) => thread.path)
            .filter((path) => path !== "/root");
          const matched = fuzzyFilter(paths, completed[3]!.trimStart(), (path) => path);
          if (matched.length === 0) return null;
          return matched.map((path) => ({
            value: `tree ${path}`,
            label: path,
          }));
        }
        if ((agentSubcommands as readonly string[]).includes(command)) return null;
        if (/^(fork|fresh):/.test(command)) return null;
      }
      const lower = text.toLowerCase();
      const colon = lower.indexOf(":");
      // "fo", "fork", "fork:", "fork:wo" -> every matching `fork:<agent>` / `fresh:<agent>`.
      if (lower === "f")
        return spawnModes.map((mode) => ({ value: `${mode}:`, label: `${mode}:` }));
      const modes = spawnModes.filter((mode) =>
        colon >= 0 ? lower.slice(0, colon) === mode : lower.length >= 2 && mode.startsWith(lower),
      );
      if (modes.length) {
        const names = store.list().map((type) => type.name);
        const filter = colon >= 0 ? lower.slice(colon + 1) : "";
        const matched = filter ? fuzzyFilter(names, filter, (name) => name) : names;
        const out = modes.flatMap((mode) =>
          matched.map((name) => ({
            value: `${mode}:${name}`,
            label: `${mode}:${name}`,
          })),
        );
        if (out.length) return out;
      }
      const matched = fuzzyFilter([...agentSubcommands], text, (name) => name);
      if (matched.length === 0) return null;
      return matched.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      const spawnMatch = args.trim().match(/^(fork|fresh):(\S+)(?:\s+([\s\S]*))?$/);
      if (spawnMatch) {
        const task = spawnMatch[3]?.trim();
        if (!task)
          ctx.ui.notify(`Usage: /agents ${spawnMatch[1]}:${spawnMatch[2]} <task>`, "warning");
        else await spawnFromCommand(ctx, spawnMatch[1] as "fork" | "fresh", spawnMatch[2]!, task);
      } else if (command === "import") {
        await importAgents(ctx, false);
      } else if (command === "types") {
        await editAgentTypes(ctx, store, limits.nerdFontIcons, {
          getAllTools: () => pi.getAllTools(),
          toolFiltering: limits.toolFiltering,
          resolveAgentSettings: (type) => driverFactory.resolveAgentSettings(type, "/root"),
        });
        store.reload();
      } else if (command === "reload") {
        store.reload();
        const diagnostics = [...store.diagnostics, ...loadLimits(ctx)];
        requireManager().setLimits(limits);
        syncTools();
        refreshWidget(ctx);
        restoreRootMailbox(ctx);
        ctx.ui.notify(
          diagnostics.length
            ? diagnostics.join("\n")
            : `Loaded ${store.list().length} agent types; maximum ${limits.maxLevels} levels`,
          diagnostics.length ? "warning" : "info",
        );
      } else if (!command || command === "settings") {
        await configureAgents(ctx, {
          store,
          settings: limits,
          agentDir: getAgentDir(),
          getAllTools: () => pi.getAllTools(),
          checklistStatus: () => currentChecklistStatus(ctx),
          resolveAgentSettings: (type) => driverFactory.resolveAgentSettings(type, "/root"),
          apply: () => {
            const diagnostics = loadLimits(ctx);
            requireManager().setLimits(limits);
            syncTools();
            refreshWidget(ctx);
            restoreRootMailbox(ctx);
            if (diagnostics.length) ctx.ui.notify(diagnostics.join("\n"), "warning");
          },
        });
      } else if (command === "reap") {
        const current = requireManager();
        const candidates = current.reapCandidates();
        if (!candidates.length) {
          ctx.ui.notify("No completed agents eligible for reaping.", "info");
          return;
        }
        if (!canOpenDialog(ctx)) return;
        closeNavigation();
        const warning = `${candidates.length} completed agent${candidates.length === 1 ? "" : "s"} will be reaped.\nYou will not be able to resume them anymore.`;
        const choice = await dialogMenu(
          ctx,
          "Reap completed agents?",
          [
            { id: "confirm", label: "Confirm", help: warning },
            { id: "cancel", label: "Cancel", help: warning },
          ],
          { selectedId: "cancel" },
        );
        if (choice !== "confirm" || manager !== current) return;
        const reaped = current.reap(candidates);
        persist();
        refreshWidget(ctx);
        ctx.ui.notify(
          reaped.length
            ? `Reaped ${reaped.length} completed agent(s); their sessions can no longer be resumed.`
            : "No completed agents eligible for reaping.",
          "info",
        );
      } else if (command === "tree") {
        await navigation.open(
          ctx,
          requireManager().scope("/root"),
          rest.join(" ") || undefined,
          limits.nerdFontIcons,
          limits.loaderStyle,
        );
      } else
        ctx.ui.notify(
          "Usage: /agents [tree [path] | settings | types | import | reload | reap | fork:<agent> <task> | fresh:<agent> <task>]",
          "warning",
        );
    },
  });
}
