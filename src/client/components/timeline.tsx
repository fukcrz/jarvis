import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Archive, ArrowDown, Bell, Check, ChevronRight, CircleAlert, Clock3, Copy, GitBranch, LoaderCircle, Pencil, RefreshCw, X, XCircle } from "lucide-react";
import type { AssistantGenerationStats, ContextSummaryTimelineItem, FileChange, ErrorTimelineItem, ExtensionUiRequest, ExtensionUiTimelineItem, LiveGenerationStats, MessageTimelineItem, SessionStatus, ThinkingTimelineItem, TimelineItem, ToolTimelineItem, UserMessageOutline } from "../../shared/protocol";
import { userMessageOutline as outlineFromItems } from "../../shared/user-message";
import { plainErrorReason } from "../lib/error-reason";
import { formatRunElapsed, getRunFeedback, getRunStatusActivity, type RunFeedback, type RunStatusActivity } from "../run-feedback";
import { copyText } from "../lib/clipboard";
import { imageDataUrl } from "../lib/image";
import { LocalMediaVersionContext } from "../lib/local-media";
import { encodeMultiSelectValue, multiSelectAnswerLabel, parseMultiSelectDialog, parseSelectDialog, previewSummary, selectAnswerLabel, selectDialogTitle, settledMultiRows, settledSelectRows, splitDialogHeading, type ExtensionSelectOption, type SettledChoiceRow } from "../lib/extension-dialog";
import { MarkdownMessage } from "./markdown-message";
import { ImagePreview } from "./image-lightbox";
import { commandHeadline, summarizeToolActivity, ToolActivity } from "./tool-activity";
import { DiffStat, DiffView } from "./diff-view";
import { LocalTextFileLink } from "./text-file-preview";
import { mergeFileChanges } from "../../shared/file-change";
import { activityGroupId, collapseUntouchedTimelineProcess, emptyTimelineFoldState, toggleTimelineDetail, toggleTimelineGroup, toggleTimelineProcess, visibleToolActivityItemIds, type TimelineFoldState } from "./timeline-fold";
import { Dialog, DialogContent } from "./ui/dialog";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { useIsMobile } from "../hooks/use-is-mobile";

interface TimelineProps {
  sessionKey?: string;
  localMediaVersion?: string;
  items: TimelineItem[];
  streamingMessageId?: string;
  liveGeneration?: LiveGenerationStats;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  /** Connection/hydration issue, distinct from a failed Pi run. */
  error?: string;
  /** Short-lived recoverable state-race feedback. */
  notice?: string;
  onDismissNotice?: () => void;
  status: SessionStatus;
  onRetryCompaction?: () => void;
  /** 失败后重新发送这一轮的用户消息。 */
  onRetryTurn?: (user: MessageTimelineItem) => void;
  /** 失败后发一句「继续」。 */
  onContinue?: () => void;
  /** 「被中断」卡片点「知道了」：服务端清掉标记，下次打开不再显示。 */
  onDismissInterrupted?: () => void;
  onEditUserMessage?: (item: MessageTimelineItem) => void;
  onForkMessage?: (item: MessageTimelineItem) => void;
  onExtensionUiRespond?: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void | Promise<void>;
  /** 当前工作区根目录：渲染 AI 回复中的相对路径图片时作为基准。 */
  workspaceCwd?: string;
  navigatorOpen?: boolean;
  onNavigatorOpenChange?: (open: boolean) => void;
  outline?: UserMessageOutline[];
  outlineLoading?: boolean;
  onEnsureMessage?: (id: string) => Promise<void>;
}

/** Distance from the bottom (px) within which the list is considered "following" the latest content. */
const NEAR_BOTTOM_PX = 72;
/** Hide the jump-to-latest control while the list is still close to the bottom. */
const JUMP_LATEST_PX = 300;
/** Keep the jump-to-latest control above the composer dock. */
const JUMP_LATEST_DOCK_GAP_PX = 12;
/** On mobile, preserve the expanded editor's vertical space over the jump control. */
const MOBILE_COMPOSER_HIDE_PX = 140;
/** Load the preceding page just before the user reaches the start of the timeline. */
const HISTORY_LOAD_TOP_PX = 72;

/**
 * Break auto-follow as soon as the user starts a scroll-away gesture.
 * Relying on onScroll alone is too slow while streaming: content updates re-pin
 * scrollTop = scrollHeight in useLayoutEffect before the user can clear the
 * NEAR_BOTTOM_PX dead zone, so the first stretch of scrolling fights the auto-scroll.
 */
export function shouldStopFollowingOnGesture(element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">, deltaY: number): boolean {
  // deltaY < 0 means scrolling up. Do not leave follow mode when there is no
  // actual vertical range, or when the viewport cannot move farther upward.
  return deltaY < 0 && element.scrollHeight > element.clientHeight && element.scrollTop > 0;
}

export function shouldLoadEarlierAtTop(element: Pick<HTMLElement, "scrollTop">, hasMore: boolean, loadingMore: boolean): boolean {
  return hasMore && !loadingMore && element.scrollTop <= HISTORY_LOAD_TOP_PX;
}

/** True when the viewport is close enough to the latest content to resume auto-follow. */
export function isFollowingLatest(element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">, thresholdPx = NEAR_BOTTOM_PX): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < thresholdPx;
}

/** True when the jump-to-latest control should be visible. */
export function shouldShowJumpLatest(element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">, thresholdPx = JUMP_LATEST_PX): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight > thresholdPx;
}

export function jumpLatestBottomForDock(shellBottom: number, dockTop: number, gapPx = JUMP_LATEST_DOCK_GAP_PX): number {
  return Math.max(0, shellBottom - dockTop + gapPx);
}

export function shouldHideJumpLatestForComposer(isMobile: boolean, composerHeight: number, thresholdPx = MOBILE_COMPOSER_HIDE_PX): boolean {
  return isMobile && composerHeight > thresholdPx;
}

function stopFollowingOnGesture(element: HTMLDivElement, setFollowing: (value: boolean) => void, deltaY: number) {
  if (shouldStopFollowingOnGesture(element, deltaY)) setFollowing(false);
}

export interface UserMessageAnchor {
  id: string;
  index: number;
  preview: string;
  itemIndex?: number;
}

export function userMessageAnchorsFromOutline(messages: UserMessageOutline[]): UserMessageAnchor[] {
  return messages.map((message, index) => ({ id: message.id, index: index + 1, preview: message.preview, itemIndex: message.itemIndex }));
}

/** Build the prompt-only outline shared by desktop rail and mobile turn list. */
export function userMessageAnchors(items: TimelineItem[]): UserMessageAnchor[] {
  return userMessageAnchorsFromOutline(outlineFromItems(items));
}

/** Newest user message first, keeping chronological indexes. */
export function mobileUserMessageRows(anchors: UserMessageAnchor[]): UserMessageAnchor[] {
  return [...anchors].reverse();
}

export function activeUserMessageAnchor(anchors: UserMessageAnchor[], activeId?: string): UserMessageAnchor | undefined {
  return anchors.find((anchor) => anchor.id === activeId) ?? anchors.at(-1);
}

export function formatUserMessageIndex(index: number): string {
  return String(index).padStart(2, "0");
}

export function visibleNavigatorAnchorIds(anchors: UserMessageAnchor[], activeId: string | undefined, radius = 2): Set<string> {
  if (anchors.length <= radius * 2 + 3) return new Set(anchors.map((anchor) => anchor.id));
  const activeIndex = Math.max(0, anchors.findIndex((anchor) => anchor.id === activeId));
  const visible = new Set([anchors[0]!.id, anchors.at(-1)!.id]);
  for (let index = Math.max(0, activeIndex - radius); index <= Math.min(anchors.length - 1, activeIndex + radius); index += 1) visible.add(anchors[index]!.id);
  return visible;
}

