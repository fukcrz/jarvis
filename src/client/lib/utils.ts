import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { SessionAttentionState, SessionSummary } from "../../shared/protocol";

export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}

/**
 * RFC 4122 v4 UUID。crypto.randomUUID 仅在安全上下文（HTTPS/localhost）可用，
 * 局域网 HTTP 访问时不存在，这里提供兼容兜底。
 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function sessionLabel(name: string | null, preview: string | null): string {
  return name?.trim() || preview?.trim().replace(/\s+/g, " ").slice(0, 72) || "新会话";
}

/**
 * 解析输入框里的 bang 命令：`!cmd` 输出进上下文，`!!cmd` 不进。
 * 返回 undefined 表示这不是一条命令（与 Pi TUI 一致：单独的 `!` 按普通消息发送）。
 */
export function parseBashCommand(text: string): { command: string; excludeFromContext: boolean } | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("!")) return undefined;
  const excludeFromContext = trimmed.startsWith("!!");
  const command = trimmed.slice(excludeFromContext ? 2 : 1).trim();
  return command === "" ? undefined : { command, excludeFromContext };
}

/** 默认收起时最多显示的会话数量（执行中的会话超过该数量时以执行中的数量为准）。 */
export const SESSIONS_COLLAPSED_LIMIT = 5;

/** 点击一次“展开更多”追加显示的会话数量。 */
export const SESSIONS_PAGE_SIZE = 5;

/** 会话是否处于执行中（运行中或正在停止）。 */
export function isSessionRunning(session: SessionSummary): boolean {
  return session.runState === "running" || session.runState === "stopping";
}

export function sessionAttentionState(session: SessionSummary): SessionAttentionState {
  if (isSessionRunning(session)) return session.runState === "stopping" ? "running" : (session.attentionState === "waiting_interaction" ? "waiting_interaction" : "running");
  return session.attentionState ?? "idle";
}

export function sessionAttentionLabel(session: SessionSummary): string | undefined {
  const state = sessionAttentionState(session);
  if (state === "running") return session.runState === "stopping" ? "正在停止" : "执行中";
  if (state === "completed_unread") return "任务完成未查看";
  if (state === "failed") return "出错失败";
  if (state === "waiting_interaction") return "待交互";
  return undefined;
}

/** Higher-priority attention states are kept visible before ordinary sessions. */
export function sessionAttentionRank(session: SessionSummary): number {
  const state = sessionAttentionState(session);
  if (state === "waiting_interaction") return 0;
  if (state === "running") return 1;
  if (state === "failed") return 2;
  if (state === "completed_unread") return 3;
  return 4;
}

export interface SessionListWindow {
  /** 当前应展示的会话，需要关注的会话始终在前、保证可见。 */
  sessions: SessionSummary[];
  /** 是否还有未展示的会话（应显示“展开更多”）。 */
  hasMore: boolean;
  /** 是否已展开过（应显示“收起”）。 */
  expanded: boolean;
}

/**
 * 计算侧边栏中某个项目下的会话展示窗口：
 * - 需要关注的会话（待交互/执行中/失败/完成未查看）始终显示，且排在前面；
 * - 默认最多显示 SESSIONS_COLLAPSED_LIMIT 个，除非需要关注的会话超过该数量；
 * - 每次展开多显示 SESSIONS_PAGE_SIZE 个，可以多次展开直到全部显示；
 * - 收起（expandSteps 归零）后回到默认状态。
 */
export function sessionListWindow(sessions: SessionSummary[], expandSteps: number): SessionListWindow {
  const ordered = [...sessions].sort((a, b) => sessionAttentionRank(a) - sessionAttentionRank(b));
  const attentionCount = sessions.filter((s) => sessionAttentionRank(s) < 4).length;
  const collapsedCount = Math.max(SESSIONS_COLLAPSED_LIMIT, attentionCount);
  const visibleCount = collapsedCount + Math.max(0, expandSteps) * SESSIONS_PAGE_SIZE;
  return {
    sessions: ordered.slice(0, visibleCount),
    hasMore: ordered.length > visibleCount,
    expanded: expandSteps > 0,
  };
}

export function normalizeSessionSearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const normalizedQuery = normalizeSessionSearch(query);
  return normalizedQuery === "" || normalizeSessionSearch(sessionLabel(session.name, session.preview)).includes(normalizedQuery);
}

export function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))}m`;
  if (diff < 86_400_000) return `${String(Math.floor(diff / 3_600_000))}h`;
  if (diff < 604_800_000) return `${String(Math.floor(diff / 86_400_000))}d`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp));
}
