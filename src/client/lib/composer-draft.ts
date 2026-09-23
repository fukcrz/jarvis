export type ComposerDraftSyncAction = "skip" | "apply" | "defer";

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
