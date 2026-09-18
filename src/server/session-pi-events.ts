import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionSummary, SessionThinkingSnapshot, ThinkingTimelineItem, ToolTimelineItem } from "../shared/protocol.js";
import type { EventHub } from "./event-hub.js";
import { assistantTextFromContent, contextSummaryFromEntry, errorFromPi, messageFromPi, thinkingTextFromContent, toolFromCall, toolWithPartial, toolWithResult, userContentFromContent } from "./projection.js";
import type { ActiveRun, ActiveSession, PiEvent } from "./session-active.js";
import { firstUserMessage, isAssistantMessage, isUserMessage, retryStatus } from "./session-helpers.js";
import { stringValue } from "./values.js";

export interface SessionPiHost {
  events: EventHub;
  clearSettlementTimer(active: ActiveSession): void;
  setAttention(active: ActiveSession, state: ActiveSession["attentionState"], at?: string): void;
  resetLiveStream(active: ActiveSession): void;
  publishSummary(active: ActiveSession, supplied?: SessionSummary): void;
  persistListCopy(active: ActiveSession, summary: SessionSummary): void;
  summaryFromActive(active: ActiveSession, previewOverride?: string): SessionSummary;
  thinkingSnapshot(active: ActiveSession): SessionThinkingSnapshot;
  publishContextUsage(active: ActiveSession, runId?: string): void;
  publishTool(active: ActiveSession, tool: ToolTimelineItem, runId?: string): void;
  cancelCompaction(active: ActiveSession): void;
  syncQueue(active: ActiveSession): void;
  deferAgentSettlement(active: ActiveSession): void;
}

export class SessionPiEvents {
  constructor(private readonly host: SessionPiHost) {}

  handle(active: ActiveSession, event: AgentSessionEvent): void {
    active.updatedAt = new Date().toISOString();
    switch (event.type) {
      case "agent_start":
        this.onAgentStart(active);
        return;
      case "message_update":
        this.onMessageUpdate(active, event);
        return;
      case "message_end":
        this.onMessageEnd(active, event);
        return;
      case "tool_execution_start":
        this.onToolExecutionStart(active, event);
        return;
      case "tool_execution_update":
        this.onToolExecutionUpdate(active, event);
        return;
      case "tool_execution_end":
        this.onToolExecutionEnd(active, event);
        return;
      case "compaction_start":
        this.onCompactionStart(active, event);
        return;
      case "compaction_end":
        this.onCompactionEnd(active, event);
        return;
      case "summarization_retry_scheduled":
        this.onSummarizationRetryScheduled(active, event);
        return;
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        this.onSummarizationRetryCleared(active);
        return;
      case "auto_retry_start":
        this.onAutoRetryStart(active, event);
        return;
      case "auto_retry_end":
        this.onAutoRetryEnd(active, event);
        return;
      case "queue_update":
        if (!active.queueSyncSuspended) this.host.syncQueue(active);
        return;
      case "agent_settled":
        this.host.deferAgentSettlement(active);
        return;
      case "thinking_level_changed":
        this.host.events.publishSession(active.ref, { type: "thinking.changed", payload: { thinking: this.host.thinkingSnapshot(active) } });
        return;
      case "session_info_changed":
        this.host.publishSummary(active);
        this.host.persistListCopy(active, this.host.summaryFromActive(active));
        return;
      default:
        return;
    }
  }

  private onAgentStart(active: ActiveSession): void {
    // Extensions can start a continuation without passing through Jarvis's
    // HTTP prompt endpoint. Pi is authoritative for that lifecycle.
    this.host.clearSettlementTimer(active);
    if (active.state.runState !== "idle") {
      // 重试退避结束、重试请求真正开始：撤掉“正在重试”状态。Pi 的 auto_retry_end 要等这次
      // 尝试成功才发，若一直挂着 retrying，就会出现“一边流式思考、一边显示正在重试”。
      // 与 Pi TUI 在 agent_start 清 retry 指示的行为保持一致。
      if (active.state.retrying === undefined) return;
      active.state = { ...active.state, retrying: undefined };
      this.host.events.publishSession(active.ref, { type: "run.retryEnd", runId: active.state.activeRun?.id, payload: { status: active.state } });
      return;
    }
    const run: ActiveRun = { id: randomUUID(), startedAt: new Date().toISOString(), kind: "llm" };
    active.state = { sessionId: active.ref.sessionId, runState: "running", activeRun: run };
    this.host.setAttention(active, "running");
    this.host.resetLiveStream(active);
    this.host.events.publishSession(active.ref, { type: "run.started", runId: run.id, payload: { status: active.state } });
    this.host.publishSummary(active);
  }

