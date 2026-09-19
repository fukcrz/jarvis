import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Archive, ArrowDown, Bell, Brain, Check, ChevronRight, CircleAlert, Clock3, Copy, GitBranch, LoaderCircle, Pencil, RefreshCw, X, XCircle } from "lucide-react";
import type { ContextSummaryTimelineItem, ErrorTimelineItem, ExtensionUiRequest, ExtensionUiTimelineItem, MessageTimelineItem, SessionStatus, ThinkingTimelineItem, TimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { formatRunElapsed, getRunFeedback, type RunFeedback } from "../run-feedback";
import { imageDataUrl } from "../lib/image";
import { encodeMultiSelectValue, multiSelectAnswerLabel, parseMultiSelectDialog, parseSelectDialog, previewSummary, selectAnswerLabel, selectDialogTitle, splitDialogHeading, type ExtensionSelectOption } from "../lib/extension-dialog";
import { MarkdownMessage } from "./markdown-message";
import { ImagePreview } from "./image-lightbox";
import { ToolActivity } from "./tool-activity";
import { Dialog, DialogContent } from "./ui/dialog";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";
import { useIsMobile } from "../hooks/use-is-mobile";

interface TimelineProps {
  items: TimelineItem[];
  streamingMessageId?: string;
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
  onEditUserMessage?: (item: MessageTimelineItem, text: string) => Promise<boolean>;
  onForkMessage?: (item: MessageTimelineItem) => void;
  onExtensionUiRespond?: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void | Promise<void>;
  /** 当前工作区根目录：渲染 AI 回复中的相对路径图片时作为基准。 */
  workspaceCwd?: string;
  navigatorOpen?: boolean;
  onNavigatorOpenChange?: (open: boolean) => void;
}

/** Distance from the bottom (px) within which the list is considered "following" the latest content. */
const NEAR_BOTTOM_PX = 72;
/** Hide the jump-to-latest control while the list is still close to the bottom. */
const JUMP_LATEST_PX = 160;
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

function stopFollowingOnGesture(element: HTMLDivElement, setFollowing: (value: boolean) => void, deltaY: number) {
  if (shouldStopFollowingOnGesture(element, deltaY)) setFollowing(false);
}

export interface UserMessageAnchor {
  id: string;
  index: number;
  preview: string;
}

/** Build the prompt-only outline shared by desktop rail and mobile turn list. */
export function userMessageAnchors(items: TimelineItem[]): UserMessageAnchor[] {
  const anchors: UserMessageAnchor[] = [];
  for (const item of items) {
    if (item.kind !== "message" || item.role !== "user") continue;
    anchors.push({ id: item.id, index: anchors.length + 1, preview: userMessagePreview(item) });
  }
  return anchors;
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

function userMessagePreview(item: MessageTimelineItem): string {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text !== "") return text.length > 110 ? `${text.slice(0, 107)}…` : text;
  return (item.images?.length ?? 0) > 0 ? "图片消息" : "空消息";
}

export function Timeline({ items, streamingMessageId, hasMore, loadingMore, onLoadMore, error, notice, onDismissNotice, status, onRetryCompaction, onEditUserMessage, onForkMessage, onExtensionUiRespond, workspaceCwd, navigatorOpen = false, onNavigatorOpenChange }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchYRef = useRef<number | undefined>(undefined);
  const loadingEarlierRef = useRef(false);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const activeNavigationTimerRef = useRef<number | undefined>(undefined);
  const activeNavigationIdRef = useRef<string | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const followingRef = useRef(following);
  followingRef.current = following;
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [activeUserMessageId, setActiveUserMessageId] = useState<string>();
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [markerPositions, setMarkerPositions] = useState<Record<string, number>>({});
  const [loadingAllHistory, setLoadingAllHistory] = useState(false);
  const [fillingViewport, setFillingViewport] = useState(false);
  const [fillViewportRevision, setFillViewportRevision] = useState(0);
  const isMobile = useIsMobile();
  const userMessages = useMemo(() => userMessageAnchors(items), [items]);
  const userMessageKey = userMessages.map((item) => item.id).join(":");
  const feedback = getRunFeedback(status, items, streamingMessageId);
  const hasMatchingTimelineFailure = status.lastError !== undefined && items.some((item) => item.kind === "error" && item.state === "failed" && item.code === status.lastError!.code && item.message === status.lastError!.message);
  const statusIndicatorKey = `${status.runState}:${status.compacting?.reason ?? ""}:${status.compacting?.retrying?.retryAt ?? ""}:${status.retrying?.retryAt ?? ""}:${status.lastError?.occurredAt ?? ""}:${error ?? ""}:${notice ?? ""}`;

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

  useEffect(() => {
    if (!navigatorOpen) {
      setLoadingAllHistory(false);
      return;
    }
    if (hasMore) setLoadingAllHistory(true);
  }, [hasMore, navigatorOpen]);

  useEffect(() => {
    if (!loadingAllHistory) return;
    if (!hasMore) {
      setLoadingAllHistory(false);
      return;
    }
    if (loadingMore) return;
    void loadEarlier().catch(() => setLoadingAllHistory(false));
  }, [hasMore, loadingAllHistory, loadingMore, loadEarlier]);

  const closeNavigator = () => onNavigatorOpenChange?.(false);

  const jumpToUserMessage = (id: string) => {
    activeNavigationIdRef.current = id;
    if (activeNavigationTimerRef.current !== undefined) window.clearTimeout(activeNavigationTimerRef.current);
    activeNavigationTimerRef.current = window.setTimeout(() => {
      activeNavigationIdRef.current = undefined;
      updateActiveUserMessage();
    }, 500);
    setFollowing(false);
    setActiveUserMessageId(id);
    setHighlightedMessageId(id);
    closeNavigator();
    requestAnimationFrame(() => {
      const element = scrollRef.current;
      const target = element === null ? undefined : Array.from(element.querySelectorAll<HTMLElement>("[data-user-message-id]")).find((item) => item.dataset.userMessageId === id);
      if (element === null || target === undefined) return;
      const targetTop = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - Math.min(112, element.clientHeight * 0.22);
      element.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
      setActiveUserMessageId(id);
    });
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightedMessageId(undefined), 1_700);
  };

  return (
    <section className="timeline-shell">
      <TurnNavigator mobile={isMobile} anchors={userMessages} activeId={activeUserMessageId} markerPositions={markerPositions} loadingAll={loadingAllHistory || loadingMore} open={navigatorOpen} onOpenChange={(open) => { if (open) onNavigatorOpenChange?.(true); else closeNavigator(); }} onJump={jumpToUserMessage} />
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
            {renderTimelineTurns(items, streamingMessageId, status, onExtensionUiRespond, onEditUserMessage, onForkMessage, editingMessageId, setEditingMessageId, workspaceCwd, highlightedMessageId, following)}
            {status.compacting === undefined ? null : <CompactingIndicator compacting={status.compacting} />}
            {status.retrying === undefined ? null : <RetryingIndicator retrying={status.retrying} />}
            {notice === undefined ? null : <div className="session-notice" role="status"><span>{notice}</span>{onDismissNotice === undefined ? null : <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={onDismissNotice}><X size={14} /></Button>}</div>}
            {error === undefined ? null : <div className="session-error" role="alert">{error}</div>}
            {status.lastError === undefined || hasMatchingTimelineFailure ? null : <RunFailureCard failure={status.lastError} onRetryCompaction={onRetryCompaction} />}
            {feedback === undefined || hasActiveActivity(items, status) ? null : <WorkingIndicator feedback={feedback} />}
          </div>
        </div>
      </div>
      {showJumpLatest ? <Button variant="ghost" size="icon" className="jump-latest" aria-label="跳转到最新消息" title="跳转到最新消息" onClick={() => { const element = scrollRef.current; if (element !== null) element.scrollTop = element.scrollHeight; setShowJumpLatest(false); setFollowing(true); }}><ArrowDown size={16} /></Button> : null}
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
    return <nav className="timeline-desktop-navigator" aria-label="用户消息导航">
      <span className="timeline-navigator-track" aria-hidden="true" />
      {anchors.map((anchor, index) => <button key={anchor.id} type="button" className={`timeline-navigator-marker${anchor.id === activeId ? " active" : ""}`} style={{ top: `${String((markerPositions[anchor.id] ?? index / Math.max(1, anchors.length - 1)) * 100)}%` }} aria-label={`跳转到第 ${String(anchor.index)} 条用户消息：${anchor.preview}`} aria-current={anchor.id === activeId ? "step" : undefined} onClick={() => onJump(anchor.id)}><span className="timeline-navigator-marker-dot" /><span className="timeline-navigator-preview"><small>第 {String(anchor.index)} 条用户消息</small><strong>{anchor.preview}</strong></span></button>)}
    </nav>;
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="用户消息" className="turn-navigator-dialog">
      {loadingAll ? <div className="timeline-mobile-navigator-status" role="status">加载中</div> : null}
      {anchors.length === 0 ? <div className="timeline-mobile-navigator-empty">暂无用户消息</div> : <div className="timeline-mobile-navigator-list" ref={listRef}>
        {mobileUserMessageRows(anchors).map((anchor) => <button key={anchor.id} type="button" className={`timeline-mobile-navigator-item${anchor.id === active?.id ? " active" : ""}`} aria-current={anchor.id === active?.id ? "true" : undefined} aria-label={`第 ${String(anchor.index)} 条用户消息`} onClick={() => onJump(anchor.id)}><span>{formatUserMessageIndex(anchor.index)}</span><strong>{anchor.preview}</strong></button>)}
      </div>}
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

function RunFailureCard({ failure, onRetryCompaction }: { failure: NonNullable<SessionStatus["lastError"]>; onRetryCompaction: TimelineProps["onRetryCompaction"] }) {
  const [open, setOpen] = useState(false);
  const compactionFailed = failure.code === "PI_COMPACTION_FAILED";
  const occurredAt = formatFailureTime(failure.occurredAt);
  const requestId = requestIdFromMessage(failure.message);
  const title = compactionFailed ? "上下文压缩未完成" : "本次任务未完成";
  const summary = compactionFailed ? "压缩没有生成可用摘要，任务已停止。" : undefined;

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
  const details = items.length > 1 || latest.diagnostics !== undefined;
  const summary = retryLabel === undefined
    ? (attemptCount === undefined ? errorSummary(latest.message) : `${attemptCount}：${errorSummary(latest.message)}`)
    : `${retryLabel}：${errorSummary(latest.message)}`;
  return <article className={`timeline-event timeline-error ${latest.state}`} role={latest.state === "failed" ? "alert" : "status"}>
    <button className="timeline-event-summary timeline-error-header" type="button" aria-expanded={open} onClick={() => setOpen((value) => details ? !value : value)}>
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

const MessageItem = memo(function MessageItem({ item, streaming, editing, highlighted, onStartEdit, onCancelEdit, onEdit, onFork, baseDir }: { item: Extract<TimelineItem, { kind: "message" }>; streaming: boolean; editing: boolean; highlighted: boolean; onStartEdit: () => void; onCancelEdit: () => void; onEdit?: TimelineProps["onEditUserMessage"]; onFork?: (item: MessageTimelineItem) => void; baseDir?: string }) {
  const images = item.images ?? [];
  const [draft, setDraft] = useState(item.text);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (!editing) setDraft(item.text); }, [editing, item.text]);
  const submitEdit = async () => {
    if (onEdit === undefined || submitting || (draft.trim() === "" && images.length === 0)) return;
    setSubmitting(true);
    const sent = await onEdit(item, draft);
    setSubmitting(false);
    if (sent) onCancelEdit();
  };
  return (
    <article data-user-message-id={item.role === "user" ? item.id : undefined} className={`message-row ${item.role} ${streaming ? "streaming" : ""} ${editing ? "editing" : ""} ${highlighted ? "navigator-highlight" : ""}`}>
      <div className={`message-body ${item.role}`}>
        {images.length === 0 ? null : <div className="message-images" aria-label="消息图片">
          {images.map((image, index) => <ImagePreview key={`${image.mimeType}:${index}`} src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`}><button type="button" className="message-image-thumb" aria-label={`预览图片 ${String(index + 1)}`}><img src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`} loading="lazy" /></button></ImagePreview>)}
        </div>}
        {editing ? <div className="message-inline-editor"><textarea autoFocus value={draft} disabled={submitting} aria-label="编辑消息" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancelEdit(); } if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submitEdit(); } }} /><div className="message-inline-editor-actions"><button type="button" disabled={submitting} onClick={onCancelEdit}>取消</button><button type="button" className="accent" disabled={submitting || (draft.trim() === "" && images.length === 0)} onClick={() => { void submitEdit(); }}>{submitting ? "正在重新生成…" : "重新生成"}</button></div></div> : item.text === "" ? null : <div className={`message-content ${streaming ? "streaming" : ""}`}>
          <MarkdownMessage text={item.text} streaming={streaming} baseDir={baseDir} interactiveFiles={item.role === "assistant" && !streaming} />
        </div>}
        {editing ? null : <MessageActions item={item} streaming={streaming} onEdit={onEdit === undefined ? undefined : onStartEdit} onFork={onFork} />}
      </div>
    </article>
  );
});

