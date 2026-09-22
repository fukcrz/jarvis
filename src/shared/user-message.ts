import type { TimelineItem, UserMessageOutline } from "./protocol.js";

export const USER_MESSAGE_PREVIEW_MAX = 110;
export const DEFAULT_EARLIER_PAGE_LIMIT = 120;
export const MAX_EARLIER_PAGE_LIMIT = 500;

export function userMessagePreview(item: { text: string; images?: readonly unknown[] }): string {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text !== "") return text.length > USER_MESSAGE_PREVIEW_MAX ? `${text.slice(0, USER_MESSAGE_PREVIEW_MAX - 3)}…` : text;
  return (item.images?.length ?? 0) > 0 ? "图片消息" : "空消息";
}

export function userMessageOutline(items: readonly TimelineItem[]): UserMessageOutline[] {
  const messages: UserMessageOutline[] = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (item?.kind !== "message" || item.role !== "user") continue;
    messages.push({ id: item.id, preview: userMessagePreview(item), itemIndex });
  }
  return messages;
}

export function appendUserMessageOutline(
  outline: UserMessageOutline[],
  message: { id: string; text: string; images?: readonly unknown[] },
  itemIndex: number,
): UserMessageOutline[] {
  if (outline.some((entry) => entry.id === message.id)) return outline;
  return [...outline, { id: message.id, preview: userMessagePreview(message), itemIndex }];
}

export function earlierPageLimit(
  currentStart: number,
  targetItemIndex?: number,
  maxLimit = MAX_EARLIER_PAGE_LIMIT,
  defaultLimit = DEFAULT_EARLIER_PAGE_LIMIT,
): number {
  if (targetItemIndex === undefined || !Number.isFinite(targetItemIndex) || targetItemIndex >= currentStart) return defaultLimit;
  return Math.min(maxLimit, Math.max(1, Math.floor(currentStart - targetItemIndex)));
}