  private onMessageUpdate(active: ActiveSession, event: PiEvent<"message_update">): void {
    const runId = active.state.activeRun?.id;
    if (runId === undefined) return;
    const identity = messageFromPi(event.message, "assistant", "");
    const assistantId = active.assistantStreamId ??= identity.id;

    if (event.assistantMessageEvent.type === "thinking_delta") {
      const thinkingId = `${assistantId}:thinking`;
      active.partialThinking ??= {
        kind: "thinking",
        id: thinkingId,
        createdAt: identity.createdAt,
        state: "running",
        text: "",
      };
      active.partialThinking.text += event.assistantMessageEvent.delta;
      this.host.events.publishSession(active.ref, { type: "thinking.delta", runId, payload: { thinkingId, createdAt: active.partialThinking.createdAt, delta: event.assistantMessageEvent.delta } });
      return;
    }
    if (event.assistantMessageEvent.type !== "text_delta") return;
    if (active.partialThinking !== undefined) {
      const thinking = { ...active.partialThinking, state: "completed" as const };
      active.partialThinking = undefined;
      this.host.events.publishSession(active.ref, { type: "thinking.completed", runId, payload: { thinkingId: thinking.id, createdAt: thinking.createdAt, text: thinking.text } });
    }
    const partial = active.partial ?? {
      kind: "message" as const,
      id: assistantId,
      role: "assistant" as const,
      createdAt: identity.createdAt,
      text: "",
    };
    partial.text += event.assistantMessageEvent.delta;
    active.partial = partial;
    this.host.events.publishSession(active.ref, { type: "assistant.delta", runId, payload: { messageId: partial.id, delta: event.assistantMessageEvent.delta } });
  }

  private onMessageEnd(active: ActiveSession, event: PiEvent<"message_end">): void {
    const runId = active.state.activeRun?.id;
    if (runId === undefined) return;
    if (isUserMessage(event.message)) {
      this.onUserMessageEnd(active, event.message, runId);
      return;
    }
    if (isAssistantMessage(event.message)) this.onAssistantMessageEnd(active, event.message, runId);
  }

  private onUserMessageEnd(active: ActiveSession, message: { role: "user"; content: unknown; timestamp?: number | string }, runId: string): void {
    const { text, images } = userContentFromContent(message.content);
    if (text === "" && images.length === 0) return;
    const item = {
      ...messageFromPi(message, "user", text),
      ...(images.length === 0 ? {} : { images }),
    };
    active.liveMessages.set(item.id, item);
    this.host.events.publishSession(active.ref, { type: "message.created", runId, payload: { message: item } });
    // Pi emits message_end before it persists the message. Publish the
    // first prompt immediately with an explicit preview so the browser
    // does not have to wait for the whole agent run to settle before
    // replacing the "新会话" fallback title.
    if (firstUserMessage(active.session.sessionManager.getBranch()) === null && text !== "") {
      const summary = this.host.summaryFromActive(active, text);
      this.host.publishSummary(active, summary);
      this.host.persistListCopy(active, summary);
    }
  }