export function Timeline({ sessionKey, localMediaVersion, items, streamingMessageId, liveGeneration, hasMore, loadingMore, onLoadMore, error, notice, onDismissNotice, status, onRetryCompaction, onRetryTurn, onContinue, onDismissInterrupted, onEditUserMessage, onForkMessage, onExtensionUiRespond, workspaceCwd, navigatorOpen = false, onNavigatorOpenChange, outline, outlineLoading = false, onEnsureMessage }: TimelineProps) {
  const [foldState, setFoldState] = useState<TimelineFoldState>(() => emptyTimelineFoldState(sessionKey));
  const foldStateForRender = foldState.sessionKey === sessionKey ? foldState : emptyTimelineFoldState(sessionKey);
  const turns = useMemo(() => groupTimelineTurns(items), [items]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchYRef = useRef<number | undefined>(undefined);
  const loadingEarlierRef = useRef(false);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const activeNavigationTimerRef = useRef<number | undefined>(undefined);
  const activeNavigationIdRef = useRef<string | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const [jumpLatestBottom, setJumpLatestBottom] = useState<number>();
  const [hideJumpLatestForComposer, setHideJumpLatestForComposer] = useState(false);
  const followingRef = useRef(following);
  followingRef.current = following;
  const onEditUserMessageRef = useRef(onEditUserMessage);
  const onForkMessageRef = useRef(onForkMessage);
  const onExtensionUiRespondRef = useRef(onExtensionUiRespond);
  onEditUserMessageRef.current = onEditUserMessage;
  onForkMessageRef.current = onForkMessage;
  onExtensionUiRespondRef.current = onExtensionUiRespond;
  const stableOnEditUserMessage = useCallback((item: MessageTimelineItem) => {
    onEditUserMessageRef.current?.(item);
  }, []);
  const stableOnForkMessage = useCallback((item: MessageTimelineItem) => {
    onForkMessageRef.current?.(item);
  }, []);
  const stableOnExtensionUiRespond = useCallback((id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => onExtensionUiRespondRef.current?.(id, response), []);
  const [activeUserMessageId, setActiveUserMessageId] = useState<string>();
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [markerPositions, setMarkerPositions] = useState<Record<string, number>>({});
  const [pendingJumpId, setPendingJumpId] = useState<string>();
  const pendingJumpIdRef = useRef<string | undefined>(undefined);
  const [fillingViewport, setFillingViewport] = useState(false);
  const [fillViewportRevision, setFillViewportRevision] = useState(0);
  const isMobile = useIsMobile();
  const activeProcessId = status.runState === "idle" ? undefined : timelineProcessId(turns.at(-1));
  const previousActiveProcessRef = useRef<{ sessionKey?: string; processId?: string }>({ sessionKey, processId: activeProcessId });
  const toggleProcess = useCallback((processId: string, open: boolean) => {
    setFoldState((current) => toggleTimelineProcess(current.sessionKey === sessionKey ? current : emptyTimelineFoldState(sessionKey), processId, open));
  }, [sessionKey]);
  const toggleDetail = useCallback((processId: string, detailId: string, parentShowingAll: boolean) => {
    setFoldState((current) => toggleTimelineDetail(current.sessionKey === sessionKey ? current : emptyTimelineFoldState(sessionKey), processId, detailId, parentShowingAll));
  }, [sessionKey]);
  const toggleGroup = useCallback((processId: string, groupId: string) => {
    setFoldState((current) => toggleTimelineGroup(current.sessionKey === sessionKey ? current : emptyTimelineFoldState(sessionKey), processId, groupId));
  }, [sessionKey]);
  useEffect(() => {
    setFoldState((current) => current.sessionKey === sessionKey ? current : emptyTimelineFoldState(sessionKey));
  }, [sessionKey]);
  useEffect(() => {
    const previous = previousActiveProcessRef.current;
    previousActiveProcessRef.current = { sessionKey, processId: activeProcessId };
    if (previous.sessionKey !== sessionKey || previous.processId === undefined || previous.processId === activeProcessId) return;
    setFoldState((current) => collapseUntouchedTimelineProcess(current.sessionKey === sessionKey ? current : emptyTimelineFoldState(sessionKey), previous.processId!));
  }, [activeProcessId, sessionKey]);
  const userMessages = useMemo(() => {
    if (outline !== undefined && outline.length > 0) return userMessageAnchorsFromOutline(outline);
    if (outlineLoading) return [];
    return userMessageAnchors(items);
  }, [outline, outlineLoading, items]);
  const userMessageKey = userMessages.map((item) => item.id).join(":");
  const feedback = getRunFeedback(status, items, streamingMessageId);
  const runActivity = getRunStatusActivity(status, items, streamingMessageId);
  // 点过「知道了」的被中断卡片先在本地藏起来；服务端清标记失败也不再打扰。
  const [dismissedFailureKey, setDismissedFailureKey] = useState<string>();
  const failureKey = status.lastError === undefined ? undefined : `${sessionKey}:${status.lastError.code}:${status.lastError.occurredAt}`;
  const failureDismissed = failureKey !== undefined && failureKey === dismissedFailureKey;
  const hasMatchingTimelineFailure = status.lastError !== undefined && (turns.at(-1)?.finalError !== undefined || items.some((item) => item.kind === "error" && item.state === "failed" && item.code === status.lastError!.code && item.message === status.lastError!.message));
  const statusIndicatorKey = `${status.runState}:${status.compacting?.reason ?? ""}:${status.compacting?.retrying?.retryAt ?? ""}:${status.retrying?.retryAt ?? ""}:${status.lastError?.occurredAt ?? ""}:${error ?? ""}:${notice ?? ""}`;

  useLayoutEffect(() => {
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    if (activeNavigationTimerRef.current !== undefined) window.clearTimeout(activeNavigationTimerRef.current);
    activeNavigationIdRef.current = undefined;
    loadingEarlierRef.current = false;
    // The component is now reused across sessions. Reset the imperative scroll
    // state as well as React state, otherwise an old scrolled-up session can
    // leave the newly selected session stranded at its previous offset.
    followingRef.current = true;
    if (scrollRef.current !== null) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    setFollowing(true);
    setShowJumpLatest(false);
    setHighlightedMessageId(undefined);
    setActiveUserMessageId(undefined);
    setMarkerPositions({});
    pendingJumpIdRef.current = undefined;
    setPendingJumpId(undefined);
  }, [sessionKey]);

  const updateActiveUserMessage = () => {
    const element = scrollRef.current;
    if (element === null) return;
    const navigationId = activeNavigationIdRef.current;
    if (navigationId !== undefined) {
      setActiveUserMessageId((current) => current === navigationId ? current : navigationId);
      return;
    }
    const rootRect = element.getBoundingClientRect();
    const threshold = rootRect.top + element.clientHeight * 0.36;
    const messages = Array.from(element.querySelectorAll<HTMLElement>("[data-user-message-id]"));
    let nextId = messages[0]?.dataset.userMessageId;
    for (const message of messages) {
      if (message.getBoundingClientRect().top > threshold) break;
      nextId = message.dataset.userMessageId;
    }
    setActiveUserMessageId((current) => current === nextId ? current : nextId);
  };

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const updateNavigatorLayout = () => {
      const rootRect = element.getBoundingClientRect();
      const scrollRange = Math.max(1, element.scrollHeight - element.clientHeight);
      const nextPositions: Record<string, number> = {};
      for (const message of Array.from(element.querySelectorAll<HTMLElement>("[data-user-message-id]"))) {
        const id = message.dataset.userMessageId;
        if (id === undefined) continue;
        const targetTop = message.getBoundingClientRect().top - rootRect.top + element.scrollTop - element.clientHeight * 0.28;
        nextPositions[id] = Math.min(1, Math.max(0, targetTop / scrollRange));
      }
      setMarkerPositions((current) => {
        const same = Object.keys(current).length === Object.keys(nextPositions).length && Object.entries(nextPositions).every(([id, position]) => Math.abs((current[id] ?? -1) - position) < 0.002);
        return same ? current : nextPositions;
      });
      updateActiveUserMessage();
    };
    const frame = requestAnimationFrame(updateNavigatorLayout);
    const observer = new ResizeObserver(() => requestAnimationFrame(updateNavigatorLayout));
    observer.observe(element);
    const feed = element.querySelector(".timeline-feed");
    if (feed !== null) observer.observe(feed);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [userMessageKey]);

  useEffect(() => {
    setActiveUserMessageId((current) => userMessages.some((item) => item.id === current) ? current : userMessages[0]?.id);
  }, [userMessageKey, userMessages]);

  useEffect(() => () => {
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    if (activeNavigationTimerRef.current !== undefined) window.clearTimeout(activeNavigationTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const shell = element.closest<HTMLElement>(".timeline-shell");
    if (shell === null) return;
    const stage = element.closest<HTMLElement>(".chat-stage");
    if (stage === null) return;
    const dock = stage.querySelector<HTMLElement>(".chat-dock");
    if (dock === null) return;
    const updateDockLayout = () => {
      const shellRect = shell.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      stage.style.setProperty("--chat-dock-space", `${String(Math.ceil(dockRect.height + 18))}px`);
      if (followingRef.current) element.scrollTop = element.scrollHeight;
      const composerEditor = dock.querySelector<HTMLElement>(".composer-editor");
      const composerTop = composerEditor?.getBoundingClientRect().top ?? dockRect.top;
      stage.style.setProperty("--timeline-navigator-bottom", `${String(Math.max(42, Math.ceil(shellRect.bottom - composerTop + 28)))}px`);
      const nextBottom = jumpLatestBottomForDock(shellRect.bottom, dockRect.top);
      const nextHide = shouldHideJumpLatestForComposer(isMobile, composerEditor?.getBoundingClientRect().height ?? 0);
      setJumpLatestBottom((current) => current === nextBottom ? current : nextBottom);
      setHideJumpLatestForComposer((current) => current === nextHide ? current : nextHide);
    };
    updateDockLayout();
    const observer = new ResizeObserver(updateDockLayout);
    observer.observe(shell);
    observer.observe(dock);
    window.addEventListener("resize", updateDockLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateDockLayout);
      stage.style.removeProperty("--chat-dock-space");
      stage.style.removeProperty("--timeline-navigator-bottom");
    };
  }, [isMobile]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    // Pin only when content/status changes while already following. Entering the
    // near-bottom zone via user scroll must not jump the remaining distance.
    if (element === null) return;
    if (!followingRef.current) {
      setShowJumpLatest(shouldShowJumpLatest(element));
      return;
    }
    element.scrollTop = element.scrollHeight;
    setShowJumpLatest(false);
  }, [items, streamingMessageId, feedback?.label, statusIndicatorKey]);

  const loadEarlier = async () => {
    if (!hasMore || loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    const element = scrollRef.current;
    const offset = element === null ? 0 : element.scrollHeight - element.scrollTop;
    try {
      await onLoadMore();
    } finally {
      requestAnimationFrame(() => {
        if (scrollRef.current === element && element !== null) {
          element.scrollTop = element.scrollHeight - offset;
          setShowJumpLatest(shouldShowJumpLatest(element));
        }
        loadingEarlierRef.current = false;
        setFillViewportRevision((value) => value + 1);
      });
    }
  };

  const loadWhenNearTop = (element: HTMLDivElement) => {
    if (!shouldLoadEarlierAtTop(element, hasMore, loadingMore)) return;
    setFillingViewport(true);
    void loadEarlier().catch(() => setFillingViewport(false));
  };

  useEffect(() => {
    if (!fillingViewport) return;
    if (!hasMore) {
      setFillingViewport(false);
      return;
    }
    if (loadingMore || loadingEarlierRef.current) return;
    const element = scrollRef.current;
    if (element === null || element.scrollHeight > element.clientHeight) {
      setFillingViewport(false);
      return;
    }
    void loadEarlier().catch(() => setFillingViewport(false));
  }, [fillViewportRevision, fillingViewport, hasMore, loadingMore, loadEarlier]);

  const closeNavigator = () => onNavigatorOpenChange?.(false);

  const scrollUserMessageIntoView = (id: string) => {
    const element = scrollRef.current;
    const target = element === null ? undefined : Array.from(element.querySelectorAll<HTMLElement>("[data-user-message-id]")).find((item) => item.dataset.userMessageId === id);
    if (element === null || target === undefined) return false;
    const targetTop = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - Math.min(112, element.clientHeight * 0.22);
    element.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
    setActiveUserMessageId(id);
    return true;
  };

  const beginUserMessageNavigation = (id: string) => {
    activeNavigationIdRef.current = id;
    if (activeNavigationTimerRef.current !== undefined) window.clearTimeout(activeNavigationTimerRef.current);
    activeNavigationTimerRef.current = window.setTimeout(() => {
      activeNavigationIdRef.current = undefined;
      updateActiveUserMessage();
    }, 500);
    setFollowing(false);
    setActiveUserMessageId(id);
    setHighlightedMessageId(id);
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightedMessageId(undefined), 1_700);
  };

  const finishPendingJump = (id: string) => {
    if (pendingJumpIdRef.current !== id) return;
    pendingJumpIdRef.current = undefined;
    setPendingJumpId(undefined);
    closeNavigator();
    requestAnimationFrame(() => {
      scrollUserMessageIntoView(id);
    });
  };

  useLayoutEffect(() => {
    const id = pendingJumpIdRef.current;
    if (id === undefined || !items.some((item) => item.id === id)) return;
    finishPendingJump(id);
  }, [items, pendingJumpId]);

  const jumpToUserMessage = (id: string) => {
    beginUserMessageNavigation(id);
    if (items.some((item) => item.id === id)) {
      closeNavigator();
      requestAnimationFrame(() => {
        scrollUserMessageIntoView(id);
      });
      return;
    }
    if (onEnsureMessage === undefined) {
      closeNavigator();
      return;
    }
    pendingJumpIdRef.current = id;
    setPendingJumpId(id);
    void onEnsureMessage(id).then(() => {
      if (pendingJumpIdRef.current !== id) return;
      if (items.some((item) => item.id === id) || scrollUserMessageIntoView(id)) finishPendingJump(id);
    }).catch(() => {
      if (pendingJumpIdRef.current !== id) return;
      pendingJumpIdRef.current = undefined;
      setPendingJumpId(undefined);
    });
  };

  return (
    <section className={`timeline-shell${runActivity === undefined ? "" : " has-run-status"}`}>
      <TurnNavigator mobile={isMobile} anchors={userMessages} activeId={activeUserMessageId} markerPositions={markerPositions} loadingAll={(outlineLoading && userMessages.length === 0) || pendingJumpId !== undefined} open={navigatorOpen} onOpenChange={(open) => { if (open) onNavigatorOpenChange?.(true); else closeNavigator(); }} onJump={jumpToUserMessage} />
      <div className="timeline" ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(isFollowingLatest(element));
        setShowJumpLatest(shouldShowJumpLatest(element));
        updateActiveUserMessage();
        loadWhenNearTop(element);
      }} onWheel={(event) => {
        stopFollowingOnGesture(event.currentTarget, setFollowing, event.deltaY);
        if (event.deltaY < 0) loadWhenNearTop(event.currentTarget);
      }} onTouchStart={(event) => {
        touchYRef.current = event.touches[0]?.clientY;
      }} onTouchMove={(event) => {
        const previousY = touchYRef.current;
        const currentY = event.touches[0]?.clientY;
        touchYRef.current = currentY;
        if (previousY !== undefined && currentY !== undefined) {
          const deltaY = currentY - previousY;
          stopFollowingOnGesture(event.currentTarget, setFollowing, deltaY);
          if (deltaY < 0) loadWhenNearTop(event.currentTarget);
        }
      }}>
        <div className="timeline-inner">
          <div className="timeline-feed">
            {hasMore ? <button type="button" className="timeline-load-earlier" disabled={loadingMore} onClick={() => { void loadEarlier(); }}>{loadingMore ? "加载中" : "更早"}</button> : null}
            <LocalMediaVersionContext.Provider value={localMediaVersion}>
              {renderTimelineTurns(turns, streamingMessageId, liveGeneration, status, foldStateForRender, toggleProcess, toggleDetail, toggleGroup, onExtensionUiRespond === undefined ? undefined : stableOnExtensionUiRespond, onEditUserMessage === undefined ? undefined : stableOnEditUserMessage, onForkMessage === undefined ? undefined : stableOnForkMessage, workspaceCwd, highlightedMessageId, status.runState === "idle" ? onRetryTurn : undefined, status.runState === "idle" ? onContinue : undefined)}
            </LocalMediaVersionContext.Provider>
            {status.compacting === undefined ? null : <CompactingIndicator compacting={status.compacting} />}
            {status.retrying === undefined ? null : <RetryingIndicator retrying={status.retrying} />}
            {notice === undefined ? null : <div className="session-notice" role="status"><span>{notice}</span>{onDismissNotice === undefined ? null : <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={onDismissNotice}><X size={14} /></Button>}</div>}
            {error === undefined ? null : <div className="session-error" role="alert">{error}</div>}
            {status.lastError === undefined || hasMatchingTimelineFailure || failureDismissed ? null : <RunFailureCard failure={status.lastError} onRetryCompaction={onRetryCompaction} onDismiss={status.lastError.code !== "RUN_INTERRUPTED" ? undefined : () => { setDismissedFailureKey(failureKey); onDismissInterrupted?.(); }} onRetry={status.runState !== "idle" || onRetryTurn === undefined || turns.at(-1)?.user === undefined ? undefined : () => onRetryTurn(turns.at(-1)!.user!)} onContinue={status.runState === "idle" ? onContinue : undefined} />}
            {feedback === undefined || hasActiveActivity(items, status) ? null : <WorkingIndicator feedback={feedback} />}
          </div>
        </div>
      </div>
      {runActivity !== undefined && showJumpLatest && !hideJumpLatestForComposer ? <RunStatusBar activity={runActivity} startedAt={status.activeRun?.startedAt} bottom={jumpLatestBottom} onJump={() => {
        const element = scrollRef.current;
        if (element === null) return;
        const target = runActivityElement(element, runActivity);
        if (target === undefined) element.scrollTop = element.scrollHeight;
        else target.scrollIntoView({ block: "center", behavior: "smooth" });
        if (target === undefined || runActivity.target === "message") { setShowJumpLatest(false); setFollowing(true); }
      }} /> : null}
      {showJumpLatest && runActivity === undefined && !hideJumpLatestForComposer ? <Button variant="ghost" size="icon" className="jump-latest" style={jumpLatestBottom === undefined ? undefined : { bottom: `${String(jumpLatestBottom)}px` }} aria-label="跳转到最新消息" title="跳转到最新消息" onClick={() => { const element = scrollRef.current; if (element !== null) element.scrollTop = element.scrollHeight; setShowJumpLatest(false); setFollowing(true); }}><ArrowDown size={16} /></Button> : null}
    </section>
  );
}

