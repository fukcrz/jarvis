import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export type RunState = "idle" | "running" | "stopping";
export type RunKind = "llm" | "bash" | "compaction";
export type ToolState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ThinkingState = "running" | "completed";
export type CompactionReason = "manual" | "threshold" | "overflow";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface Workspace {
  id: string;
  cwd: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  name: string;
  parent?: string;
  entries: DirectoryEntry[];
  isGitRepository: boolean;
  isRootPicker: boolean;
}

export interface SessionRef {
  workspaceId: string;
  sessionId: string;
}

export interface ComposerCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "jarvis";
}

export interface WorkspaceFile {
  path: string;
}

export interface ModelDescriptor {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** Whether the model accepts image inputs. */
  vision: boolean;
}

export interface SessionModelSnapshot {
  current?: ModelDescriptor;
  available: ModelDescriptor[];
}

export interface SessionThinkingSnapshot {
  current: ThinkingLevel;
  available: ThinkingLevel[];
}

export interface RetryStatus {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** Absolute deadline so reconnecting clients retain the original countdown. */
  retryAt: string;
  errorMessage: string;
}

export interface CompactionStatus {
  reason: CompactionReason;
  startedAt: string;
  /** Retries while generating the compaction summary, not the model response. */
  retrying?: RetryStatus;
}

export interface SessionStatus {
  sessionId: string;
  runState: RunState;
  activeRun?: {
    id: string;
    startedAt: string;
    /** 运行类别：模型对话 / 用户 !cmd 命令 / 上下文压缩。缺省视为 llm。 */
    kind?: RunKind;
  };
  /** Pi 自动重试进行中（连接错误等可重试失败后指数退避重试） */
  retrying?: RetryStatus;
  /** Pi 正在压缩上下文；自动压缩仍属于原始 prompt run。 */
  compacting?: CompactionStatus;
  lastError?: {
    code: string;
    message: string;
    occurredAt: string;
  };
}

export interface ContextUsage {
  /** Estimated context tokens, or null when unknown (e.g. right after compaction). */
  tokens: number | null;
  contextWindow: number;
  /** Context usage as a percentage of the window, or null when tokens are unknown. */
  percent: number | null;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  name: string | null;
  preview: string | null;
  createdAt: string;
  updatedAt: string;
  runState: RunState;
}

export interface ImageAttachment {
  mimeType: string;
  /** Base64-encoded image data. */
  data: string;
}

export interface MessageTimelineItem {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  text: string;
  /** Images attached to a user message. */
  images?: ImageAttachment[];
}

export interface ToolTimelineItem {
  kind: "tool";
  id: string;
  createdAt: string;
  name: string;
  title: string;
  state: ToolState;
  target?: string;
  inputPreview?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  output?: string;
  error?: string;
  /** 用户 !cmd 命令：true 表示输出不发送给模型（!! 前缀）。 */
  excludeFromContext?: boolean;
}

/** 模型推理过程：思考时展开流式展示，完成后自动收起。 */
export interface ThinkingTimelineItem {
  kind: "thinking";
  id: string;
  createdAt: string;
  state: ThinkingState;
  text: string;
}

export interface ContextSummaryTimelineItem {
  kind: "context-summary";
  id: string;
  createdAt: string;
  summaryType: "compaction" | "branch";
  summary: string;
  tokensBefore?: number;
}

export type TimelineItem = MessageTimelineItem | ToolTimelineItem | ThinkingTimelineItem | ContextSummaryTimelineItem | ExtensionUiTimelineItem;

export interface TimelinePage {
  items: TimelineItem[];
  start: number;
  total: number;
  hasMore: boolean;
}

export interface ExtensionUiSnapshot {
  /** Dialogs that are still waiting for a browser response. */
  dialogs: Array<{ request: Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>; createdAt: string }>;
  /** Extension dialogs, interactions, and notifications retained for browser refresh/reconnect. */
  cards?: ExtensionUiTimelineItem[];
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title?: string;
  /** Monotonic revision lets a reconnect inject the latest extension draft once. */
  editorText?: { text: string; revision: number };
}

export interface SessionStreamSnapshot {
  seq: number;
  status: SessionStatus;
  model: SessionModelSnapshot;
  thinking: SessionThinkingSnapshot;
  /** Messages from the current run that may not yet have reached JSONL. */
  liveMessages: MessageTimelineItem[];
  partial?: MessageTimelineItem;
  /** 当前 run 正在流式的思考块（尚未 message_end 定稿）。 */
  partialThinking?: ThinkingTimelineItem;
  activeTools: ToolTimelineItem[];
  /** 正在执行的用户 !cmd 命令（流式输出尚未落盘）。 */
  activeBash?: ToolTimelineItem;
  /** Estimated context usage, when the current model exposes a context window. */
  contextUsage?: ContextUsage;
  /** Ephemeral extension UI state, retained across browser reconnects. */
  extensionUi?: ExtensionUiSnapshot;
  /** 排队等待投递的用户消息（忙时发送/Alt 发送）。 */
  queue?: SessionQueue;
}

