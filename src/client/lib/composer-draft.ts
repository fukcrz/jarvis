import type { ImageAttachment } from "../../shared/protocol";
import { composerImageAttachments } from "./image";

export type ComposerDraftSyncAction = "skip" | "apply" | "defer";

/** Preserve text committed by an IME while a queue restore waits for compositionend. */
export function mergeDeferredComposerDraft(incoming: string, previous: string, current: string): string {
  if (previous !== "" && incoming.endsWith(previous)) return `${incoming.slice(0, -previous.length)}${current}`;
  if (previous === "" && incoming !== "" && current !== "") return `${incoming}\n\n${current}`;
  return incoming;
}

type QueuedDraftMessage = {
  text: string;
  images?: readonly ImageAttachment[];
};

export function mergeQueuedMessagesIntoDraft(
  messages: readonly QueuedDraftMessage[],
  currentDraft: string,
  currentAttachments: readonly ImageAttachment[],
): { draft: string; attachments: ImageAttachment[] } {
  const queuedAttachments = messages.flatMap((message) => composerImageAttachments(message.images));
  return {
    draft: [...messages.map((message) => message.text), currentDraft].filter((value) => value.trim() !== "").join("\n\n"),
    attachments: [...queuedAttachments, ...currentAttachments],
  };
}

/**
 * 组字尚未落定（含 compositionend 后仍带着 input.type.compose 的那次提交）。
 * 文档变化仍应更新发送按钮；不要回写 App 草稿、不要刷新补全。
 */
export function isComposerCompositionPending(input: {
  composing: boolean;
  composeTransaction: boolean;
}): boolean {
  return input.composing || input.composeTransaction;
}

/**
 * 输入框是否该被 App 草稿整段替换。
 *
 * 编辑器是非受控的：打字只通过 onChange 把文本交给 App。父组件随时会因
 * 时间线/套接字重渲染，此时 initialValue 可能落后于正在组字的文档。
 * 只有 App 显式改草稿（取回排队消息、停止恢复）并递增 nonce 才同步。
 *
 * Firefox + ibus 在 composition 期间改 contenteditable 会把刚确认的词再提交一次。
 */
export function composerDraftSyncAction(input: {
  nonceChanged: boolean;
  current: string;
  incoming: string;
  composing: boolean;
}): ComposerDraftSyncAction {
  if (!input.nonceChanged) return "skip";
  if (input.incoming === input.current) return "skip";
  if (input.composing) return "defer";
  return "apply";
}