  private onAssistantMessageEnd(active: ActiveSession, message: { role: "assistant"; content: unknown; timestamp?: number | string }, runId: string): void {
    const identity = messageFromPi(message, "assistant", "", active.partial?.createdAt);
    const assistantId = active.assistantStreamId ?? identity.id;
    const stopReason = stringValue((message as Record<string, unknown>)["stopReason"]);
    // 思考块定稿：以最终 content 里的 thinking 部分为准（流式期间部分 provider
    // 只在 message_end 才返回思考内容），兜底用流式累积的文本。
    const thinkingText = thinkingTextFromContent(message.content);
    if (active.partialThinking !== undefined || thinkingText !== "") {
      const thinking: ThinkingTimelineItem = {
        kind: "thinking",
        id: `${assistantId}:thinking`,
        createdAt: active.partialThinking?.createdAt ?? identity.createdAt,
        state: "completed",
        text: thinkingText !== "" ? thinkingText : (active.partialThinking?.text ?? ""),
      };
      active.partialThinking = undefined;
      this.host.events.publishSession(active.ref, { type: "thinking.completed", runId, payload: { thinkingId: thinking.id, createdAt: thinking.createdAt, text: thinking.text } });
    }
    const text = assistantTextFromContent(message.content);
    const completed = text === ""
      ? undefined
      : messageFromPi(message, "assistant", text, active.partial?.createdAt);
    if (completed !== undefined) {
      const item = active.partial === undefined ? { ...completed, id: assistantId } : { ...completed, id: active.partial.id, createdAt: active.partial.createdAt };
      active.liveMessages.set(item.id, item);
      active.partial = undefined;
      this.host.events.publishSession(active.ref, { type: "assistant.completed", runId, payload: { message: item } });
    }
    this.host.publishContextUsage(active, runId);
    if (stopReason === "error") {
      this.markAssistantAttemptFailed(active, message, identity.createdAt, assistantId, runId);
    } else if (stopReason !== "aborted") {
      this.markAssistantAttemptsRecovered(active, runId);
    }
    active.assistantStreamId = undefined;
  }

