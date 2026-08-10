import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}

export function sessionLabel(name: string | null, preview: string | null): string {
  return name?.trim() || preview?.trim().replace(/\s+/g, " ").slice(0, 72) || "新会话";
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
