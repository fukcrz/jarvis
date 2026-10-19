import type { SubagentCallView, ToolTimelineItem } from "../../shared/protocol";

export interface TimelineFoldState {
  sessionKey?: string;
  openProcessIds: ReadonlySet<string>;
  openDetailIds: ReadonlySet<string>;
  closedDetailIds: ReadonlySet<string>;
  openThinkingIds: ReadonlySet<string>;
  openGroupIds: ReadonlySet<string>;
  touchedProcessIds: ReadonlySet<string>;
}

export function emptyTimelineFoldState(sessionKey?: string): TimelineFoldState {
  return {
    sessionKey,
    openProcessIds: new Set(),
    openDetailIds: new Set(),
    closedDetailIds: new Set(),
    openThinkingIds: new Set(),
    openGroupIds: new Set(),
    touchedProcessIds: new Set(),
  };
}

/** `currentlyOpen` 是界面上当前的开合状态（进行中的过程未经手动开合时默认展开）。 */
export function toggleTimelineProcess(state: TimelineFoldState, processId: string, currentlyOpen = state.openProcessIds.has(processId)): TimelineFoldState {
  const openProcessIds = new Set(state.openProcessIds);
  if (currentlyOpen) openProcessIds.delete(processId);
  else openProcessIds.add(processId);
  const touchedProcessIds = new Set(state.touchedProcessIds);
  touchedProcessIds.add(processId);
  return { ...state, openProcessIds, touchedProcessIds };
}

export function toggleTimelineDetail(state: TimelineFoldState, processId: string, detailId: string, parentShowingAll: boolean): TimelineFoldState {
  const openDetailIds = new Set(state.openDetailIds);
  if (!parentShowingAll || !openDetailIds.has(detailId)) openDetailIds.add(detailId);
  else openDetailIds.delete(detailId);
  return { ...state, openDetailIds };
}

export function activityGroupId(itemId: string): string {
  return `group:${itemId}`;
}

/** Thinking blocks start open while streaming, but a manual close must survive new tokens. */
export function toggleTimelineThinking(state: TimelineFoldState, detailId: string, currentlyOpen: boolean): TimelineFoldState {
  const closedDetailIds = new Set(state.closedDetailIds);
  const openThinkingIds = new Set(state.openThinkingIds);
  if (currentlyOpen) {
    closedDetailIds.add(detailId);
    openThinkingIds.delete(detailId);
  } else {
    closedDetailIds.delete(detailId);
    openThinkingIds.add(detailId);
  }
  return { ...state, closedDetailIds, openThinkingIds };
}

export function toggleTimelineGroup(state: TimelineFoldState, processId: string, groupId: string): TimelineFoldState {
  const openGroupIds = new Set(state.openGroupIds);
  if (openGroupIds.has(groupId)) openGroupIds.delete(groupId);
  else openGroupIds.add(groupId);
  return { ...state, openGroupIds };
}

export function collapseUntouchedTimelineProcess(state: TimelineFoldState, processId: string): TimelineFoldState {
  if (state.touchedProcessIds.has(processId) || !state.openProcessIds.has(processId)) return state;
  const openProcessIds = new Set(state.openProcessIds);
  openProcessIds.delete(processId);
  return { ...state, openProcessIds };
}

/** A tool row remains mounted while its parent process is folded. */
export function collapsedToolActivityItems(items: ToolTimelineItem[], active: boolean, showActivePreview: boolean): ToolTimelineItem[] {
  return items.filter((item) => item.state === "failed"
    || (item.subagent?.failed ?? 0) > 0
    || showActivePreview && active && (item.state === "running" || item.state === "queued"));
}

export function visibleToolActivityItemIds(items: ToolTimelineItem[], active: boolean, showActivePreview: boolean): ReadonlySet<string> {
  return new Set(collapsedToolActivityItems(items, active, showActivePreview).map((item) => item.id));
}

/** Stable within one tool call even when the result list is regrouped or reordered. */
export function subagentCallDetailId(toolId: string, call: SubagentCallView, duplicateIndex = 0): string {
  const handle = call.sessionHandle?.trim();
  const identity = call.callIndex !== undefined
    ? `index:${String(call.callIndex)}`
    : handle === undefined || handle === ""
      ? `legacy:${[call.agent, call.prompt, call.model ?? ""].join("\u0000")}`
      : `session:${handle}`;
  return `subagent-call:${toolId}:${identity}${duplicateIndex === 0 ? "" : `:duplicate:${String(duplicateIndex)}`}`;
}
