import type { MessageTimelineItem, QueuedMessage, RetryStatus, SessionRef, SessionSummary, ThinkingLevel, TimelineItem } from "../shared/protocol.js";
import { isRecord } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";
import { isUnsupportedExtensionInteraction, UNSUPPORTED_EXTENSION_INTERACTION } from "./extension-ui.js";
import { projectHistory } from "./projection.js";
import { stringValue } from "./values.js";

export function activeKey(ref: SessionRef): string {
  return `${ref.workspaceId}:${ref.sessionId}`;
}

/** pi-subagent uses this namespace for persistent child-agent sessions. */
export function isVisibleSessionId(sessionId: string): boolean {
  return !sessionId.startsWith("subagent.");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryStatus(attempt: number, maxAttempts: number, delayMs: number, errorMessage: string): RetryStatus {
  return {
    attempt,
    maxAttempts,
    delayMs,
    retryAt: new Date(Date.now() + delayMs).toISOString(),
    errorMessage,
  };
}

export function isCompactionCancellation(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return asMessage(error) === "Compaction cancelled";
}

export function sameThinkingLevels(left: readonly ThinkingLevel[], right: readonly ThinkingLevel[]): boolean {
  return left.length === right.length && left.every((level, index) => level === right[index]);
}

/** 稳定 id：同一文本重复排队也保持独立条目。 */
export function queuedMessage(kind: "steer" | "followUp", text: string): QueuedMessage {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  const createdAt = new Date().toISOString();
  return { id: `${kind}:${hash.toString(36)}:${createdAt}`, kind, text, createdAt };
}

/** 增量合并：按顺序复用已有条目（文本相同）以保持 id 稳定，新增/剩余条目补全新 id。 */
export function mergeQueuedMessages(previous: QueuedMessage[], current: readonly string[], kind: "steer" | "followUp"): QueuedMessage[] {
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

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

export function expandToUserBoundary(items: TimelineItem[], start: number): number {
  if (start === 0 || items[start]?.kind === "message" && items[start].role === "user") return start;
  for (let index = start - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "message" && item.role === "user") return index;
  }
  return 0;
}

export function findVisibleMessageEntryId(entries: readonly unknown[], messageId: string): string | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const projected = projectHistory([entry]).find((item): item is MessageTimelineItem => item.kind === "message");
    if (projected?.id === messageId) return stringValue(entry["id"]) || undefined;
  }
  return undefined;
}

/**
 * Fork point for session-level forking.
 * Idle sessions copy every message on the branch (including the last assistant reply).
 * While running, the latest user message starts the in-flight turn, so back off
 * to its parent — the branch never contains in-progress content, only the last settled turn.
 */
export function sessionForkEntryId(branch: readonly unknown[], running: boolean): string | undefined {
  if (!running) {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (!isRecord(entry) || entry["type"] !== "message") continue;
      const id = stringValue(entry["id"]);
      return id === "" ? undefined : id;
    }
    return undefined;
  }
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message) || message["role"] !== "user") continue;
    const parentId = entry["parentId"];
    return typeof parentId === "string" ? parentId : undefined;
  }
  return undefined;
}

export function findUserMessageEntry(entries: readonly unknown[], messageId: string): Record<string, unknown> | undefined {
  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message) || message["role"] !== "user") continue;
    const projected = projectHistory([entry]).find((item): item is MessageTimelineItem => item.kind === "message");
    if (projected?.id === messageId) return entry;
  }
  return undefined;
}

export function firstUserMessage(entries: readonly unknown[]): string | null {
  const history = projectHistory(entries);
  return history.find((item): item is MessageTimelineItem => item.kind === "message" && item.role === "user")?.text ?? null;
}

/** 内存中活跃会话的全文检索文本：名称 + 首条消息 + 全部 user/assistant 消息文本。 */
export function sessionBranchSearchText(name: string | null, preview: string | null, entries: readonly unknown[]): string {
  const text = projectHistory(entries)
    .filter((item): item is MessageTimelineItem => item.kind === "message")
    .map((item) => item.text)
    .join("\n");
  return `${name ?? ""}\n${preview ?? ""}\n${text}`;
}

/** 命中关键词时提取其周围上下文（±48 字符），用于搜索结果中展示命中原因。 */
export function snippetAround(text: string, needle: string, radius = 48): string | undefined {
  const index = text.toLocaleLowerCase().indexOf(needle);
  if (index < 0) return undefined;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  const piece = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${piece}${end < text.length ? "…" : ""}`;
}

/** 搜索结果附带命中片段（非搜索响应保持原样，不污染普通列表数据）。 */
export function attachSearchSnippet(summary: SessionSummary, searchText: string, needle: string | undefined): SessionSummary {
  if (needle === undefined || needle === "") return summary;
  const snippet = snippetAround(searchText, needle);
  return snippet === undefined ? summary : { ...summary, matchSnippet: snippet };
}

export function decodeImageData(mimeType: string, data: string): { mimeType: string; bytes: Buffer } {
  const bytes = Buffer.from(data.includes(",") ? data.slice(data.indexOf(",") + 1) : data, "base64");
  if (bytes.length === 0) throw new AppError("MEDIA_NOT_FOUND", "Image not found", 404);
  return { mimeType, bytes };
}

export function runtimeFailureCode(error: unknown): string {
  return isUnsupportedExtensionInteraction(error) ? UNSUPPORTED_EXTENSION_INTERACTION : "PI_RUNTIME_ERROR";
}

export function isOperationCancellation(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = asMessage(error);
  return message === "Operation aborted" || message === "This operation was aborted";
}

export function isAssistantMessage(message: unknown): message is { role: "assistant"; content: unknown; timestamp?: number | string } {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)["role"] === "assistant";
}

export function isUserMessage(message: unknown): message is { role: "user"; content: unknown; timestamp?: number | string } {
  return typeof message === "object" && message !== null && (message as Record<string, unknown>)["role"] === "user";
}