export interface PromptAccepted {
  accepted: true;
  runId: string;
  /** 消息未立即执行而是进入队列（会话忙时）。 */
  queued?: false;
}

export interface QueuedPromptAccepted {
  accepted: true;
  queued: true;
  /** 排队方式：steering 当前回合工具调用后投递；followUp 全部完成后投递。 */
  behavior: "steer" | "followUp";
}

/** 一条已排队、等待投递的用户消息。 */
export interface QueuedMessage {
  id: string;
  kind: "steer" | "followUp";
  text: string;
  createdAt: string;
}

export interface SessionQueue {
  steering: QueuedMessage[];
  followUp: QueuedMessage[];
}

export const emptySessionQueue: SessionQueue = { steering: [], followUp: [] };

export interface BashAccepted {
  accepted: true;
  runId: string;
}

export interface CompactAccepted {
  accepted: true;
  runId: string;
}

export type SessionEventType =
  | "run.started"
  | "run.stopping"
  | "run.settled"
  | "run.failed"
  | "run.retrying"
  | "run.retryEnd"
  | "run.compactionStarted"
  | "run.compactionEnded"
  | "run.compactionRetrying"
  | "message.created"
  | "assistant.delta"
  | "assistant.completed"
  | "thinking.delta"
  | "thinking.completed"
  | "tool.upsert"
  | "timeline.upsert"
  | "bash.delta"
  | "bash.settled"
  | "extension.uiRequest"
  | "extension.uiSettled"
  | "model.changed"
  | "thinking.changed"
  | "context.updated"
  | "queue.updated"
  | "session.rewritten"
  | "session.updated";

export type ExtensionUiRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message?: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string; timeout?: number }
  | { id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | { id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { id: string; method: "setTitle"; title: string }
  | { id: string; method: "set_editor_text"; text: string };

export type ExtensionUiOutcome = "answered" | "cancelled" | "timeout" | "closed";

export interface ExtensionUiTimelineItem {
  kind: "extension-ui";
  id: string;
  createdAt: string;
  request: ExtensionUiRequest;
  /** undefined = 等待用户响应 */
  outcome?: ExtensionUiOutcome;
  /** 用户选择/输入的值（outcome 为 answered 时） */
  value?: string;
  confirmed?: boolean;
}

export interface SessionEvent {
  version: typeof PROTOCOL_VERSION;
  sessionId: string;
  runId?: string;
  seq: number;
  emittedAt: string;
  type: SessionEventType;
  payload: unknown;
}

export type WorkspaceEvent =
  | { version: typeof PROTOCOL_VERSION; type: "session.created"; workspaceId: string; session: SessionSummary }
  | { version: typeof PROTOCOL_VERSION; type: "session.updated"; workspaceId: string; session: SessionSummary }
  | { version: typeof PROTOCOL_VERSION; type: "session.deleted"; workspaceId: string; sessionId: string };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export const sessionEventSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  sessionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  seq: z.number().int().nonnegative(),
  emittedAt: z.string().datetime(),
  type: z.enum([
    "run.started",
    "run.stopping",
    "run.settled",
    "run.failed",
    "run.retrying",
    "run.retryEnd",
    "run.compactionStarted",
    "run.compactionEnded",
    "run.compactionRetrying",
    "message.created",
    "assistant.delta",
    "assistant.completed",
    "thinking.delta",
    "thinking.completed",
    "tool.upsert",
    "timeline.upsert",
    "bash.delta",
    "bash.settled",
    "extension.uiRequest",
    "extension.uiSettled",
    "model.changed",
    "thinking.changed",
    "context.updated",
    "queue.updated",
    "session.rewritten",
    "session.updated",
  ]),
  payload: z.unknown(),
});

const sessionSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().nullable(),
  preview: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  runState: z.enum(["idle", "running", "stopping"]),
});

export const workspaceEventSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("session.created"),
    workspaceId: z.string().min(1),
    session: sessionSummarySchema,
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("session.updated"),
    workspaceId: z.string().min(1),
    session: sessionSummarySchema,
  }),
  z.object({
    version: z.literal(PROTOCOL_VERSION),
    type: z.literal("session.deleted"),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordQueuedMessage(value: unknown): QueuedMessage | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["text"] !== "string" || typeof value["createdAt"] !== "string") return undefined;
  if (value["kind"] !== "steer" && value["kind"] !== "followUp") return undefined;
  return { id: value["id"], kind: value["kind"], text: value["text"], createdAt: value["createdAt"] };
}

export function recordSessionQueue(value: unknown): SessionQueue | undefined {
  if (!isRecord(value)) return undefined;
  const steering = Array.isArray(value["steering"]) ? value["steering"].flatMap((item) => {
    const queued = recordQueuedMessage(item);
    return queued === undefined ? [] : [queued];
  }) : undefined;
  const followUp = Array.isArray(value["followUp"]) ? value["followUp"].flatMap((item) => {
    const queued = recordQueuedMessage(item);
    return queued === undefined ? [] : [queued];
  }) : undefined;
  if (steering === undefined || followUp === undefined) return undefined;
  return { steering, followUp };
}
