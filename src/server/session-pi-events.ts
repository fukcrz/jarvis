import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { isRecord, type AssistantGenerationStats, type MessageTimelineItem, type SessionSummary, type SessionThinkingSnapshot, type ThinkingTimelineItem, type TokenUsage, type ToolTimelineItem } from "../shared/protocol.js";
import type { EventHub } from "./event-hub.js";
import { assistantTextBlockId, assistantTextPhaseFromContent, assistantThinkingBlockId, assistantTimelineItemsFromPi, contextSummaryFromEntry, errorFromPi, messageFromPi, toExternalTimelineItems, toolFromCall, toolWithPartial, toolWithResult, userContentFromContent } from "./projection.js";
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
  publishUsage(active: ActiveSession, runId?: string): void;
  publishTool(active: ActiveSession, tool: ToolTimelineItem, runId?: string): void;
  cancelCompaction(active: ActiveSession): void;
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
    const assistantMessageId = active.assistantStreamId ??= identity.id;
    const update = event.assistantMessageEvent;
    if (!("contentIndex" in update)) return;
    const contentIndex = update.contentIndex;
    const existing = active.partialAssistantItems.get(contentIndex);

    if (update.type === "thinking_start" || update.type === "thinking_delta" || update.type === "thinking_end") {
      // partial is mutable response-so-far; only the event's delta/end is authoritative.
      const text = update.type === "thinking_end" ? update.content
        : (existing?.kind === "thinking" ? existing.text : "") + (update.type === "thinking_delta" ? update.delta : "");
      const item: ThinkingTimelineItem = {
        kind: "thinking", id: assistantThinkingBlockId(assistantMessageId, contentIndex),
        createdAt: existing?.createdAt ?? identity.createdAt, contentIndex, assistantMessageId,
        state: update.type === "thinking_end" ? "completed" : "running", text,
      };
      active.partialAssistantItems.set(contentIndex, item);
      active.partialThinking = item.state === "running" ? item : undefined;
      this.host.events.publishSession(active.ref, {
        type: update.type === "thinking_end" ? "thinking.completed" : "thinking.delta", runId,
        payload: { thinkingId: item.id, createdAt: item.createdAt, contentIndex, assistantMessageId,
          ...(update.type === "thinking_end" ? { text } : { delta: update.type === "thinking_delta" ? update.delta : "" }) },
      });
      return;
    }
    if (update.type === "text_start" || update.type === "text_delta" || update.type === "text_end") {
      active.assistantGenerationStartedAt ??= Date.now();
      const phase = assistantTextPhaseFromContent(update.partial.content[contentIndex]);
      const text = update.type === "text_end" ? update.content
        : (existing?.kind === "message" ? existing.text : "") + (update.type === "text_delta" ? update.delta : "");
      const item: MessageTimelineItem = {
        kind: "message", id: assistantTextBlockId(assistantMessageId, contentIndex), role: "assistant",
        createdAt: existing?.createdAt ?? identity.createdAt, contentIndex, assistantMessageId, text,
        ...(phase === undefined ? {} : { phase }),
      };
      active.partialAssistantItems.set(contentIndex, item);
      if (update.type === "text_end") active.streamingMessageIds.delete(item.id);
      else active.streamingMessageIds.add(item.id);
      const texts = [...active.partialAssistantItems.entries()].sort(([left], [right]) => left - right)
        .flatMap(([, block]) => block.kind === "message" ? [block] : []);
      const streamedText = texts.map((block) => block.text).join("\n\n");
      active.partial = { ...item, id: assistantMessageId, text: streamedText };
      const estimatedOutputTokens = estimateOutputTokens(streamedText);
      active.liveGeneration = {
        assistantMessageId,
        startedAt: new Date(active.assistantGenerationStartedAt).toISOString(),
        ...(estimatedOutputTokens <= 0 ? {} : { estimatedOutputTokens }),
      };
      this.host.events.publishSession(active.ref, {
        type: update.type === "text_end" ? "assistant.completed" : "assistant.delta", runId,
        payload: update.type === "text_end" ? { message: item, authoritative: false, liveGeneration: active.liveGeneration }
          : { messageId: item.id, createdAt: item.createdAt, contentIndex, assistantMessageId, phase,
            delta: update.type === "text_delta" ? update.delta : "", liveGeneration: active.liveGeneration },
      });
      return;
    }
    if (update.type === "toolcall_end") {
      this.host.publishTool(active, toolFromCall(update.toolCall.id, update.toolCall.name, update.toolCall.arguments,
        identity.createdAt, "queued", { contentIndex, assistantMessageId }));
    }
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
    const provisionalIds = [
      ...[...active.partialAssistantItems.values()].map((item) => item.id),
      ...[...active.activeTools.values()].filter((item) => item.assistantMessageId === assistantId).map((item) => item.id),
    ];
    const generation = assistantGenerationStats(message, active.assistantGenerationStartedAt);
    const authoritative = assistantTimelineItemsFromPi(message, identity.createdAt, assistantId, assistantId, generation);
    if (generation !== undefined) active.latestGeneration = generation;
    for (const id of provisionalIds) {
      active.liveMessages.delete(id);
      active.liveThinking.delete(id);
      active.activeTools.delete(id);
    }
    for (const item of authoritative) {
      if (item.kind === "message") {
        active.liveMessages.set(item.id, item);
        // Retain the single-item payload for clients predating block reconciliation.
        this.host.events.publishSession(active.ref, { type: "assistant.completed", runId, payload: { message: item } });
      } else if (item.kind === "thinking") {
        active.liveThinking.set(item.id, item);
        this.host.events.publishSession(active.ref, { type: "thinking.completed", runId, payload: {
          thinkingId: item.id, contentIndex: item.contentIndex, assistantMessageId: item.assistantMessageId,
          createdAt: item.createdAt, text: item.text,
        } });
      } else {
        this.host.publishTool(active, item);
      }
    }
    // Replace the whole response in source order, including disappeared provisional blocks.
    this.host.events.publishSession(active.ref, { type: "assistant.completed", runId, payload: { items: toExternalTimelineItems(authoritative, active.ref), replaceIds: provisionalIds } });
    active.partialAssistantItems.clear();
    active.streamingMessageIds.clear();
    active.partialThinking = undefined;
    active.partial = undefined;
    active.assistantGenerationStartedAt = undefined;
    active.liveGeneration = undefined;
    this.host.publishContextUsage(active, runId);
    if (generation !== undefined) {
      queueMicrotask(() => {
        try {
          active.session.sessionManager.appendCustomEntry("jarvis.generation", { assistantMessageId: assistantId, generation });
        } catch (error) {
          console.warn("Failed to persist Jarvis generation metadata", error);
        }
        this.host.publishUsage(active, runId);
      });
    } else {
      this.host.publishUsage(active, runId);
    }
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
    const previous = active.activeTools.get(event.toolCallId);
    active.toolStartedAt.set(event.toolCallId, Date.now());
    const tool = toolFromCall(
      event.toolCallId,
      event.toolName,
      event.args,
      new Date().toISOString(),
      "running",
      {
        ...(event.toolName === "bash" ? { cwd: active.cwd } : {}),
        ...(previous?.contentIndex === undefined ? {} : { contentIndex: previous.contentIndex }),
        ...(previous?.assistantMessageId === undefined ? {} : { assistantMessageId: previous.assistantMessageId }),
      },
    );
    this.host.publishTool(active, { ...tool, createdAt: previous?.createdAt ?? tool.createdAt });
  }

  private onToolExecutionUpdate(active: ActiveSession, event: PiEvent<"tool_execution_update">): void {
    const previous = active.activeTools.get(event.toolCallId) ?? toolFromCall(event.toolCallId, event.toolName, event.args);
    this.host.publishTool(active, toolWithPartial(previous, event.partialResult));
  }

  private onToolExecutionEnd(active: ActiveSession, event: PiEvent<"tool_execution_end">): void {
    const previous = active.activeTools.get(event.toolCallId) ?? toolFromCall(event.toolCallId, event.toolName, undefined, new Date().toISOString(), "running", event.toolName === "bash" ? { cwd: active.cwd } : undefined);
    const startedAt = active.toolStartedAt.get(event.toolCallId);
    const durationMs = startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt);
    active.toolStartedAt.delete(event.toolCallId);
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
    this.host.publishUsage(active, runId);
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
    active.partialAssistantItems.clear();
    active.streamingMessageIds.clear();
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

