import type { ModelDescriptor, ThinkingLevel } from "../shared/protocol";

export function modelKey(model: Pick<ModelDescriptor, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}

/**
 * 下一个 / 上一个启用的模型，超出范围回绕；仅启用（inScope）的模型参与循环，
 * 对齐 PI TUI 的 app.model.cycleForward / app.model.cycleBackward。
 *
 * 当前模型不在启用列表（被禁用但仍选中）时：正向从第一个启用模型开始，
 * 反向从最后一个启用模型开始。少于两个启用模型时返回 undefined（无事可循环）。
 */
export function cycleModelCandidate(
  available: ModelDescriptor[],
  current: ModelDescriptor | undefined,
  direction: 1 | -1,
): ModelDescriptor | undefined {
  const enabled = available.filter((candidate) => candidate.inScope);
  if (enabled.length <= 1) return undefined;
  let index = current === undefined ? -1 : enabled.findIndex((candidate) => modelKey(candidate) === modelKey(current));
  if (index === -1) index = direction === 1 ? -1 : enabled.length;
  return enabled[(index + direction + enabled.length) % enabled.length];
}

/**
 * 下一个思考等级，超出范围回绕；对齐 PI TUI 的 app.thinking.cycle。
 * 当前等级不在可用列表时从第一个开始。少于两个等级时返回 undefined。
 */
export function cycleThinkingCandidate(
  available: ThinkingLevel[],
  current: ThinkingLevel,
): ThinkingLevel | undefined {
  if (available.length <= 1) return undefined;
  const index = available.indexOf(current);
  return available[(index + 1) % available.length];
}