function MessageActions({ item, streaming, onEdit, onFork }: { item: MessageTimelineItem; streaming: boolean; onEdit?: () => void; onFork?: (item: MessageTimelineItem) => void }) {
  const [copied, setCopied] = useState(false);
  if (streaming || item.role !== "user") return null;
  const canCopy = item.text !== "";
  if (!canCopy && onEdit === undefined && onFork === undefined) return null;
  const handleCopy = () => {
    void navigator.clipboard.writeText(item.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return <div className="message-actions">
    {!canCopy ? null : <Tooltip label={copied ? "已复制" : "复制消息"}>
      <button type="button" className={`message-action-button${copied ? " copied" : ""}`} aria-label={copied ? "已复制消息" : "复制消息"} onClick={handleCopy}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
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

function ExtensionUiOperation({ item, onRespond }: { item: ExtensionUiTimelineItem; onRespond: TimelineProps["onExtensionUiRespond"] }) {
  if (item.request.method === "notify") return <ExtensionNotification item={item} />;
  return <ExtensionDialogOperation item={item} onRespond={onRespond} />;
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

/** 最后一段连续工具条目的首条 id：把运行中的耗时计时交给真正活跃的那一组。 */
function lastActivityGroupId(items: TimelineItem[]): string | undefined {
  const lastToolIndex = items.reduce((last, item, index) => item.kind === "tool" ? index : last, -1);
  if (lastToolIndex === -1) return undefined;
  let start = lastToolIndex;
  while (start > 0 && items[start - 1]?.kind === "tool") start -= 1;
  return items[start]?.id;
}

export interface TimelineTurn {
  /** React key 与折叠状态的依据。 */
  key: string;
  /** 触发该回合的用户消息；历史分页从回合中间开始时没有。 */
  user?: MessageTimelineItem;
  /** 折叠进「过程」的条目：思考、工具组、过程文本、错误、上下文事件。 */
  process: TimelineRenderItem[];
  /** 留在折叠外作为最终汇报的 assistant 文本。 */
  final?: MessageTimelineItem;
  /** 回合末尾未恢复的错误，留在过程折叠外。 */
  finalError?: ErrorTimelineItem[];
}

/** 以用户消息为界把渲染条目组成回合，并把回合最后一条 assistant 文本或末尾失败卡提到折叠外。 */
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
    (current ?? openTurn(`turn:${renderItemKey(entry)}`)).process.push(entry);
  }
  for (const turn of turns) {
    // 只有它确实是回合最后一条时才外提，否则会把后发生的过程条目排到最终汇报之前。
    const last = turn.process.at(-1);
    if (last?.kind === "message" && last.item.role === "assistant") {
      turn.final = last.item;
      turn.process.pop();
    } else if (last?.kind === "error" && last.items.some((item) => item.state === "failed")) {
      turn.finalError = last.items;
      turn.process.pop();
    }
  }
  return turns;
}

/** 短过程旁白；更长的助手文本不当旁白，避免把整段汇报收进工具组。 */
export const ACTIVITY_NARRATION_MAX_CHARS = 100;

export function isShortAssistantNarration(item: MessageTimelineItem): boolean {
  if (item.role !== "assistant") return false;
  if ((item.images?.length ?? 0) > 0) return false;
  const length = [...item.text.trim()].length;
  return length > 0 && length <= ACTIVITY_NARRATION_MAX_CHARS;
}

/** 短旁白紧挨着后面一组工具时，旁白作为可点标题，工具默认收在下面。 */
export function isActivityNarratedBy(previous: TimelineRenderItem | undefined, entry: TimelineRenderItem): boolean {
  return entry.kind === "activity" && previous?.kind === "message" && isShortAssistantNarration(previous.item);
}

function renderItemKey(entry: TimelineRenderItem): string {
  return entry.kind === "activity" || entry.kind === "error" ? entry.items[0]?.id ?? "empty" : entry.item.id;
}

function renderItemRange(entry: TimelineRenderItem): { start?: string; end?: string } {
  const items: Array<{ createdAt: string }> = entry.kind === "activity" || entry.kind === "error" ? entry.items : [entry.item];
  return { start: items[0]?.createdAt, end: items.at(-1)?.createdAt };
}

export interface TurnProcessSummary {
  /** 工具调用总数。 */
  operations: number;
  durationMs?: number;
}

function processStartAt(turn: TimelineTurn): string | undefined {
  const first = turn.process.at(0);
  return first === undefined ? undefined : renderItemRange(first).start;
}

function processEndAt(turn: TimelineTurn): string | undefined {
  const last = turn.process.at(-1);
  return last === undefined ? undefined : renderItemRange(last).end;
}

export function summarizeTurnProcess(turn: TimelineTurn): TurnProcessSummary {
  let operations = 0;
  for (const entry of turn.process) {
    if (entry.kind === "activity") operations += entry.items.length;
  }
  const start = Date.parse(processStartAt(turn) ?? "");
  const end = Date.parse(processEndAt(turn) ?? "");
  const durationMs = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : undefined;
  return { operations, ...(durationMs === undefined ? {} : { durationMs }) };
}

/** 单条思考/工具组/事件本身就是一行摘要，再套一层折叠没有收益；过程文本可能很长，值得折。 */
export function shouldFoldTurnProcess(turn: TimelineTurn): boolean {
  if (turn.process.length >= 2) return true;
  return turn.process.at(0)?.kind === "message";
}

/** 等待用户响应的扩展交互，或用户主动执行的 !cmd（`bash:` 前缀）：默认展开，不去藏需要人看的内容。 */
export function isTurnPinned(turn: TimelineTurn): boolean {
  return turn.process.some((entry) =>
    (entry.kind === "extension-ui" && entry.item.outcome === undefined)
    || (entry.kind === "activity" && entry.items.some((item) => item.id.startsWith("bash:"))));
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
function turnProcessLabel(summary: TurnProcessSummary): string {
  const seconds = summary.durationMs === undefined ? 0 : Math.round(summary.durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  return [
    "过程",
    ...(summary.operations === 0 ? [] : [`${String(summary.operations)} 项操作`]),
    ...(summary.durationMs === undefined ? [] : [`用时 ${minutes === 0 ? `${String(seconds)} 秒` : `${String(minutes)} 分 ${String(seconds % 60)} 秒`}`]),
  ].join("，");
}

interface TurnRenderContext {
  streamingMessageId?: string;
  status: SessionStatus;
  activeActivityId?: string;
  editingMessageId?: string;
  highlightedMessageId?: string;
  workspaceCwd?: string;
  onExtensionUiRespond?: TimelineProps["onExtensionUiRespond"];
  onEditUserMessage?: TimelineProps["onEditUserMessage"];
  onForkMessage?: TimelineProps["onForkMessage"];
  setEditingMessageId: (id: string | undefined) => void;
}

function renderTimelineEntry(entry: TimelineRenderItem, context: TurnRenderContext, narration?: string): ReactNode {
  if (entry.kind === "message") return <MessageItem key={entry.item.id} item={entry.item} streaming={entry.item.id === context.streamingMessageId} editing={entry.item.id === context.editingMessageId} highlighted={entry.item.id === context.highlightedMessageId} onStartEdit={() => context.setEditingMessageId(entry.item.id)} onCancelEdit={() => context.setEditingMessageId(undefined)} onEdit={context.onEditUserMessage} onFork={entry.item.role === "user" ? context.onForkMessage : undefined} baseDir={context.workspaceCwd} />;
  if (entry.kind === "error") return <ErrorItem key={`error:${entry.items[0]?.id ?? "empty"}`} items={entry.items} />;
  if (entry.kind === "context-summary") return <ContextSummaryItem key={entry.item.id} item={entry.item} baseDir={context.workspaceCwd} />;
  if (entry.kind === "extension-ui") return <ExtensionUiOperation key={entry.item.id} item={entry.item} onRespond={context.onExtensionUiRespond} />;
  if (entry.kind === "thinking") return <ThinkingItem key={entry.item.id} item={entry.item} baseDir={context.workspaceCwd} />;
  return <ToolActivity key={`activity:${entry.items[0]?.id ?? "empty"}`} items={entry.items} active={entry.items[0]?.id === context.activeActivityId} narration={narration} />;
}

/** 短旁白并进工具组：旁白当折叠标题，不再单独画一条消息。 */
function renderProcessEntries(process: TimelineRenderItem[], context: TurnRenderContext): ReactNode[] {
  return process.flatMap((entry, index) => {
    const next = process[index + 1];
    if (next !== undefined && isActivityNarratedBy(entry, next)) return [];
    const previous = process[index - 1];
    const narration = previous?.kind === "message" && isActivityNarratedBy(previous, entry) ? previous.item.text : undefined;
    return [renderTimelineEntry(entry, context, narration)];
  });
}

function TimelineTurnBlock({ turn, active, autoCollapse, ...context }: TurnRenderContext & { turn: TimelineTurn; active: boolean; autoCollapse: boolean }) {
  const foldable = shouldFoldTurnProcess(turn);
  const summary = summarizeTurnProcess(turn);
  // 最终汇报或末尾失败卡会留在折叠外；过程本身可以收起。等待交互或 !cmd 仍钉住。
  const pinned = isTurnPinned(turn);
  const canAutoCollapse = (turn.final !== undefined || turn.finalError !== undefined) && !pinned;
  // 运行中不出现折叠行：过程和以前一样直接铺在时间线上。
  const collapsible = foldable && canAutoCollapse && !active;
  const [open, setOpen] = useState(() => active || !canAutoCollapse);
  const touched = useRef(false);
  const wasActive = useRef(active);

  useEffect(() => {
    const startedRunning = wasActive.current !== active;
    wasActive.current = active;
    if (touched.current) return;
    if (active) {
      setOpen(true);
      return;
    }
    // 刚结束、而用户正在往上读的时候不动布局；他滚回底部（autoCollapse 变真）后再收起。
    if (startedRunning && !autoCollapse) return;
    setOpen(!canAutoCollapse);
  }, [active, autoCollapse, canAutoCollapse]);

  const elapsed = summary.durationMs === undefined ? undefined : formatProcessElapsed(summary.durationMs);
  const process = renderProcessEntries(turn.process, context);
  const processBlock = process.length === 0 ? null : !collapsible
    ? <div className="turn-process-stack">{process}</div>
    : <section className={`turn-process ${open ? "expanded" : "collapsed"}`}>
      <button type="button" className="turn-process-summary" aria-expanded={open} aria-label={turnProcessLabel(summary)} onClick={() => { touched.current = true; setOpen((value) => !value); }}>
        <ChevronRight size={13} className={`turn-process-chevron${open ? " expanded" : ""}`} aria-hidden />
        <span className="turn-process-label">过程</span>
        {summary.operations === 0 ? null : <span className="turn-process-count">{summary.operations} 项操作</span>}
        {elapsed === undefined ? null : <time className="turn-process-elapsed">{elapsed}</time>}
      </button>
      {!open ? null : <div className="turn-process-body">{process}</div>}
    </section>;
  return <>
    {turn.user === undefined ? null : renderTimelineEntry({ kind: "message", item: turn.user }, context)}
    {processBlock}
    {turn.final === undefined ? null : renderTimelineEntry({ kind: "message", item: turn.final }, context)}
    {turn.finalError === undefined ? null : renderTimelineEntry({ kind: "error", items: turn.finalError }, context)}
  </>;
}

function renderTimelineTurns(items: TimelineItem[], streamingMessageId: string | undefined, status: SessionStatus, onExtensionUiRespond: TimelineProps["onExtensionUiRespond"], onEditUserMessage: TimelineProps["onEditUserMessage"], onForkMessage: TimelineProps["onForkMessage"], editingMessageId: string | undefined, setEditingMessageId: (id: string | undefined) => void, workspaceCwd: string | undefined, highlightedMessageId: string | undefined, autoCollapse: boolean): ReactNode[] {
  const turns = groupTimelineTurns(items);
  const activeActivityId = isToolActivityRunning(items, status) ? lastActivityGroupId(items) : undefined;
  const activeTurnKey = status.runState === "idle" ? undefined : turns.at(-1)?.key;
  const context: TurnRenderContext = { streamingMessageId, status, activeActivityId, editingMessageId, highlightedMessageId, workspaceCwd, onExtensionUiRespond, onEditUserMessage, onForkMessage, setEditingMessageId };
  // 全部属性都显式传：TurnRenderContext 的键名与组件 props 一致，展开时不会漏项。
  return turns.map((turn) => <TimelineTurnBlock key={turn.key} turn={turn} active={turn.key === activeTurnKey} autoCollapse={autoCollapse} {...context} />);
}

function ThinkingItem({ item, baseDir }: { item: ThinkingTimelineItem; baseDir?: string }) {
  // 思考时默认展开看流式内容；思考结束后自动收起成一行标题。
  const [open, setOpen] = useState(() => item.state === "running");
  const wasRunning = useRef(item.state === "running");
  useEffect(() => {
    if (wasRunning.current && item.state === "completed") {
      setOpen(false);
      wasRunning.current = false;
    } else if (item.state === "running") {
      wasRunning.current = true;
    }
  }, [item.state]);
  return (
    <article className={`thinking-item ${item.state}`}>
      <button className="thinking-summary" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="thinking-state-icon">{item.state === "running" ? <LoaderCircle size={14} className="spin" /> : <Brain size={14} />}</span>
        <span className="thinking-title">{item.state === "running" ? "思考中" : "思考"}</span>
        {item.state === "running" ? <ElapsedClock startedAt={item.createdAt} /> : null}
      </button>
      {open ? <div className="thinking-details"><div className="message-content"><MarkdownMessage text={item.text} streaming={item.state === "running"} baseDir={baseDir} /></div></div> : null}
    </article>
  );
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}