function TurnNavigator({ mobile, anchors, activeId, markerPositions, loadingAll, open, onOpenChange, onJump }: { mobile: boolean; anchors: UserMessageAnchor[]; activeId?: string; markerPositions: Record<string, number>; loadingAll: boolean; open: boolean; onOpenChange: (open: boolean) => void; onJump: (id: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const active = activeUserMessageAnchor(anchors, activeId);
  useLayoutEffect(() => {
    if (!mobile || !open) return;
    // Wait for the dialog portal to mount before revealing the current message.
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(".timeline-mobile-navigator-item.active")?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId, anchors.length, mobile, open]);
  if (!mobile) {
    if (anchors.length === 0) return null;
    const visibleIds = visibleNavigatorAnchorIds(anchors, activeId);
    return <nav className="timeline-desktop-navigator" aria-label="用户消息导航">
      <span className="timeline-navigator-track" aria-hidden="true" />
      {anchors.map((anchor, index) => visibleIds.has(anchor.id) ? <button key={anchor.id} type="button" className={`timeline-navigator-marker${anchor.id === activeId ? " active" : ""}`} style={{ top: `calc(${String((markerPositions[anchor.id] ?? index / Math.max(1, anchors.length - 1)) * 100)}% - 14px)` }} aria-label={`跳转到第 ${String(anchor.index)} 条用户消息：${anchor.preview}`} aria-current={anchor.id === activeId ? "step" : undefined} onClick={() => onJump(anchor.id)}><span className="timeline-navigator-marker-dot" /><span className="timeline-navigator-preview"><small>第 {String(anchor.index)} 条用户消息</small><strong>{anchor.preview}</strong></span></button> : null)}
    </nav>;
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="用户消息" className="turn-navigator-dialog">
      {loadingAll && anchors.length === 0 ? <div className="timeline-mobile-navigator-status" role="status">加载中</div> : anchors.length === 0 ? <div className="timeline-mobile-navigator-empty">暂无用户消息</div> : <>
        {loadingAll ? <div className="timeline-mobile-navigator-status" role="status">加载中</div> : null}
        <div className="timeline-mobile-navigator-list" ref={listRef}>
          {mobileUserMessageRows(anchors).map((anchor) => <button key={anchor.id} type="button" className={`timeline-mobile-navigator-item${anchor.id === active?.id ? " active" : ""}`} aria-current={anchor.id === active?.id ? "true" : undefined} aria-label={`第 ${String(anchor.index)} 条用户消息`} onClick={() => onJump(anchor.id)}><span>{formatUserMessageIndex(anchor.index)}</span><strong>{anchor.preview}</strong></button>)}
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}

function ElapsedClock({ startedAt }: { startedAt?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const elapsed = formatRunElapsed(startedAt, now);
  if (elapsed === undefined) return null;
  return <time className="run-elapsed">{elapsed}</time>;
}

function runActivityElement(root: HTMLElement, activity: RunStatusActivity): HTMLElement | undefined {
  const selector = activity.target === "tool" ? ".tool-item.running, .tool-item.queued" : activity.target === "thinking" ? ".thinking-item.running" : activity.target === "message" ? ".message-row.streaming" : undefined;
  if (selector === undefined) return undefined;
  const found = root.querySelectorAll<HTMLElement>(selector);
  return found.length === 0 ? undefined : found[found.length - 1];
}

function RunStatusBar({ activity, startedAt, bottom, onJump }: { activity: RunStatusActivity; startedAt?: string; bottom?: number; onJump: () => void }) {
  return <button type="button" className="run-status-bar" style={bottom === undefined ? undefined : { bottom: `${String(bottom)}px` }} onClick={onJump} title="跳到当前步骤">
    <LoaderCircle className="spin" size={13} aria-hidden="true" />
    <span className="run-status-label">{activity.label}</span>
    <ElapsedClock startedAt={startedAt} />
  </button>;
}

function WorkingIndicator({ feedback }: { feedback: RunFeedback }) {
  return <div className={`working-indicator ${feedback.tone}`} role="status" aria-live="polite">
    <LoaderCircle className="spin" size={15} />
    <span>{feedback.label}</span>
    <ElapsedClock startedAt={feedback.startedAt} />
  </div>;
}

function RetryingIndicator({ retrying }: { retrying: NonNullable<SessionStatus["retrying"]> }) {
  return <RunStatusIndicator className="retrying-indicator" icon={<LoaderCircle className="spin" size={15} />} label={`模型响应失败，正在重试（${String(retrying.attempt)}/${String(retrying.maxAttempts)}）`} detail={retrying.errorMessage} retrying={retrying} />;
}

function CompactingIndicator({ compacting }: { compacting: NonNullable<SessionStatus["compacting"]> }) {
  const label = compacting.reason === "manual"
    ? "正在压缩上下文"
    : compacting.reason === "overflow"
      ? "上下文已满，正在压缩后重试"
      : "上下文接近上限，正在自动压缩";
  const retrying = compacting.retrying;
  return <RunStatusIndicator className="compacting-indicator" icon={<LoaderCircle className="spin" size={15} />} label={label} startedAt={compacting.startedAt} detail={retrying === undefined ? undefined : `摘要生成失败，正在重试（${String(retrying.attempt)}/${String(retrying.maxAttempts)}）：${retrying.errorMessage}`} retrying={retrying} />;
}

function RunStatusIndicator({ className, icon, label, startedAt, detail, retrying }: { className: string; icon: ReactNode; label: string; startedAt?: string; detail?: string; retrying?: NonNullable<SessionStatus["retrying"]> }) {
  return <div className={className} role="status" aria-live="polite">
    <span className="run-status-icon">{icon}</span>
    <span className="run-status-copy">
      <span className="run-status-heading"><strong>{label}</strong>{startedAt === undefined ? null : <ElapsedClock startedAt={startedAt} />}</span>
      {detail === undefined ? null : <span className="run-status-detail">{detail}</span>}
    </span>
    {retrying === undefined ? null : <RetryCountdown retrying={retrying} />}
  </div>;
}

function RetryCountdown({ retrying }: { retrying: NonNullable<SessionStatus["retrying"]> }) {
  const [now, setNow] = useState(() => Date.now());
  const endsAt = Date.parse(retrying.retryAt);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [retrying.retryAt]);

  const secondsLeft = Number.isFinite(endsAt) ? Math.max(0, Math.ceil((endsAt - now) / 1_000)) : 0;
  return <time aria-live="off" aria-hidden="true">{secondsLeft}s</time>;
}

function RunFailureCard({ failure, onRetryCompaction, onRetry, onContinue, onDismiss }: { failure: NonNullable<SessionStatus["lastError"]>; onRetryCompaction: TimelineProps["onRetryCompaction"]; onRetry?: () => void; onContinue?: () => void; onDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  const compactionFailed = failure.code === "PI_COMPACTION_FAILED";
  const occurredAt = formatFailureTime(failure.occurredAt);
  const requestId = requestIdFromMessage(failure.message);
  const title = compactionFailed ? "上下文压缩未完成" : failure.code === "RUN_INTERRUPTED" ? "被中断" : "本次任务未完成";
  const summary = compactionFailed ? "压缩没有生成可用摘要，任务已停止。" : plainErrorReason(failure.message, failure.code) ?? errorSummary(failure.message);

  return <article className="timeline-event run-failure" role="alert">
    <button className="timeline-event-summary run-failure-header" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="run-failure-icon"><CircleAlert size={16} /></span>
      <span className="run-failure-copy"><strong>{title}</strong>{summary === undefined ? null : <span>{summary}</span>}</span>
    </button>
    {open ? <div className="run-failure-diagnostics">
      <dl>
        <div><dt>错误码</dt><dd><code>{failure.code}</code></dd></div>
        <div><dt>发生时间</dt><dd>{occurredAt}</dd></div>
        {requestId === undefined ? null : <div><dt>请求 ID</dt><dd><code>{requestId}</code></dd></div>}
      </dl>
      <pre>{failure.message}</pre>
    </div> : null}
    {!compactionFailed || onRetryCompaction === undefined ? null : <footer className="run-failure-actions">
      <Button variant="secondary" size="sm" onClick={onRetryCompaction}><RefreshCw size={13} />重试压缩</Button>
    </footer>}
    {compactionFailed ? null : <FailureActions className="run-failure-actions" onRetry={onRetry} onContinue={onContinue} onDismiss={onDismiss} />}
  </article>;
}

function FailureActions({ className, onRetry, onContinue, onDismiss }: { className: string; onRetry?: () => void; onContinue?: () => void; onDismiss?: () => void }) {
  if (onRetry === undefined && onContinue === undefined && onDismiss === undefined) return null;
  return <footer className={className}>
    {onRetry === undefined ? null : <Button variant="secondary" size="sm" onClick={onRetry} title="用同样的内容重新发送这一轮"><RefreshCw size={13} />重试</Button>}
    {onContinue === undefined ? null : <Button variant="secondary" size="sm" onClick={onContinue} title="发送「继续」，让模型接着做"><ChevronRight size={13} />继续</Button>}
    {onDismiss === undefined ? null : <Button variant="ghost" size="sm" onClick={onDismiss} title="不再显示这张卡片">知道了</Button>}
  </footer>;
}

export function lastFailedTool(entries: TimelineRenderItem[]): ToolTimelineItem | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "activity") continue;
    const failed = [...entry.items].reverse().find((item) => item.state === "failed");
    if (failed !== undefined) return failed;
  }
  return undefined;
}

export function failedStepLabel(tool: ToolTimelineItem): string {
  if (tool.name === "bash" || tool.name === "powershell") return `命令 ${commandHeadline(tool.inputPreview ?? tool.target)}${tool.exitCode === undefined ? "" : `（退出码 ${String(tool.exitCode)}）`}`;
  return tool.target === undefined || tool.title.includes(tool.target) ? tool.title : `${tool.title} ${tool.target}`;
}

/** 一轮以失败收尾时只出一张卡：哪一步失败、白话原因、重试/继续，原始错误折叠。 */
function TurnFailureCard({ items, failedTool, onRetry, onContinue }: { items: ErrorTimelineItem[]; failedTool?: ToolTimelineItem; onRetry?: () => void; onContinue?: () => void }) {
  const [open, setOpen] = useState(false);
  const latest = items.at(-1)!;
  if (latest.state === "retrying") return null;
  if (latest.state === "recovered") return <ErrorItem items={items} />;
  const reason = plainErrorReason(latest.message, latest.code) ?? errorSummary(latest.message);
  const retries = items.length > 1 ? `，已自动重试 ${String(items.length - 1)} 次` : "";
  const step = failedTool === undefined ? `请求模型时出错${retries}` : `${failedStepLabel(failedTool)} 没有通过，之后请求模型时出错${retries}`;
  return <article className="timeline-event timeline-error failed turn-failure" role="alert">
    <div className="turn-failure-head">
      <CircleAlert size={15} />
      <div className="timeline-error-copy">
        <strong>本次任务未完成</strong>
        <span className="turn-failure-reason">{reason}</span>
        <span className="turn-failure-step">{step}</span>
      </div>
    </div>
    <FailureActions className="turn-failure-actions" onRetry={onRetry} onContinue={onContinue} />
    <button className="timeline-event-summary timeline-error-header turn-failure-raw" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <ChevronRight size={12} className={open ? "expanded" : undefined} aria-hidden />原始错误
    </button>
    {!open ? null : <div className="timeline-error-details">
      {failedTool?.error === undefined ? null : <section className="turn-failure-tool"><strong>{failedStepLabel(failedTool)}</strong><pre>{failedTool.error}</pre></section>}
      {items.map((item, index) => <ErrorDetails key={item.id} item={item} showAttempt={items.length > 1} index={index} />)}
    </div>}
  </article>;
}

function requestIdFromMessage(message: string): string | undefined {
  const match = /(?:request[ _-]?id|请求\s*ID)\s*[:：]?\s*([\w-]+)/i.exec(message);
  return match?.[1];
}

function formatFailureTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function ErrorItem({ items }: { items: ErrorTimelineItem[] }) {
  const [open, setOpen] = useState(false);
  const latest = items.at(-1)!;
  // 重试挂起或重试尝试进行中都不展示，等这次尝试有最终结果（已恢复/失败）再显示；
  // 否则会与“重试中”的流式内容同时出现（顶部横幅已在重试开始时消失）。
  if (latest.state === "retrying") return null;
  const stateLabel = latest.state === "recovered" ? "已恢复" : "操作未完成";
  const retryLabel = latest.attempt === undefined || latest.maxAttempts === undefined ? undefined : `第 ${String(latest.attempt)} / ${String(latest.maxAttempts)} 次尝试`;
  const attemptCount = items.length > 1 ? `${String(items.length)} 次尝试` : undefined;
  const summary = retryLabel === undefined
    ? (attemptCount === undefined ? errorSummary(latest.message) : `${attemptCount}：${errorSummary(latest.message)}`)
    : `${retryLabel}：${errorSummary(latest.message)}`;
  return <article className={`timeline-event timeline-error ${latest.state}`} role={latest.state === "failed" ? "alert" : "status"}>
    <button className="timeline-event-summary timeline-error-header" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {latest.state === "recovered" ? <Check size={15} /> : <CircleAlert size={15} />}
      <div className="timeline-error-copy"><strong>{stateLabel}</strong><span>{summary}</span></div>
    </button>
    {!open ? null : <div className="timeline-error-details">{items.map((item, index) => <ErrorDetails key={item.id} item={item} showAttempt={items.length > 1} index={index} />)}</div>}
  </article>;
}

function ErrorDetails({ item, showAttempt, index }: { item: ErrorTimelineItem; showAttempt: boolean; index: number }) {
  const diagnostics = Object.entries(item.diagnostics ?? {});
  return <section className="timeline-error-attempt">
    {showAttempt ? <strong>尝试 {String(index + 1)} · {item.state === "retrying" ? "正在重试" : item.state === "recovered" ? "已恢复" : "失败"}</strong> : null}
    <div><span>错误码</span><code>{item.code}</code></div>
    {diagnostics.map(([key, value]) => <div key={key}><span>{key}</span><code>{value}</code></div>)}
    <pre>{item.message}</pre>
  </section>;
}

function errorSummary(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length <= 180) return firstLine || "未提供错误详情。";
  return `${firstLine.slice(0, 177)}…`;
}

const MessageItem = memo(function MessageItem({ item, streaming, live, highlighted, onEdit, onFork, baseDir, showMeta = false, generationSummary }: { item: Extract<TimelineItem, { kind: "message" }>; streaming: boolean; live?: LiveGenerationStats; highlighted: boolean; onEdit?: TimelineProps["onEditUserMessage"]; onFork?: (item: MessageTimelineItem) => void; baseDir?: string; showMeta?: boolean; generationSummary?: GenerationSummary }) {
  const [showTimestamp, setShowTimestamp] = useState(false);
  const images = item.images ?? [];
  const toggleTimestampOnTouch = (event: React.PointerEvent) => {
    if (item.role === "user" && event.pointerType === "touch") setShowTimestamp((value) => !value);
  };
  return (
    <article data-user-message-id={item.role === "user" ? item.id : undefined} className={`message-row ${item.role} ${showTimestamp ? "timestamp-visible" : ""} ${streaming ? "streaming" : ""} ${highlighted ? "navigator-highlight" : ""}`}>
      <div className={`message-body ${item.role}`}>
        {images.length === 0 ? null : <div className="message-images" aria-label="消息图片">
          {images.map((image, index) => {
            const src = imageDataUrl(image);
            return <ImagePreview key={`${image.mimeType}:${index}`} className="message-image-thumb" src={src} alt={`图片 ${String(index + 1)}`}><img src={src} alt={`图片 ${String(index + 1)}`} loading="lazy" /></ImagePreview>;
          })}
        </div>}
        {item.text === "" ? null : <div className={`message-content ${streaming ? "streaming" : ""}`} onPointerDown={toggleTimestampOnTouch}>
          <MarkdownMessage text={item.text} streaming={streaming} baseDir={baseDir} interactiveFiles={item.role === "assistant" && !streaming} />
        </div>}
        {item.role === "assistant" && showMeta && !streaming && item.text !== "" ? <div className="assistant-message-footer">
          <MessageActions item={item} streaming={false} onFork={onFork} copyable />
          <AssistantGenerationMeta generation={item.generation} summary={generationSummary} />
        </div> : <>
          {showMeta && item.role === "assistant" && (live !== undefined || item.generation !== undefined) ? <AssistantGenerationMeta live={live} generation={item.generation} /> : null}
          <MessageActions item={item} streaming={streaming} onEdit={onEdit === undefined ? undefined : () => onEdit(item)} onFork={item.role === "assistant" && !showMeta ? undefined : onFork} showTimestamp={item.role === "user"} createdAt={item.createdAt} />
        </>}
      </div>
    </article>
  );
});

function LiveGenerationMeta({ live, className = "message-generation-meta streaming" }: { live: LiveGenerationStats; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live.startedAt]);
  const started = Date.parse(live.startedAt);
  const durationMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
  const tokens = live.estimatedOutputTokens ?? 0;
  if (tokens <= 0) return null;
  const speed = durationMs > 0 ? tokens / (durationMs / 1_000) : undefined;
  return <span className={className} aria-live="polite">{`≈${formatTokenCount(tokens)} tokens`}{speed === undefined ? "" : ` · ≈${formatTokenRate(speed)}`}{durationMs < 1_000 ? "" : ` · ${formatDuration(durationMs)}`}</span>;
}

