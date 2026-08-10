import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { SessionSummary } from "../../shared/protocol";

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
