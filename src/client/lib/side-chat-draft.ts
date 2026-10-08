import type { ImageAttachment, SessionRef } from "../../shared/protocol";
import { mergeQueuedMessagesIntoDraft } from "./composer-draft";

export interface SideChatDraft {
  draft: string;
  attachments: ImageAttachment[];
}

export interface SideChatQueuedMessage {
  text: string;
  images?: readonly ImageAttachment[];
}

export function sideChatDraftKey(ref: SessionRef): string {
  return `${ref.workspaceId}:${ref.sessionId}`;
}

export function mergeQueuedMessagesIntoSideChatDrafts(
  drafts: ReadonlyMap<string, SideChatDraft>,
  targetRef: SessionRef,
  messages: readonly SideChatQueuedMessage[],
): Map<string, SideChatDraft> {
  const next = new Map(drafts);
  const key = sideChatDraftKey(targetRef);
  const current = drafts.get(key);
  next.set(key, mergeQueuedMessagesIntoDraft(messages, current?.draft ?? "", current?.attachments ?? []));
  return next;
}