interface GenerationSummary {
  total: number;
  output: number;
  durationMs: number;
  calls: number;
}

function AssistantGenerationMeta({ live, generation, summary }: { live?: LiveGenerationStats; generation?: AssistantGenerationStats; summary?: GenerationSummary }) {
  if (live !== undefined) return <LiveGenerationMeta live={live} />;
  const current = summary ?? (generation === undefined ? undefined : { total: generation.usage.total, output: generation.usage.output, durationMs: generation.durationMs ?? 0, calls: 1 });
  if (current === undefined || current.total <= 0) return null;
  const speed = current.output > 0 && current.durationMs >= 1_000 ? current.output / (current.durationMs / 1_000) : undefined;
  const duration = current.calls === 1 && current.durationMs >= 1_000 ? formatDuration(current.durationMs) : undefined;
  return <div className="message-generation-meta">{formatTokenCount(current.total)} tokens{speed === undefined ? "" : ` · ${formatTokenRate(speed)}`}{duration === undefined ? "" : ` · ${duration}`}</div>;
}

function formatTokenRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} token/s`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatMessageTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return time;
  return `${String(date.getMonth() + 1)}月${String(date.getDate())}日 ${time}`;
}

function MessageActions({ item, streaming, onEdit, onFork, copyable = false, showTimestamp = false, createdAt }: { item: MessageTimelineItem; streaming: boolean; onEdit?: () => void; onFork?: (item: MessageTimelineItem) => void; copyable?: boolean; showTimestamp?: boolean; createdAt?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  if (streaming || (item.role !== "user" && !copyable)) return null;
  const canCopy = item.text !== "";
  if (!canCopy && onEdit === undefined && onFork === undefined) return null;
  const handleCopy = () => {
    void copyText(item.text).then(() => {
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1600);
    }).catch(() => {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1600);
    });
  };
  const noun = item.role === "user" ? "消息" : "整段回答";
  const copyLabel = copyState === "copied" ? `已复制${noun}` : copyState === "failed" ? "复制失败" : `复制${noun}`;
  return <div className="message-actions">
    {showTimestamp && createdAt !== undefined ? <time className="message-time" dateTime={createdAt} title={createdAt}>{formatMessageTime(createdAt)}</time> : null}
    {!canCopy ? null : <Tooltip label={copyLabel}>
      <button type="button" className={`message-action-button${copyState === "copied" ? " copied" : copyState === "failed" ? " failed" : ""}`} aria-label={copyLabel} onClick={handleCopy}>{copyState === "copied" ? <Check size={14} /> : copyState === "failed" ? <CircleAlert size={14} /> : <Copy size={14} />}</button>
    </Tooltip>}
    {onEdit === undefined ? null : <Tooltip label="编辑并重新生成">
      <button type="button" className="message-action-button" aria-label="编辑并重新生成" onClick={onEdit}><Pencil size={14} /></button>
    </Tooltip>}
    {onFork === undefined ? null : <Tooltip label="从此处分支">
      <button type="button" className="message-action-button" aria-label="从此处分支" onClick={() => onFork(item)}><GitBranch size={14} /></button>
    </Tooltip>}
  </div>;
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };

/** 共享的空集合：对话框重置时复用同一个引用，避免每次渲染都新建 Set。 */
const EMPTY_PREVIEWS: ReadonlySet<number> = new Set();

/**
 * 待回答对话框的草稿。时间线按「回合」分组，而回合的 key 在用户消息缺失时会取首条
 * 条目的 id（`groupTimelineTurns`）：重新水合、加载更早历史、压缩重写都可能改变它，
 * 于是卡片会被重挂载。草稿必须活在组件实例之外，否则用户写一半的内容会跟着重挂载消失。
 * 键是对话框 id（每个请求唯一的 UUID），对话框落定后清理。
 */
const dialogDrafts = new Map<string, string>();
/** 多选勾选草稿：与文本草稿分开，避免和输入内容抢同一个字符串。 */
const dialogSelections = new Map<string, number[]>();

function ExtensionUiOperation({ item, onRespond, customText }: { item: ExtensionUiTimelineItem; onRespond: TimelineProps["onExtensionUiRespond"]; customText?: string }) {
  if (item.request.method === "notify") return <ExtensionNotification item={item} />;
  const settled = item.outcome === "answered" ? settledQuestion(item, customText) : undefined;
  if (settled !== undefined) return <SettledChoices question={settled.question} header={settled.header} rows={settled.rows} />;
  return <ExtensionDialogOperation item={item} onRespond={onRespond} />;
}

function settledQuestion(item: ExtensionUiTimelineItem, customText?: string): { question: string; header?: string; rows: SettledChoiceRow[] } | undefined {
  if (item.request.method === "select") {
    const dialog = parseSelectDialog(item.request);
    if (dialog === undefined) return undefined;
    return { question: dialog.question, ...(dialog.header === undefined ? {} : { header: dialog.header }), rows: settledSelectRows(dialog.options, item.value, customText) };
  }
  if (item.request.method === "input") {
    const dialog = parseMultiSelectDialog(item.request);
    if (dialog === undefined) return undefined;
    return { question: dialog.question, ...(dialog.header === undefined ? {} : { header: dialog.header }), rows: settledMultiRows(dialog.options, item.value ?? "") };
  }
  return undefined;
}

export function SettledChoices({ question, header, rows }: { question: string; header?: string; rows: SettledChoiceRow[] }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedPreviews, setExpandedPreviews] = useState<ReadonlySet<number>>(EMPTY_PREVIEWS);
  const historyRows = rows.filter((row) => row.index !== undefined);
  const selectedRows = rows.filter((row) => row.selected);
  const selectedChoices = selectedRows.filter((row) => row.index !== undefined).map((row) => row.label);
  const typedAnswer = selectedRows.find((row) => row.index === undefined)?.label;
  const result = selectedChoices.length === 0
    ? typedAnswer ?? "未选择"
    : typedAnswer === undefined ? selectedChoices.join("、") : `${selectedChoices.join("、")} · ${typedAnswer}`;
  const togglePreview = (index: number) => {
    setExpandedPreviews((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <article className="extension-operation answered settled-choices">
      <p className="extension-operation-title extension-dialog-question">{header === undefined ? null : <span className="extension-dialog-header">{header}</span>}{question}</p>
      <div className={`settled-choice-result${selectedRows.length === 0 ? " empty" : ""}`}>
        <span className="settled-choice-result-icon" aria-hidden>{selectedRows.length === 0 ? "-" : <Check size={11} />}</span>
        <span>{result}</span>
      </div>
      {historyRows.length === 0 ? null : <>
        <button type="button" className={`settled-history-toggle${historyOpen ? " expanded" : ""}`} aria-expanded={historyOpen} onClick={() => setHistoryOpen((current) => !current)}>
          <ChevronRight size={12} className="extension-select-chevron" aria-hidden />
          <span>选项历史（{historyRows.length}）</span>
        </button>
        {historyOpen ? <div className="extension-select-list settled">
          {historyRows.map((row, position) => {
            const previewIndex = row.index ?? position + 1;
            const expanded = expandedPreviews.has(previewIndex);
            return <div key={row.key} className={`extension-select-option${row.selected ? " checked" : " missed"}`}>
              <div className="extension-select-choice">
                <span className="extension-select-index" aria-hidden>{row.selected ? <Check size={11} /> : row.index ?? ""}</span>
                <span className="extension-select-body">
                  <span className="extension-select-label">{row.label}</span>
                  {row.description === undefined ? null : <span className="extension-select-description">{row.description}</span>}
                </span>
              </div>
              {row.preview === undefined ? null : <div className="extension-select-preview">
                <button type="button" className="extension-select-preview-toggle" aria-expanded={expanded} onClick={() => togglePreview(previewIndex)}>
                  <ChevronRight size={12} className={`extension-select-chevron${expanded ? " expanded" : ""}`} aria-hidden />
                  <span className="extension-select-preview-label">{expanded ? "收起预览" : "预览"}</span>
                  {expanded ? null : <span className="extension-select-preview-hint">{previewSummary(row.preview)}</span>}
                </button>
                {expanded ? <pre className="extension-select-preview-body">{row.preview}</pre> : null}
              </div>}
            </div>;
          })}
        </div> : null}
      </>}
    </article>
  );
}

function ExtensionDialogOperation({ item, onRespond }: { item: ExtensionUiTimelineItem; onRespond: TimelineProps["onExtensionUiRespond"] }) {
  const request = item.request as ExtensionDialogRequest;
  const [value, setValueState] = useState(() => dialogDrafts.get(request.id) ?? (request.method === "editor" ? request.prefill ?? "" : ""));
  const setValue = useCallback((next: string) => {
    dialogDrafts.set(request.id, next);
    setValueState(next);
  }, [request.id]);
  const [activeIndex, setActiveIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [expandedPreviews, setExpandedPreviews] = useState<ReadonlySet<number>>(EMPTY_PREVIEWS);
  const [selected, setSelectedState] = useState<ReadonlySet<number>>(() => new Set(dialogSelections.get(request.id) ?? []));
  const toggleSelected = (index: number) => {
    setSelectedState((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      dialogSelections.set(request.id, [...next].sort((left, right) => left - right));
      return next;
    });
  };

  // 重连/重新水合会用同一份数据重建 request 对象，但对话框本身没变：不能因此丢掉用户
  // 已经写了一半的内容（移动端切后台回来、网络恢复都会触发 resync → 重拉快照），也不该
  // 收起已展开的预览。只有真的换了对话框（id 变化）才重置。
  const requestIdRef = useRef(request.id);
  useEffect(() => {
    if (requestIdRef.current === request.id) return;
    requestIdRef.current = request.id;
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setActiveIndex(0);
    optionRefs.current = [];
    setSubmitting(false);
    setShowResult(false);
    setExpandedPreviews(EMPTY_PREVIEWS);
    setSelectedState(new Set(dialogSelections.get(request.id) ?? []));
  }, [request, setValue]);

  // 对话框落定（已答/取消/超时/关闭）后不再需要草稿。
  useEffect(() => {
    if (item.outcome === undefined) return;
    dialogDrafts.delete(request.id);
    dialogSelections.delete(request.id);
  }, [item.outcome, request.id]);

  const respond = (response: ExtensionResponse) => {
    if (item.outcome !== undefined || submitting || onRespond === undefined) return;
    setSubmitting(true);
    Promise.resolve(onRespond(request.id, response)).catch(() => setSubmitting(false));
  };
  // 扩展回退格式的选项带序号/描述/预览；解析不出来时按原始字符串渲染。
  const dialog = useMemo(() => {
    if (request.method === "select") return parseSelectDialog(request);
    if (request.method === "input") return parseMultiSelectDialog(request);
    return undefined;
  }, [request]);
  const multi = request.method === "input" ? dialog : undefined;
  const choices: ExtensionSelectOption[] = request.method === "select"
    ? dialog?.options ?? request.options.map((option) => ({ value: option, label: option }))
    : multi?.options ?? [];
  const togglePreview = (index: number) => {
    setExpandedPreviews((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const onSelectKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (request.method !== "select" && multi === undefined) return;
    // 预览开关 / 补充输入是同一卡片里的独立控件：Enter/Space 不能被选项导航抢走。
    if (event.target instanceof HTMLElement && event.target.closest(".extension-select-preview, .extension-dialog-input") !== null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown"
        ? (activeIndex + 1) % choices.length
        : (activeIndex - 1 + choices.length) % choices.length;
      setActiveIndex(nextIndex);
      requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
    } else if (event.key === "Enter" || event.key === " ") {
      const choice = choices[activeIndex];
      if (choice === undefined) return;
      event.preventDefault();
      if (multi !== undefined) toggleSelected(choice.index ?? activeIndex + 1);
      else respond({ value: choice.value });
    }
  };

  if (item.outcome !== undefined) return <ExtensionResult item={item} expanded={showResult} onToggle={() => setShowResult((current) => !current)} />;
  const title = dialog === undefined ? request.title : selectDialogTitle(dialog);
  // 非选择卡（确认 / 普通输入 / 编辑）的标题也带扩展自己拼的信息，同样拆出短标签、保留换行结构。
  const heading = request.method === "select" || multi !== undefined ? undefined : splitDialogHeading(request.title);
  const structured = request.method === "select" || multi !== undefined;
  return <article className={`extension-operation pending ${request.method}${multi === undefined ? "" : " multi"}`} aria-label={`扩展操作：${title}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); respond({ cancelled: true }); } }}>
    <div className="extension-operation-heading"><Clock3 size={14} /><span>{multi === undefined ? extensionOperationPrompt(request.method) : "需要选择"}</span><ExtensionTimeout timeout={request.timeout} createdAt={item.createdAt} /></div>
    {structured ? <div className="extension-operation-title-row"><p className="extension-operation-title extension-dialog-question">{dialog?.header === undefined ? null : <span className="extension-dialog-header">{dialog.header}</span>}{dialog?.question ?? request.title}</p><button type="button" className="extension-dock-close" aria-label="取消选择" disabled={submitting} onClick={() => respond({ cancelled: true })}><X size={16} /></button></div> : <p className="extension-operation-title extension-dialog-question">{heading?.header === undefined ? null : <span className="extension-dialog-header">{heading.header}</span>}{heading?.question ?? request.title}</p>}
    {request.method === "confirm" && request.message !== undefined ? <p className="extension-operation-message">{request.message}</p> : null}
    {request.method === "select" ? <div className="extension-select-list" role="listbox" aria-label={title} tabIndex={0} onKeyDown={onSelectKeyDown}>
      {dialog === undefined
        ? request.options.map((option, index) => <button ref={(element) => { optionRefs.current[index] = element; }} key={option} type="button" role="option" aria-selected={false} className="extension-select-plain" disabled={submitting} onFocus={() => setActiveIndex(index)} onClick={() => respond({ value: option })}>{option}</button>)
        : choices.map((option, index) => {
          // 选项本身是 role=option 的按钮；预览开关必须是独立控件（按钮不能嵌套按钮），
          // 所以这里用一层普通容器把两者并排放，点预览不会误提交该选项。
          const expanded = expandedPreviews.has(index);
          return <div key={option.value} role="group" className={`extension-select-option${option.custom === true ? " custom" : ""}`}>
            <button ref={(element) => { optionRefs.current[index] = element; }} type="button" role="option" aria-selected={false} className="extension-select-choice" disabled={submitting} onFocus={() => setActiveIndex(index)} onClick={() => respond({ value: option.value })}>
              {option.custom === true ? <Pencil size={13} className="extension-select-custom-icon" aria-hidden /> : <span className="extension-select-index" aria-hidden>{option.index ?? index + 1}</span>}
              <span className="extension-select-body">
                <span className="extension-select-label">{option.label}</span>
                {option.description === undefined ? null : <span className="extension-select-description">{option.description}</span>}
              </span>
            </button>
            {option.preview === undefined ? null : <div className="extension-select-preview">
              <button type="button" className="extension-select-preview-toggle" aria-expanded={expanded} disabled={submitting} onClick={() => togglePreview(index)}>
                <ChevronRight size={12} className={`extension-select-chevron${expanded ? " expanded" : ""}`} aria-hidden />
                <span className="extension-select-preview-label">{expanded ? "收起预览" : "预览"}</span>
                {expanded ? null : <span className="extension-select-preview-hint">{previewSummary(option.preview)}</span>}
              </button>
              {expanded ? <pre className="extension-select-preview-body">{option.preview}</pre> : null}
            </div>}
          </div>;
        })}
    </div> : null}
    {multi === undefined ? null : <div className="extension-select-list" role="listbox" aria-multiselectable="true" aria-label={title} tabIndex={0} onKeyDown={onSelectKeyDown}>
      {choices.map((option, index) => {
        const checked = selected.has(option.index ?? index + 1);
        return <div key={option.value} className={`extension-select-option${checked ? " checked" : ""}`}>
          <button ref={(element) => { optionRefs.current[index] = element; }} type="button" role="option" aria-selected={checked} className="extension-select-choice" disabled={submitting} onFocus={() => setActiveIndex(index)} onClick={() => toggleSelected(option.index ?? index + 1)}>
            <span className="extension-select-index" aria-hidden>{checked ? <Check size={11} /> : option.index ?? index + 1}</span>
            <span className="extension-select-body">
              <span className="extension-select-label">{option.label}</span>
              {option.description === undefined ? null : <span className="extension-select-description">{option.description}</span>}
            </span>
          </button>
        </div>;
      })}
      <div className="extension-select-option custom">
        <div className="extension-select-note">
          <Pencil size={13} className="extension-select-custom-icon" aria-hidden />
          <input className="extension-dialog-input" aria-label="补充" value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); respond({ value: encodeMultiSelectValue(choices, selected, value) }); } }} />
        </div>
      </div>
    </div>}
    {request.method === "input" && multi === undefined ? <input autoFocus className="extension-dialog-input" placeholder={request.placeholder} value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); respond({ value }); } }} /> : null}
    {request.method === "editor" ? <textarea autoFocus className="extension-dialog-input multiline" value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); respond({ value }); } }} rows={8} /> : null}
    {request.method === "select" ? null : <div className="extension-interaction-actions">
      {request.method === "confirm" ? <><button type="button" disabled={submitting} onClick={() => respond({ confirmed: false })}>拒绝</button><button type="button" className="accent" disabled={submitting} onClick={() => respond({ confirmed: true })}>{submitting ? "正在处理…" : "允许"}</button></> : <>{multi === undefined ? <button type="button" disabled={submitting} onClick={() => respond({ cancelled: true })}>取消</button> : null}<button type="button" className="accent" disabled={submitting} onClick={() => respond({ value: multi === undefined ? value : encodeMultiSelectValue(choices, selected, value) })}>{submitting ? "正在提交…" : request.method === "editor" ? "提交修改" : "提交"}</button></>}
    </div>}
  </article>;
}

