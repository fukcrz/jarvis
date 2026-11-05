import type { SubagentCallView, ToolTimelineItem } from "../../shared/protocol";

export interface TimelineFoldState {
  sessionKey?: string;
  openProcessIds: ReadonlySet<string>;
  openDetailIds: ReadonlySet<string>;
  closedDetailIds: ReadonlySet<string>;
  openGroupIds: ReadonlySet<string>;
  closedGroupIds: ReadonlySet<string>;
  touchedProcessIds: ReadonlySet<string>;
}

export function emptyTimelineFoldState(sessionKey?: string): TimelineFoldState {
  return {
    sessionKey,
    openProcessIds: new Set(),
    openDetailIds: new Set(),
    closedDetailIds: new Set(),
    openGroupIds: new Set(),
    closedGroupIds: new Set(),
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

export function toggleTimelineDetail(state: TimelineFoldState, processId: string, detailId: string, currentlyOpen: boolean): TimelineFoldState {
  const openDetailIds = new Set(state.openDetailIds);
  const closedDetailIds = new Set(state.closedDetailIds);
  if (currentlyOpen) {
    openDetailIds.delete(detailId);
    closedDetailIds.add(detailId);
  } else {
    openDetailIds.add(detailId);
    closedDetailIds.delete(detailId);
  }
  return { ...state, openDetailIds, closedDetailIds };
}

export function activityGroupId(itemId: string): string {
  return `group:${itemId}`;
}

export function toggleTimelineGroup(state: TimelineFoldState, processId: string, groupId: string, currentlyCollapsed: boolean): TimelineFoldState {
  const openGroupIds = new Set(state.openGroupIds);
  const closedGroupIds = new Set(state.closedGroupIds);
  if (currentlyCollapsed) {
    openGroupIds.add(groupId);
    closedGroupIds.delete(groupId);
  } else {
    openGroupIds.delete(groupId);
    closedGroupIds.add(groupId);
  }
  return { ...state, openGroupIds, closedGroupIds };
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
    || (item.subagent?.running ?? 0) > 0
    || showActivePreview && active && (item.state === "running" || item.state === "queued"));
}

export function visibleToolActivityItemIds(items: ToolTimelineItem[], active: boolean, showActivePreview: boolean): ReadonlySet<string> {
  return new Set(collapsedToolActivityItems(items, active, showActivePreview).map((item) => item.id));
}


