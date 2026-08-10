import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export type RunState = "idle" | "running" | "stopping";
export type ToolState = "queued" | "running" | "completed" | "failed" | "cancelled";
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
  source: "extension" | "prompt" | "skill";
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
}

export interface ContextSummaryTimelineItem {
  kind: "context-summary";
  id: string;
  createdAt: string;
  summaryType: "compaction" | "branch";
  summary: string;
  tokensBefore?: number;
}

export type TimelineItem = MessageTimelineItem | ToolTimelineItem | ContextSummaryTimelineItem;

export interface TimelinePage {
  items: TimelineItem[];
  start: number;
  total: number;
  hasMore: boolean;
}

export interface SessionStreamSnapshot {
  seq: number;
  status: SessionStatus;
  model: SessionModelSnapshot;
  thinking: SessionThinkingSnapshot;
  /** Messages from the current run that may not yet have reached JSONL. */
  liveMessages: MessageTimelineItem[];
  partial?: MessageTimelineItem;
  activeTools: ToolTimelineItem[];
}

export interface PromptAccepted {
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
  | "tool.upsert"
  | "timeline.upsert"
  | "model.changed"
  | "thinking.changed"
  | "session.updated";

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
    "tool.upsert",
    "timeline.upsert",
    "model.changed",
    "thinking.changed",
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