function ExtensionNotification({ item }: { item: ExtensionUiTimelineItem }) {
  const tone = item.request.method === "notify" ? item.request.notifyType ?? "info" : "info";
  const Icon = tone === "error" ? CircleAlert : tone === "warning" ? CircleAlert : Bell;
  return <article className={`extension-notification ${tone}`} role={tone === "error" ? "alert" : "status"}>
    <span className="extension-notification-icon"><Icon size={15} /></span>
    <span>{item.request.method === "notify" ? item.request.message : ""}</span>
  </article>;
}

function ExtensionResult({ item, expanded, onToggle }: { item: ExtensionUiTimelineItem; expanded: boolean; onToggle: () => void }) {
  const request = item.request as ExtensionDialogRequest;
  const canExpand = item.outcome === "answered" && (request.method === "input" || request.method === "editor") && item.value !== undefined && item.value !== "" && (request.method !== "input" || parseMultiSelectDialog(request) === undefined);
  const title = useMemo(() => dialogAriaTitle(request), [request]);
  return <article className={`extension-operation ${item.outcome ?? "closed"}`} aria-label={`扩展操作：${title}`}>
    <div className="extension-result-line"><span className="extension-operation-icon">{item.outcome === "answered" ? <Check size={14} /> : <XCircle size={14} />}</span><span>{extensionOperationLabel(item)}</span>{canExpand ? <button type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? "收起" : "查看内容"}</button> : null}</div>
    {canExpand && expanded ? <pre className="extension-result-content">{item.value}</pre> : null}
  </article>;
}