function assistantGenerationStats(message: unknown, startedAt?: number): AssistantGenerationStats | undefined {
  if (!isRecord(message)) return undefined;
  const stopReason = stringValue(message["stopReason"]);
  if (stopReason === "error" || stopReason === "aborted") return undefined;
  const rawUsage = message["usage"];
  if (!isRecord(rawUsage)) return undefined;
  const number = (key: string): number | undefined => {
    const value = rawUsage[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const input = number("input");
  const output = number("output");
  const cacheRead = number("cacheRead");
  const cacheWrite = number("cacheWrite");
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  const rawCost = isRecord(rawUsage["cost"]) ? rawUsage["cost"] : undefined;
  const cost = typeof rawCost?.["total"] === "number" && Number.isFinite(rawCost["total"]) && rawCost["total"] > 0 ? rawCost["total"] : undefined;
  const reasoning = typeof rawUsage["reasoning"] === "number" && Number.isFinite(rawUsage["reasoning"]) && rawUsage["reasoning"] >= 0 ? rawUsage["reasoning"] : undefined;
  const durationMs = startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt);
  const usage: TokenUsage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(cost === undefined ? {} : { cost }),
  };
  return { usage, ...(durationMs === undefined ? {} : { durationMs }) };
}

/** A deliberately coarse live estimate; the completed response always replaces it with provider usage. */
function estimateOutputTokens(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4);
    asciiRun = 0;
  };
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const cjk = codePoint >= 0x2e80 && codePoint <= 0x9fff
      || codePoint >= 0xac00 && codePoint <= 0xd7af
      || codePoint >= 0x3040 && codePoint <= 0x30ff;
    if (cjk || codePoint > 0xffff) {
      flushAscii();
      tokens += 1;
    } else {
      asciiRun += 1;
    }
  }
  flushAscii();
  return tokens;
}
