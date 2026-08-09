import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export type RunState = "idle" | "running" | "stopping";
export type ToolState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Workspace {
  id: string;
  cwd: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRef {
  workspaceId: string;
  sessionId: string;
}

export interface ModelDescriptor {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface SessionModelSnapshot {
  current?: ModelDescriptor;
  available: ModelDescriptor[];
}

export interface SessionStatus {
  sessionId: string;
  runState: RunState;
  activeRun?: {
    id: string;
    startedAt: string;
  };
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

export interface MessageTimelineItem {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  text: string;
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
  output?: string;
  error?: string;
}

export type TimelineItem = MessageTimelineItem | ToolTimelineItem;

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
  /** Messages from the current run that may not yet have reached JSONL. */
  liveMessages: MessageTimelineItem[];
  partial?: MessageTimelineItem;
  activeTools: ToolTimelineItem[];
}

export interface PromptAccepted {
  accepted: true;
  runId: string;
}

export type SessionEventType =
  | "run.started"
  | "run.stopping"
  | "run.settled"
  | "run.failed"
  | "message.created"
  | "assistant.delta"
  | "assistant.completed"
  | "tool.upsert"
  | "model.changed"
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
  | { version: typeof PROTOCOL_VERSION; type: "session.updated"; workspaceId: string; session: SessionSummary };

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
    "message.created",
    "assistant.delta",
    "assistant.completed",
    "tool.upsert",
    "model.changed",
    "session.updated",
  ]),
  payload: z.unknown(),
});

export const workspaceEventSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  type: z.enum(["session.created", "session.updated"]),
  workspaceId: z.string().min(1),
  session: z.object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string().nullable(),
    preview: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    runState: z.enum(["idle", "running", "stopping"]),
  }),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