/** 问题标题（无障碍标签用）：结构化后只取短标签 + 问题正文，不再带上折叠的预览正文。 */
function dialogAriaTitle(request: ExtensionDialogRequest): string {
  if (request.method === "select") {
    const dialog = parseSelectDialog(request);
    return dialog === undefined ? request.title : selectDialogTitle(dialog);
  }
  if (request.method === "input") {
    const dialog = parseMultiSelectDialog(request);
    if (dialog !== undefined) return selectDialogTitle(dialog);
  }
  const heading = splitDialogHeading(request.title);
  return heading.header === undefined ? heading.question : `${heading.header}：${heading.question}`;
}

function extensionOperationPrompt(method: ExtensionDialogRequest["method"]): string {
  return method === "confirm" ? "需要确认" : method === "select" ? "需要选择" : method === "editor" ? "需要编辑" : "需要输入";
}

function extensionOperationLabel(item: ExtensionUiTimelineItem): string {
  if (item.outcome === "answered") {
    if (item.request.method === "confirm") return item.confirmed === true ? "已允许" : "已拒绝";
    if (item.request.method === "select") return `已选择：${item.value === undefined ? "未选择" : selectAnswerLabel(item.request.options, item.value)}`;
    if (item.request.method === "input") {
      const dialog = parseMultiSelectDialog(item.request);
      if (dialog !== undefined) {
        if (item.value === undefined || item.value === "") return "已选择：未选择";
        return `已选择：${multiSelectAnswerLabel(dialog.options, item.value)}`;
      }
    }
    return item.value === "" ? "已提交空内容" : "已提交";
  }
  return item.outcome === "timeout" ? "已超时" : item.outcome === "cancelled" ? "已取消" : "已关闭";
}

function ExtensionTimeout({ timeout, createdAt }: { timeout?: number; createdAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (timeout === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timeout]);
  if (timeout === undefined) return null;
  const seconds = Math.max(0, Math.ceil((Date.parse(createdAt) + timeout - now) / 1_000));
  return <span className={`extension-operation-state ${seconds <= 30 ? "urgent" : ""}`}>{seconds === 0 ? "即将超时" : `${seconds}s`}</span>;
}

const ContextSummaryItem = memo(function ContextSummaryItem({ item, baseDir }: { item: ContextSummaryTimelineItem; baseDir?: string }) {
  const [expanded, setExpanded] = useState(false);
  const isCompaction = item.summaryType === "compaction";
  const label = isCompaction ? "上下文已压缩" : "分支上下文摘要";
  return <article className={`context-summary ${item.summaryType}`}>
    <button className="context-summary-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span className="context-summary-icon">{isCompaction ? <Archive size={15} /> : <GitBranch size={15} />}</span>
      <span className="context-summary-copy"><strong>{label}</strong>{item.tokensBefore === undefined ? null : <small>压缩前 {formatTokenCount(item.tokensBefore)} tokens</small>}</span>
    </button>
    {expanded ? <div className="context-summary-details"><div className="message-content"><MarkdownMessage text={item.summary} streaming={false} baseDir={baseDir} /></div></div> : null}
  </article>;
});

export type TimelineRenderItem =
  | { kind: "message"; item: MessageTimelineItem }
  | { kind: "error"; items: ErrorTimelineItem[] }
  | { kind: "context-summary"; item: ContextSummaryTimelineItem }
  | { kind: "extension-ui"; item: ExtensionUiTimelineItem }
  | { kind: "thinking"; item: ThinkingTimelineItem }
  | { kind: "activity"; items: ToolTimelineItem[] };

export function groupTimelineItems(items: TimelineItem[]): TimelineRenderItem[] {
  const result: TimelineRenderItem[] = [];
  let tools: ToolTimelineItem[] = [];
  const flushTools = () => {
    if (tools.length > 0) result.push({ kind: "activity", items: tools });
    tools = [];
  };

  for (const item of items) {
    if (item.kind === "tool") {
      tools.push(item);
    } else {
      flushTools();
      if (item.kind === "message") result.push({ kind: "message", item });
      else if (item.kind === "error") {
        const previous = result.at(-1);
        if (previous?.kind === "error") previous.items.push(item);
        else result.push({ kind: "error", items: [item] });
      } else if (item.kind === "extension-ui") result.push({ kind: "extension-ui", item });
      else if (item.kind === "thinking") result.push({ kind: "thinking", item });
      else result.push({ kind: "context-summary", item });
    }
  }
  flushTools();
  return result;
}

function isPendingToolItem(item: TimelineItem): boolean {
  return item.kind === "tool" && (item.state === "queued" || item.state === "running");
}

function hasActiveActivity(items: TimelineItem[], status: SessionStatus): boolean {
  if (status.runState === "idle") return false;
  const last = items.at(-1);
  if (last?.kind === "thinking" && last.state === "running") return true;
  return isToolActivityRunning(items, status);
}

/** 尾部工具组里还有未完成的工具才算执行中；思考已开始或工具都结束则停转圈。 */
export function isToolActivityRunning(items: TimelineItem[], status: SessionStatus): boolean {
  if (status.runState === "idle" || items.at(-1)?.kind !== "tool") return false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "tool") return false;
    if (isPendingToolItem(item)) return true;
  }
  return false;
}

export interface TimelineTurn {
  /** React key 与折叠状态的依据。 */
  key: string;
  /** 触发该回合的用户消息；历史分页从回合中间开始时没有。 */
  user?: MessageTimelineItem;
  /** 折叠进「过程」的条目：思考、工具组、过程文本、错误、上下文事件。 */
  process: TimelineRenderItem[];
  /** 回合最后一条 assistant 文本，留在过程外。 */
  final?: MessageTimelineItem;
  /** 回合末尾未恢复的错误，留在过程折叠外。 */
  finalError?: ErrorTimelineItem[];
}

/** 以用户消息为界组成回合。最终输出及其之后的内容不进过程；没有明确最终输出时回退到最后一条 assistant 文本。 */
export function groupTimelineTurns(items: TimelineItem[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let current: TimelineTurn | undefined;
  const openTurn = (key: string): TimelineTurn => {
    const turn: TimelineTurn = { key, process: [] };
    turns.push(turn);
    current = turn;
    return turn;
  };

  for (const entry of groupTimelineItems(items)) {
    if (entry.kind === "message" && entry.item.role === "user") {
      openTurn(`turn:${entry.item.id}`).user = entry.item;
      continue;
    }
    const sourceMessageId = renderItemSourceMessageId(entry);
    (current ?? openTurn(`turn:${sourceMessageId ?? renderItemKey(entry)}`)).process.push(entry);
  }
  for (const turn of turns) {
    const candidates = turn.process
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.kind === "message" && entry.item.role === "assistant");
    const finalCandidate = [...candidates].reverse().find(({ entry }) => entry.kind === "message" && entry.item.phase === "final_answer")
      ?? candidates.at(-1);
    if (finalCandidate !== undefined && finalCandidate.entry.kind === "message") {
      turn.final = finalCandidate.entry.item;
      turn.process = turn.process.slice(0, finalCandidate.index);
      continue;
    }
    const last = turn.process.at(-1);
    if (last?.kind === "error" && last.items.some((item) => item.state === "failed")) {
      turn.finalError = last.items;
      turn.process.pop();
    }
  }
  return turns;
}

function renderItemKey(entry: TimelineRenderItem): string {
  return entry.kind === "activity" || entry.kind === "error" ? entry.items[0]?.id ?? "empty" : entry.item.id;
}