  private markAssistantAttemptFailed(active: ActiveSession, message: unknown, createdAt: string, assistantId: string, runId: string): void {
    for (const previous of active.liveErrors.values()) {
      if (previous.state !== "retrying") continue;
      const settled = { ...previous, state: "failed" as const };
      active.liveErrors.set(settled.id, settled);
      this.host.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item: settled } });
    }
    const error = { ...errorFromPi(message, createdAt, assistantId), groupId: runId };
    active.liveErrors.set(error.id, error);
    this.host.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item: error } });
    active.pendingRunError = { code: error.code, message: error.message };
  }

  private markAssistantAttemptsRecovered(active: ActiveSession, runId: string): void {
    for (const error of active.liveErrors.values()) {
      if (error.state === "recovered") continue;
      const recovered = { ...error, state: "recovered" as const };
      active.liveErrors.set(recovered.id, recovered);
      this.host.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item: recovered } });
    }
    active.pendingRunError = undefined;
  }

  private onToolExecutionStart(active: ActiveSession, event: PiEvent<"tool_execution_start">): void {
    this.host.publishTool(active, toolFromCall(
      event.toolCallId,
      event.toolName,
      event.args,
      new Date().toISOString(),
      "running",
      event.toolName === "bash" ? { cwd: active.cwd } : undefined,
    ));
  }

  private onToolExecutionUpdate(active: ActiveSession, event: PiEvent<"tool_execution_update">): void {
    const previous = active.activeTools.get(event.toolCallId) ?? toolFromCall(event.toolCallId, event.toolName, event.args);
    this.host.publishTool(active, toolWithPartial(previous, event.partialResult));
  }

  private onToolExecutionEnd(active: ActiveSession, event: PiEvent<"tool_execution_end">): void {
    const previous = active.activeTools.get(event.toolCallId) ?? toolFromCall(event.toolCallId, event.toolName, undefined, new Date().toISOString(), "running", event.toolName === "bash" ? { cwd: active.cwd } : undefined);
    const startedAt = Date.parse(previous.createdAt);
    const durationMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined;
    this.host.publishTool(active, toolWithResult(previous, event.result, event.isError, durationMs));
  }

  private onCompactionStart(active: ActiveSession, event: PiEvent<"compaction_start">): void {
    // Extension ctx.compact() resumes immediately after the agent_settled
    // event. It owns the run that would otherwise settle on this timer.
    if (active.settlementTimer !== undefined) {
      this.host.clearSettlementTimer(active);
      active.compactionHandoff = true;
    }
    const startedAt = active.state.compacting?.reason === event.reason
      ? active.state.compacting.startedAt
      : new Date().toISOString();
    active.state = {
      ...active.state,
      compacting: { reason: event.reason, startedAt },
    };
    if (active.compactionAbortRequested) this.host.cancelCompaction(active);
    this.host.events.publishSession(active.ref, {
      type: "run.compactionStarted",
      ...(active.state.activeRun === undefined ? {} : { runId: active.state.activeRun.id }),
      payload: { status: active.state },
    });
    this.host.publishSummary(active);
  }

  private onCompactionEnd(active: ActiveSession, event: PiEvent<"compaction_end">): void {
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
      if (item !== undefined) this.host.events.publishSession(active.ref, { type: "timeline.upsert", ...(runId === undefined ? {} : { runId }), payload: { item } });
    } else if (!event.aborted && errorMessage !== undefined) {
      if (event.reason === "overflow") {
        active.pendingRunError = { code: "PI_COMPACTION_FAILED", message: errorMessage };
      } else if (event.reason === "threshold") {
        active.state = {
          ...active.state,
          lastError: { code: "PI_COMPACTION_FAILED", message: errorMessage, occurredAt: new Date().toISOString() },
        };
      } else {
        active.pendingRunError = { code: "PI_COMPACTION_FAILED", message: errorMessage };
      }
    }
    this.host.events.publishSession(active.ref, {
      type: "run.compactionEnded",
      ...(runId === undefined ? {} : { runId }),
      payload: { status: active.state, aborted: event.aborted, ...(errorMessage === undefined ? {} : { errorMessage }), willRetry: event.willRetry },
    });
    this.host.publishContextUsage(active, runId);
    this.host.publishSummary(active);
    if (handoff) {
      if (event.aborted) active.pendingRunError = undefined;
      this.host.deferAgentSettlement(active);
    }
  }

  private onSummarizationRetryScheduled(active: ActiveSession, event: PiEvent<"summarization_retry_scheduled">): void {
    if (active.state.compacting === undefined) return;
    active.state = {
      ...active.state,
      compacting: {
        ...active.state.compacting,
        retrying: retryStatus(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage),
      },
    };
    this.publishCompactionRetrying(active);
  }

  private onSummarizationRetryCleared(active: ActiveSession): void {
    if (active.state.compacting?.retrying === undefined) return;
    active.state = {
      ...active.state,
      compacting: { ...active.state.compacting, retrying: undefined },
    };
    this.publishCompactionRetrying(active);
  }

  private publishCompactionRetrying(active: ActiveSession): void {
    this.host.events.publishSession(active.ref, {
      type: "run.compactionRetrying",
      ...(active.state.activeRun === undefined ? {} : { runId: active.state.activeRun.id }),
      payload: { status: active.state },
    });
    this.host.publishSummary(active);
  }

  private onAutoRetryStart(active: ActiveSession, event: PiEvent<"auto_retry_start">): void {
    const runId = active.state.activeRun?.id;
    if (runId === undefined) return;
    active.assistantStreamId = undefined;
    active.partial = undefined;
    active.partialThinking = undefined;
    const retrying = retryStatus(event.attempt, event.maxAttempts, event.delayMs, event.errorMessage);
    active.state = { ...active.state, retrying };
    const latestError = [...active.liveErrors.values()].at(-1);
    if (latestError !== undefined) {
      const item = { ...latestError, state: "retrying" as const, attempt: retrying.attempt, maxAttempts: retrying.maxAttempts, retryAt: retrying.retryAt };
      active.liveErrors.set(item.id, item);
      this.host.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item } });
    }
    this.host.events.publishSession(active.ref, { type: "run.retrying", runId, payload: { status: active.state } });
    this.host.publishSummary(active);
  }

  private onAutoRetryEnd(active: ActiveSession, event: PiEvent<"auto_retry_end">): void {
    const runId = active.state.activeRun?.id;
    if (runId === undefined) return;
    active.state = { ...active.state, retrying: undefined };
    if (!event.success) {
      const latestError = [...active.liveErrors.values()].at(-1);
      if (latestError?.state === "retrying") {
        const item = { ...latestError, state: "failed" as const };
        active.liveErrors.set(item.id, item);
        this.host.events.publishSession(active.ref, { type: "timeline.upsert", runId, payload: { item } });
      }
    }
    this.host.events.publishSession(active.ref, { type: "run.retryEnd", runId, payload: { status: active.state } });
    this.host.publishSummary(active);
  }
}