function renderItemSourceMessageId(entry: TimelineRenderItem): string | undefined {
  if (entry.kind === "activity") return entry.items.find((item) => item.assistantMessageId !== undefined)?.assistantMessageId;
  if (entry.kind === "thinking" || entry.kind === "message") return entry.item.assistantMessageId;
  return undefined;
}

function renderItemRange(entry: TimelineRenderItem): { start?: string; end?: string } {
  const items: Array<{ createdAt: string }> = entry.kind === "activity" || entry.kind === "error" ? entry.items : [entry.item];
  return { start: items[0]?.createdAt, end: items.at(-1)?.createdAt };
}

export interface TurnProcessSummary {
  /** 工具调用总数。 */
  operations: number;
  durationMs?: number;
  /** 失败的工具和未恢复的错误数，没有失败时省略。 */
  failures?: number;
}

function processStartAt(turn: TimelineTurn): string | undefined {
  const first = turn.process.at(0);
  return first === undefined ? undefined : renderItemRange(first).start;
}

function processEndAt(turn: TimelineTurn): string | undefined {
  const last = turn.process.at(-1);
  return last === undefined ? undefined : renderItemRange(last).end;
}

export function summarizeTurnGeneration(turn: TimelineTurn): GenerationSummary | undefined {
  const items: TimelineItem[] = [];
  for (const entry of turn.process) {
    if (entry.kind === "message" || entry.kind === "thinking" || entry.kind === "activity") items.push(...(entry.kind === "activity" ? entry.items : [entry.item]));
  }
  if (turn.final !== undefined) items.push(turn.final);
  const generations = items.flatMap((item) => item.kind !== "message" && item.kind !== "thinking" && item.kind !== "tool" || item.generation === undefined ? [] : [item.generation]);
  if (generations.length === 0) return undefined;
  return {
    total: generations.reduce((sum, generation) => sum + generation.usage.total, 0),
    output: generations.reduce((sum, generation) => sum + generation.usage.output, 0),
    durationMs: generations.reduce((sum, generation) => sum + (generation.durationMs ?? 0), 0),
    calls: generations.length,
  };
}

export function summarizeTurnProcess(turn: TimelineTurn): TurnProcessSummary {
  let operations = 0;
  let failures = turn.finalError?.some((item) => item.state === "failed") === true ? 1 : 0;
  for (const entry of turn.process) {
    if (entry.kind === "activity") {
      operations += entry.items.length;
      failures += entry.items.filter((item) => item.state === "failed").length;
    } else if (entry.kind === "error" && entry.items.some((item) => item.state === "failed")) failures += 1;
  }
  const start = Date.parse(processStartAt(turn) ?? "");
  const end = Date.parse(processEndAt(turn) ?? "");
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : undefined;
  return { operations, ...(durationMs === undefined ? {} : { durationMs }), ...(failures === 0 ? {} : { failures }) };
}

/** 过程标题里的分类计数，例如「读取 2 · 命令 1」。 */
export function turnProcessCategories(entries: TimelineRenderItem[]): string {
  return summarizeToolActivity(entries.flatMap((entry) => entry.kind === "activity" ? entry.items : []));
}

/** 过程里只要还有内容就值得折进「过程」，单条也算。 */
export function shouldFoldTurnProcess(turn: TimelineTurn): boolean {
  return turn.process.length > 0;
}

/** 最终回复还没写完时不出现「过程」。这一轮已结束，或最终回复已不在流式输出，才收进过程。 */
export function turnFinalReplyPending(turn: { final?: { id: string } }, live: boolean, streamingMessageId: string | undefined): boolean {
  if (!live) return false;
  return turn.final === undefined || turn.final.id === streamingMessageId;
}

/** 过程默认收起；用户手动打开过才展开。 */
export function isTurnProcessOpen(foldState: Pick<TimelineFoldState, "openProcessIds">, processId: string | undefined): boolean {
  if (processId === undefined) return false;
  return foldState.openProcessIds.has(processId);
}

function isUserCommand(item: ToolTimelineItem): boolean {
  return item.id.startsWith("bash:");
}

function isPendingDialog(entry: TimelineRenderItem): boolean {
  return entry.kind === "extension-ui" && entry.item.outcome === undefined;
}

/** 用户 !cmd 和未回答问询留在过程外，其余仍按原顺序收进过程。 */
export function splitVisibleTurnEntries(entries: TimelineRenderItem[]): { process: TimelineRenderItem[]; visible: TimelineRenderItem[] } {
  const process: TimelineRenderItem[] = [];
  const visible: TimelineRenderItem[] = [];
  for (const entry of entries) {
    if (isPendingDialog(entry)) {
      visible.push(entry);
      continue;
    }
    if (entry.kind !== "activity") {
      process.push(entry);
      continue;
    }
    const commands = entry.items.filter(isUserCommand);
    const rest = entry.items.filter((item) => !isUserCommand(item));
    if (rest.length > 0) process.push({ kind: "activity", items: rest });
    if (commands.length > 0) visible.push({ kind: "activity", items: commands });
  }
  return { process, visible };
}

/** 回合以未恢复的错误收尾。末尾失败卡会提到折叠外，过程里也可能还留着未恢复错误。 */
export function turnEndedInFailure(turn: TimelineTurn): boolean {
  if (turn.finalError?.some((item) => item.state === "failed")) return true;
  return turn.process.some((entry) => entry.kind === "error" && entry.items.some((item) => item.state === "failed"));
}

/** 过程耗时：与运行计时同一格式（M:SS），不足 1 秒不显示。 */
function formatProcessElapsed(durationMs: number): string | undefined {
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 1 || seconds > 86_400) return undefined;
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 计时器单独成一个小组件：每秒钟只重渲染这一个节点。 */
function turnProcessLabel(summary: TurnProcessSummary, categories = "", changedFiles = 0): string {
  const seconds = summary.durationMs === undefined ? 0 : Math.round(summary.durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  return [
    "过程",
    ...(summary.durationMs === undefined ? [] : [`用时 ${minutes === 0 ? `${String(seconds)} 秒` : `${String(minutes)} 分 ${String(seconds % 60)} 秒`}`]),
    ...(categories !== "" ? [categories] : summary.operations === 0 ? [] : [`${String(summary.operations)} 项操作`]),
    ...(changedFiles === 0 ? [] : [`改了 ${String(changedFiles)} 个文件`]),
  ].join("，");
}

interface TurnRenderContext {
  streamingMessageId?: string;
  liveGeneration?: LiveGenerationStats;
  status: SessionStatus;
  openDetailIds: ReadonlySet<string>;
  openGroupIds: ReadonlySet<string>;
  onToggleDetail: (id: string) => void;
  onToggleGroup?: (groupId: string) => void;
  onToggleCall?: (toolId: string, callId: string) => void;
  highlightedMessageId?: string;
  workspaceCwd?: string;
  onExtensionUiRespond?: TimelineProps["onExtensionUiRespond"];
  onEditUserMessage?: TimelineProps["onEditUserMessage"];
  onForkMessage?: TimelineProps["onForkMessage"];
  customAnswers?: ReadonlyMap<string, string>;
  /** 只有回合的最终回答显示 token/速度/用时。 */
  showGenerationMeta?: boolean;
  generationSummary?: GenerationSummary;
  onRetryTurn?: TimelineProps["onRetryTurn"];
  onContinue?: TimelineProps["onContinue"];
  /** 最终回复完成前：思考和工具组不收起。 */
  inlineProcess?: boolean;
}

export interface PresentedTurnProcess {
  entries: TimelineRenderItem[];
  customAnswers: ReadonlyMap<string, string>;
}

/** 问询的工具原文和自定义跟进输入不单独展示；自定义正文挂回对应的选项列。 */
export function presentTurnProcess(entries: TimelineRenderItem[]): PresentedTurnProcess {
  const customAnswers = new Map<string, string>();
  const hidden = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.kind !== "extension-ui" || entry.item.request.method !== "select" || entry.item.outcome !== "answered") continue;
    const dialog = parseSelectDialog(entry.item.request);
    const chosen = dialog?.options.find((option) => option.value === entry.item.value);
    if (chosen?.custom !== true) continue;
    const followUp = nextCustomInput(entries, index);
    if (followUp === undefined) continue;
    if (followUp.outcome === undefined) {
      hidden.add(entry.item.id);
      continue;
    }
    hidden.add(followUp.id);
    if (followUp.outcome === "answered" && followUp.value !== undefined && followUp.value !== "") customAnswers.set(entry.item.id, followUp.value);
  }
  return {
    customAnswers,
    entries: entries.flatMap((entry): TimelineRenderItem[] => {
      if (entry.kind === "activity") {
        const items = entry.items.filter((item) => item.name !== "ask_user_question");
        return items.length === 0 ? [] : [{ kind: "activity", items }];
      }
      if (entry.kind === "extension-ui" && hidden.has(entry.item.id)) return [];
      return [entry];
    }),
  };
}

function nextCustomInput(entries: TimelineRenderItem[], from: number): ExtensionUiTimelineItem | undefined {
  for (let index = from + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.kind !== "extension-ui") continue;
    const request = entry.item.request;
    if (request.method === "select" || request.method !== "input" || parseMultiSelectDialog(request) !== undefined) return undefined;
    return entry.item;
  }
  return undefined;
}

function liveGenerationForBlock(item: MessageTimelineItem | ThinkingTimelineItem, live: LiveGenerationStats | undefined, kind: "thinking" | "text"): LiveGenerationStats | undefined {
  if (live?.activeBlockKind !== kind) return undefined;
  if ((item.assistantMessageId ?? item.id) !== live.assistantMessageId) return undefined;
  return live.activeContentIndex === undefined || item.contentIndex === live.activeContentIndex ? live : undefined;
}

function renderTimelineEntry(entry: TimelineRenderItem, context: TurnRenderContext, showAll = true, showActivePreview = true): ReactNode {
  if (entry.kind === "message") {
    const streaming = entry.item.id === context.streamingMessageId && context.liveGeneration?.activeBlockKind !== "thinking";
    return <MessageItem key={entry.item.id} item={entry.item} streaming={streaming} live={liveGenerationForBlock(entry.item, context.liveGeneration, "text")} highlighted={entry.item.id === context.highlightedMessageId} onEdit={context.onEditUserMessage} onFork={context.onForkMessage} baseDir={context.workspaceCwd} showMeta={context.showGenerationMeta === true} generationSummary={context.generationSummary} />;
  }
  if (entry.kind === "error") return <ErrorItem key={`error:${entry.items[0]?.id ?? "empty"}`} items={entry.items} />;
  if (entry.kind === "context-summary") return <ContextSummaryItem key={entry.item.id} item={entry.item} baseDir={context.workspaceCwd} />;
  if (entry.kind === "extension-ui") return <ExtensionUiOperation key={entry.item.id} item={entry.item} onRespond={context.onExtensionUiRespond} customText={context.customAnswers?.get(entry.item.id)} />;
  if (entry.kind === "thinking") {
    const streaming = entry.item.state === "running" && context.liveGeneration?.activeBlockKind === "thinking";
    return <ThinkingItem key={entry.item.id} item={entry.item} streaming={streaming} live={liveGenerationForBlock(entry.item, context.liveGeneration, "thinking")} baseDir={context.workspaceCwd} open={context.inlineProcess === true || context.openDetailIds.has(entry.item.id)} showDetails={showAll} onToggle={() => context.onToggleDetail(entry.item.id)} />;
  }
  const active = context.status.runState !== "idle" && entry.items.some((item) => item.state === "queued" || item.state === "running");
  const groupId = activityGroupId(entry.items[0]?.id ?? "empty");
  const pending = entry.items.some((item) => item.state === "running" || item.state === "queued");
  const grouped = entry.items.length > 1 && !entry.items.some((item) => item.id.startsWith("bash:"));
  return <ToolActivity key={`activity:${entry.items[0]?.id ?? "empty"}`} items={entry.items} active={active} showAll={showAll} showActivePreview={showActivePreview} visibleItemIds={showAll ? undefined : visibleToolActivityItemIds(entry.items, active, showActivePreview)} openItems={context.openDetailIds} onToggleItem={context.onToggleDetail} openCallIds={context.openDetailIds} onToggleCall={context.onToggleCall} groupCollapsed={grouped && !pending && context.inlineProcess !== true && !context.openGroupIds.has(groupId)} onToggleGroup={context.onToggleGroup === undefined ? undefined : () => context.onToggleGroup?.(groupId)} />;
}

export function processTextPreview(text: string): string {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").at(-1)?.trim() ?? "";
}

export function MarkdownTextPreview({ text }: { text: string }) {
  return <ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml components={{ p: ({ children }) => <>{children}</> }}>{text}</ReactMarkdown>;
}

export function timelineProcessId(turn: TimelineTurn | undefined): string | undefined {
  if (turn === undefined || turn.process.length === 0) return undefined;
  const sourceMessageId = turn.process.map(renderItemSourceMessageId).find((id): id is string => id !== undefined);
  if (sourceMessageId === undefined) return `process:${renderItemKey(turn.process[0]!)}`;
  if (turn.key.startsWith("turn:after:")) return `process:${sourceMessageId}:after:${turn.key.slice("turn:after:".length)}`;
  return `process:${sourceMessageId}`;
}

/** 回合内成功落地的文件改动，同一文件合并。 */
export function turnFileChanges(entries: TimelineRenderItem[]): FileChange[] {
  const changes: FileChange[] = [];
  for (const entry of entries) {
    if (entry.kind !== "activity") continue;
    for (const item of entry.items) if (item.fileChange !== undefined && item.state === "completed") changes.push(item.fileChange);
  }
  return mergeFileChanges(changes);
}

function fileBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function FileChip({ path, cwd, children }: { path: string; cwd?: string; children?: ReactNode }) {
  return <span className="file-chip" title={path}><LocalTextFileLink path={path} cwd={cwd}>{children ?? fileBaseName(path)}</LocalTextFileLink></span>;
}

/** 回合改动汇总行最多直接显示的文件名小标签数，其余收成"等 N 个"。 */
const TURN_CHANGE_CHIP_LIMIT = 3;

function TurnChanges({ changes, cwd }: { changes: FileChange[]; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  return <section className={`turn-changes${open ? " expanded" : ""}`}>
    {open ? null : <div className="turn-changes-row">
      <button type="button" className="turn-changes-summary" aria-expanded={false} onClick={() => setOpen(true)}>
        <ChevronRight size={13} className="turn-process-chevron" aria-hidden />
        <span>{changes.length} 个文件</span>
        <DiffStat added={added} removed={removed} />
      </button>
      <span className="turn-changes-chips">{changes.slice(0, TURN_CHANGE_CHIP_LIMIT).map((change) => <FileChip key={change.path} path={change.path} cwd={cwd} />)}{changes.length > TURN_CHANGE_CHIP_LIMIT ? <button type="button" className="turn-changes-more" aria-expanded={false} aria-label={`查看全部 ${String(changes.length)} 个改动文件`} onClick={() => setOpen(true)}>等 {changes.length} 个</button> : null}</span>
    </div>}
    {open ? <div className="turn-changes-files">{changes.map((change, index) => <div key={change.path} className="turn-changes-file">
      <div className="turn-changes-file-head">
        {index === 0 ? <button type="button" className="turn-changes-collapse" aria-expanded aria-label="收起文件改动" onClick={() => setOpen(false)}><ChevronRight size={13} className="turn-process-chevron expanded" aria-hidden /></button> : <span className="turn-changes-collapse-spacer" aria-hidden />}
        <FileChip path={change.path} cwd={cwd}>{change.path}</FileChip>{change.kind === "write" ? <span className="turn-changes-kind">写入</span> : null}<DiffStat added={change.added} removed={change.removed} />
      </div>
      <DiffView change={change} />
    </div>)}</div> : null}
  </section>;
}

function TimelineTurnBlock({ turn, live, foldState, onToggleProcess, onToggleProcessDetail, onToggleProcessGroup, ...context }: TurnRenderContext & { turn: TimelineTurn; live: boolean; foldState: TimelineFoldState; onToggleProcess: (id: string, open: boolean) => void; onToggleProcessDetail: (processId: string, detailId: string, parentShowingAll: boolean) => void; onToggleProcessGroup: (processId: string, groupId: string) => void }) {
  const presented = useMemo(() => presentTurnProcess(turn.process), [turn.process]);
  const split = useMemo(() => splitVisibleTurnEntries(presented.entries), [presented.entries]);
  const displayTurn = { ...turn, process: split.process };
  const summary = summarizeTurnProcess(displayTurn);
  const collapsible = shouldFoldTurnProcess(displayTurn);
  const processId = timelineProcessId(turn);
  const inline = turnFinalReplyPending(turn, live, context.streamingMessageId);
  const open = !collapsible || (!inline && isTurnProcessOpen(foldState, processId));
  const touched = processId !== undefined && foldState.touchedProcessIds.has(processId);
  const showAll = inline || !collapsible || open;
  const processContext: TurnRenderContext = {
    ...context,
    openDetailIds: foldState.openDetailIds,
    openGroupIds: foldState.openGroupIds,
    onToggleDetail: (detailId) => { if (processId !== undefined) onToggleProcessDetail(processId, detailId, showAll); },
    onToggleGroup: (groupId) => { if (processId !== undefined) onToggleProcessGroup(processId, groupId); },
    onToggleCall: (toolId, callId) => { if (processId !== undefined) onToggleProcessDetail(processId, callId, showAll); },
    customAnswers: presented.customAnswers,
  };
  const elapsed = summary.durationMs === undefined ? undefined : formatProcessElapsed(summary.durationMs);
  const changes = useMemo(() => turnFileChanges(split.process), [split.process]);
  const categories = useMemo(() => turnProcessCategories(split.process), [split.process]);
  const processEntries = displayTurn.process.map((entry) => <div key={renderItemKey(entry)} className="turn-process-entry">
    {renderTimelineEntry(entry, processContext, true, !touched)}
  </div>);
  const processBlock = displayTurn.process.length === 0 ? null : live
    ? <div className="turn-process-stack">
      <div className="turn-process-summary turn-process-live-label">
        <span className="turn-process-label">执行操作</span>
        {categories === "" ? null : <span className="turn-process-count">{categories}</span>}
      </div>
      {processEntries}
    </div>
    : <section className={!collapsible ? "turn-process-stack" : `turn-process ${open ? "expanded" : "collapsed"}`}>
      {!collapsible || processId === undefined ? null : <button type="button" className="turn-process-summary" aria-expanded={open} aria-label={turnProcessLabel(summary, categories, changes.length)} onClick={() => onToggleProcess(processId, open)}>
        <ChevronRight size={13} className={`turn-process-chevron${open ? " expanded" : ""}`} aria-hidden />
        <span className="turn-process-label">过程</span>
        {elapsed === undefined ? null : <time className="turn-process-elapsed">{elapsed}</time>}
        {categories === "" ? null : <span className="turn-process-count">{categories}</span>}
        {changes.length === 0 ? null : <span className="turn-process-changes">改了 {changes.length} 个文件</span>}
      </button>}
      {showAll ? <div className={!collapsible ? "turn-process-stack" : "turn-process-body"}>{processEntries}</div> : null}
    </section>;
  return <>
    {turn.user === undefined ? null : renderTimelineEntry({ kind: "message", item: turn.user }, context)}
    {processBlock}
    {split.visible.map((entry) => <div key={renderItemKey(entry)} className="turn-visible-entry">{renderTimelineEntry(entry, { ...processContext, onToggleDetail: (detailId) => onToggleProcessDetail(processId ?? `visible:${turn.key}`, detailId, true), onToggleCall: (_toolId, callId) => onToggleProcessDetail(processId ?? `visible:${turn.key}`, callId, true) }, true, false)}</div>)}
    {turn.final === undefined ? null : renderTimelineEntry({ kind: "message", item: turn.final }, { ...context, showGenerationMeta: !live, generationSummary: summarizeTurnGeneration(turn), onForkMessage: live ? undefined : context.onForkMessage })}
    {live || changes.length === 0 ? null : <TurnChanges changes={changes} cwd={context.workspaceCwd} />}
    {turn.finalError === undefined ? null : <TurnFailureCard items={turn.finalError} failedTool={lastFailedTool(split.process)} onRetry={context.onRetryTurn === undefined || turn.user === undefined ? undefined : () => context.onRetryTurn?.(turn.user!)} onContinue={context.onContinue} />}
  </>;
}

function renderTimelineTurns(turns: TimelineTurn[], streamingMessageId: string | undefined, liveGeneration: LiveGenerationStats | undefined, status: SessionStatus, foldState: TimelineFoldState, onToggleProcess: (id: string, open: boolean) => void, onToggleProcessDetail: (processId: string, detailId: string, parentShowingAll: boolean) => void, onToggleProcessGroup: (processId: string, groupId: string) => void, onExtensionUiRespond: TimelineProps["onExtensionUiRespond"], onEditUserMessage: TimelineProps["onEditUserMessage"], onForkMessage: TimelineProps["onForkMessage"], workspaceCwd: string | undefined, highlightedMessageId: string | undefined, onRetryTurn?: TimelineProps["onRetryTurn"], onContinue?: TimelineProps["onContinue"]): ReactNode[] {
  const context: TurnRenderContext = { streamingMessageId, liveGeneration, status, openDetailIds: foldState.openDetailIds, openGroupIds: foldState.openGroupIds, onToggleDetail: () => undefined, onToggleCall: () => undefined, highlightedMessageId, workspaceCwd, onExtensionUiRespond, onEditUserMessage, onForkMessage, onRetryTurn, onContinue };
  const liveTurnKey = status.runState === "idle" ? undefined : turns.at(-1)?.key;
  return turns.map((turn) => <TimelineTurnBlock key={turn.key} turn={turn} live={turn.key === liveTurnKey} foldState={foldState} {...context} onToggleProcess={onToggleProcess} onToggleProcessDetail={onToggleProcessDetail} onToggleProcessGroup={onToggleProcessGroup} />);
}

/** 超过 3 行或 160 字算较长，默认收成一行；更短的直接展示正文。 */
export const THINKING_FOLD_MAX_LINES = 3;
export const THINKING_FOLD_MAX_CHARS = 160;

export function thinkingTextIsLong(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "").length;
  return lines > THINKING_FOLD_MAX_LINES || trimmed.length > THINKING_FOLD_MAX_CHARS;
}

export function thinkingFoldPreview(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== "")?.trim() ?? "";
  return line.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^#{1,6}\s+/, "");
}

/** 过程里的思考不标「思考」。生成期间始终展开；完成后，较长内容收成一行预览。 */
function ThinkingItem({ item, streaming = false, baseDir, open, showDetails, onToggle }: { item: ThinkingTimelineItem; streaming?: boolean; live?: LiveGenerationStats; baseDir?: string; open: boolean; showDetails: boolean; onToggle: () => void }) {
  const running = item.state === "running";
  if (item.text.trim() === "") return null;
  const foldable = thinkingTextIsLong(item.text);
  const expanded = !foldable || running || (open && showDetails);
  const body = <div className="thinking-body"><div className="message-content"><MarkdownMessage text={item.text} streaming={streaming} baseDir={baseDir} /></div></div>;
  if (!foldable) return <article className={`thinking-item ${item.state}`}>{body}</article>;
  const preview = thinkingFoldPreview(item.text);
  return (
    <article className={`thinking-item ${item.state}${expanded ? " expanded" : ""}`}>
      <button className="thinking-summary" type="button" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? "收起" : preview}>
        <ChevronRight size={13} className={`turn-process-chevron${expanded ? " expanded" : ""}`} aria-hidden />
        {expanded || preview === "" ? null : <span className="thinking-preview">{preview}</span>}
      </button>
      {expanded ? body : null}
    </article>
  );
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}
