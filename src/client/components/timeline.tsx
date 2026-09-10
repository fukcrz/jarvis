import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Archive, ArrowDown, Bell, Brain, Check, ChevronRight, CircleAlert, Clock3, Copy, GitBranch, ListTree, LoaderCircle, Pencil, RefreshCw, X, XCircle } from "lucide-react";
import type { ContextSummaryTimelineItem, ErrorTimelineItem, ExtensionUiRequest, ExtensionUiTimelineItem, MessageTimelineItem, SessionStatus, ThinkingTimelineItem, TimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { formatRunElapsed, getRunFeedback, type RunFeedback } from "../run-feedback";
import { imageDataUrl } from "../lib/image";
import { parseSelectDialog, previewSummary, selectAnswerLabel, selectDialogTitle, splitDialogHeading, type ExtensionSelectOption } from "../lib/extension-dialog";
import { MarkdownMessage } from "./markdown-message";
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
}

/** Distance from the bottom (px) within which the list is considered "following" the latest content. */
const NEAR_BOTTOM_PX = 72;
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

function stopFollowingOnGesture(element: HTMLDivElement, setFollowing: (value: boolean) => void, deltaY: number) {
  if (shouldStopFollowingOnGesture(element, deltaY)) setFollowing(false);
}

export interface UserMessageAnchor {
  id: string;
  preview: string;
}

/** Build the prompt-only outline shared by desktop rail and mobile turn list. */
export function userMessageAnchors(items: TimelineItem[]): UserMessageAnchor[] {
  return items.flatMap((item) => {
    if (item.kind !== "message" || item.role !== "user") return [];
    return [{ id: item.id, preview: userMessagePreview(item) }];
  });
}

function userMessagePreview(item: MessageTimelineItem): string {
  const text = item.text.replace(/\s+/g, " ").trim();
  if (text !== "") return text.length > 110 ? `${text.slice(0, 107)}…` : text;
  return (item.images?.length ?? 0) > 0 ? "图片消息" : "空消息";
}

export function Timeline({ items, streamingMessageId, hasMore, loadingMore, onLoadMore, error, notice, onDismissNotice, status, onRetryCompaction, onEditUserMessage, onForkMessage, onExtensionUiRespond, workspaceCwd }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchYRef = useRef<number | undefined>(undefined);
  const loadingEarlierRef = useRef(false);
  const highlightTimerRef = useRef<number | undefined>(undefined);
  const activeNavigationTimerRef = useRef<number | undefined>(undefined);
  const activeNavigationIdRef = useRef<string | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const [activeUserMessageId, setActiveUserMessageId] = useState<string>();
  const [highlightedMessageId, setHighlightedMessageId] = useState<string>();
  const [markerPositions, setMarkerPositions] = useState<Record<string, number>>({});
  const [navigatorOpen, setNavigatorOpen] = useState(false);
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
    if (element === null || !following) return;
    element.scrollTop = element.scrollHeight;
  }, [items, streamingMessageId, feedback?.label, following, statusIndicatorKey]);

  const loadEarlier = async () => {
    if (!hasMore || loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    const element = scrollRef.current;
    const offset = element === null ? 0 : element.scrollHeight - element.scrollTop;
    try {
      await onLoadMore();
    } finally {
      requestAnimationFrame(() => {
        if (scrollRef.current === element && element !== null) element.scrollTop = element.scrollHeight - offset;
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
    if (!loadingAllHistory) return;
    if (!hasMore) {
      setLoadingAllHistory(false);
      return;
    }
    if (loadingMore) return;
    void loadEarlier().catch(() => setLoadingAllHistory(false));
  }, [hasMore, loadingAllHistory, loadingMore, loadEarlier]);

  const openNavigator = () => {
    setNavigatorOpen(true);
    if (hasMore) setLoadingAllHistory(true);
  };

  const jumpToUserMessage = (id: string) => {
    const element = scrollRef.current;
    const target = element === null ? undefined : Array.from(element.querySelectorAll<HTMLElement>("[data-user-message-id]")).find((item) => item.dataset.userMessageId === id);
    if (element === null || target === undefined) return;
    const targetTop = target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - Math.min(112, element.clientHeight * 0.22);
    activeNavigationIdRef.current = id;
    if (activeNavigationTimerRef.current !== undefined) window.clearTimeout(activeNavigationTimerRef.current);
    activeNavigationTimerRef.current = window.setTimeout(() => {
      activeNavigationIdRef.current = undefined;
      updateActiveUserMessage();
    }, 500);
    setFollowing(false);
    setActiveUserMessageId(id);
    setHighlightedMessageId(id);
    requestAnimationFrame(() => {
      if (scrollRef.current === element) {
        element.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
        setActiveUserMessageId(id);
      }
    });
    if (highlightTimerRef.current !== undefined) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlightedMessageId(undefined), 1_700);
    setNavigatorOpen(false);
  };

  return (
    <section className="timeline-shell">
      <div className="timeline" ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX);
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
      <TurnNavigator mobile={isMobile} anchors={userMessages} activeId={activeUserMessageId} markerPositions={markerPositions} hasMore={hasMore} loadingAll={loadingAllHistory || loadingMore} open={navigatorOpen} onOpenChange={(open) => { setNavigatorOpen(open); if (!open) setLoadingAllHistory(false); }} onOpen={openNavigator} onJump={jumpToUserMessage} />
      {!following ? <Button variant="ghost" size="icon" className="jump-latest" aria-label="跳转到最新消息" title="跳转到最新消息" onClick={() => { const element = scrollRef.current; if (element !== null) element.scrollTop = element.scrollHeight; setFollowing(true); }}><ArrowDown size={16} /></Button> : null}
    </section>
  );
}

function TurnNavigator({ mobile, anchors, activeId, markerPositions, hasMore, loadingAll, open, onOpenChange, onOpen, onJump }: { mobile: boolean; anchors: UserMessageAnchor[]; activeId?: string; markerPositions: Record<string, number>; hasMore: boolean; loadingAll: boolean; open: boolean; onOpenChange: (open: boolean) => void; onOpen: () => void; onJump: (id: string) => void }) {
  if (anchors.length === 0) return null;
  if (!mobile) return <nav className="timeline-desktop-navigator" aria-label="用户消息导航">
    <span className="timeline-navigator-track" aria-hidden="true" />
    {anchors.map((anchor, index) => <button key={anchor.id} type="button" className={`timeline-navigator-marker${anchor.id === activeId ? " active" : ""}`} style={{ top: `${String((markerPositions[anchor.id] ?? index / Math.max(1, anchors.length - 1)) * 100)}%` }} aria-label={`跳转到第 ${String(index + 1)} 条用户消息：${anchor.preview}`} aria-current={anchor.id === activeId ? "step" : undefined} onClick={() => onJump(anchor.id)}><span className="timeline-navigator-marker-dot" /><span className="timeline-navigator-preview"><small>第 {String(index + 1)} 条用户消息</small><strong>{anchor.preview}</strong></span></button>)}
  </nav>;
  return <>
    <Button variant="ghost" size="icon" className="timeline-mobile-navigator-trigger" aria-label="浏览用户消息" title="浏览用户消息" onClick={onOpen}><ListTree size={17} /></Button>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="用户消息" description="点击任一消息可跳转到对应轮次。" className="turn-navigator-dialog">
        <div className="turn-navigator-status"><span>{anchors.length} 条已加载</span>{hasMore || loadingAll ? <span>{loadingAll ? "正在加载完整历史…" : "可加载更早历史"}</span> : <span>完整历史</span>}</div>
        <div className="turn-navigator-list">
          {anchors.map((anchor, index) => <button key={anchor.id} type="button" className={`turn-navigator-item${anchor.id === activeId ? " active" : ""}`} aria-current={anchor.id === activeId ? "step" : undefined} onClick={() => onJump(anchor.id)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{anchor.preview}</strong></button>)}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

function WorkingIndicator({ feedback }: { feedback: RunFeedback }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [feedback.startedAt, feedback.label, feedback.tone]);

  const elapsed = formatRunElapsed(feedback.startedAt, now);
  return <div className={`working-indicator ${feedback.tone}`} role="status" aria-live="polite">
    <LoaderCircle className="spin" size={15} />
    <span>{feedback.label}</span>
    {elapsed === undefined ? null : <time>{elapsed}</time>}
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
  return <RunStatusIndicator className="compacting-indicator" icon={<LoaderCircle className="spin" size={15} />} label={label} detail={retrying === undefined ? undefined : `摘要生成失败，正在重试（${String(retrying.attempt)}/${String(retrying.maxAttempts)}）：${retrying.errorMessage}`} retrying={retrying} />;
}

function RunStatusIndicator({ className, icon, label, detail, retrying }: { className: string; icon: ReactNode; label: string; detail?: string; retrying?: NonNullable<SessionStatus["retrying"]> }) {
  return <div className={className} role="status" aria-live="polite">
    <span className="run-status-icon">{icon}</span>
    <span className="run-status-copy"><strong>{label}</strong>{detail === undefined ? null : <span>{detail}</span>}</span>
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
  const summary = compactionFailed
    ? "压缩没有生成可用摘要，任务已停止。"
    : "任务已停止，可以查看诊断信息后继续操作。";

  return <article className="timeline-event run-failure" role="alert">
    <button className="timeline-event-summary run-failure-header" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="run-failure-icon"><CircleAlert size={16} /></span>
      <span className="run-failure-copy"><strong>{title}</strong><span>{summary}</span></span>
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

function ErrorItem({ items, retrying }: { items: ErrorTimelineItem[]; retrying: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = items.at(-1)!;
  if (retrying && latest.state === "retrying") return null;
  const stateLabel = latest.state === "retrying" ? "正在重试" : latest.state === "recovered" ? "已恢复" : "操作未完成";
  const retryLabel = latest.attempt === undefined || latest.maxAttempts === undefined ? undefined : `第 ${String(latest.attempt)} / ${String(latest.maxAttempts)} 次尝试`;
  const details = items.length > 1 || latest.diagnostics !== undefined;
  return <article className={`timeline-event timeline-error ${latest.state}`} role={latest.state === "failed" ? "alert" : "status"}>
    <button className="timeline-event-summary timeline-error-header" type="button" aria-expanded={open} onClick={() => setOpen((value) => details ? !value : value)}>
      {latest.state === "recovered" ? <Check size={15} /> : latest.state === "retrying" ? <LoaderCircle className="spin" size={15} /> : <CircleAlert size={15} />}
      <div className="timeline-error-copy"><strong>{stateLabel}</strong><span>{retryLabel === undefined ? errorSummary(latest.message) : `${retryLabel}：${errorSummary(latest.message)}`}</span></div>
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
  const [previewIndex, setPreviewIndex] = useState<number>();
  const [draft, setDraft] = useState(item.text);
  const [submitting, setSubmitting] = useState(false);
  const preview = previewIndex === undefined ? undefined : images[previewIndex];
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
          {images.map((image, index) => <button key={`${image.mimeType}:${index}`} type="button" className="message-image-thumb" aria-label={`预览图片 ${index + 1}`} onClick={() => setPreviewIndex(index)}><img src={imageDataUrl(image)} alt={`图片 ${index + 1}`} loading="lazy" /></button>)}
        </div>}
        {editing ? <div className="message-inline-editor"><textarea autoFocus value={draft} disabled={submitting} aria-label="编辑消息" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCancelEdit(); } if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void submitEdit(); } }} /><div className="message-inline-editor-actions"><button type="button" disabled={submitting} onClick={onCancelEdit}>取消</button><button type="button" className="accent" disabled={submitting || (draft.trim() === "" && images.length === 0)} onClick={() => { void submitEdit(); }}>{submitting ? "正在重新生成…" : "重新生成"}</button></div><small>发送后将从此消息重新生成后续回答 · Ctrl / Cmd + Enter 提交</small></div> : item.text === "" ? null : <div className={`message-content ${streaming ? "streaming" : ""}`}>
          <MarkdownMessage text={item.text} streaming={streaming} baseDir={baseDir} />
        </div>}
        {editing ? null : <MessageActions item={item} streaming={streaming} onEdit={onEdit === undefined ? undefined : onStartEdit} onFork={onFork} />}
        {preview === undefined ? null : <div className="image-lightbox" role="dialog" aria-label={`预览图片 ${previewIndex! + 1}`} onClick={() => setPreviewIndex(undefined)}>
          <button type="button" className="image-lightbox-close" aria-label="关闭图片预览" onClick={() => setPreviewIndex(undefined)}><XCircle size={20} /></button>
          <img src={imageDataUrl(preview)} alt={`图片 ${previewIndex! + 1}`} onClick={(event) => event.stopPropagation()} />
        </div>}
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
  }, [request, setValue]);

  // 对话框落定（已答/取消/超时/关闭）后不再需要草稿。
  useEffect(() => {
    if (item.outcome === undefined) return;
    dialogDrafts.delete(request.id);
  }, [item.outcome, request.id]);

  const respond = (response: ExtensionResponse) => {
    if (item.outcome !== undefined || submitting || onRespond === undefined) return;
    setSubmitting(true);
    Promise.resolve(onRespond(request.id, response)).catch(() => setSubmitting(false));
  };
  // 扩展回退格式的选项带序号/描述/预览；解析不出来时按原始字符串渲染。
  const dialog = useMemo(() => request.method === "select" ? parseSelectDialog(request) : undefined, [request]);
  const choices: ExtensionSelectOption[] = request.method === "select"
    ? dialog?.options ?? request.options.map((option) => ({ value: option, label: option }))
    : [];
  const togglePreview = (index: number) => {
    setExpandedPreviews((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const onSelectKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (request.method !== "select") return;
    // 预览开关是同一容器里的独立控件：它自己的 Enter/Space 不能被选项导航抢走（否则会误提交）。
    if (event.target instanceof HTMLElement && event.target.closest(".extension-select-preview") !== null) return;
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
      respond({ value: choice.value });
    }
  };

  if (item.outcome !== undefined) return <ExtensionResult item={item} expanded={showResult} onToggle={() => setShowResult((current) => !current)} />;
  const title = dialog === undefined ? request.title : selectDialogTitle(dialog);
  // 非选择卡（确认/输入/编辑）的标题也带扩展自己拼的信息，同样拆出短标签、保留换行结构。
  const heading = request.method === "select" ? undefined : splitDialogHeading(request.title);
  return <article className={`extension-operation pending ${request.method}`} aria-label={`扩展操作：${title}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); respond({ cancelled: true }); } }}>
    <div className="extension-operation-heading"><Clock3 size={14} /><span>{extensionOperationPrompt(request.method)}</span><ExtensionTimeout timeout={request.timeout} createdAt={item.createdAt} /></div>
    {request.method === "select" ? <div className="extension-operation-title-row"><p className="extension-operation-title extension-dialog-question">{dialog?.header === undefined ? null : <span className="extension-dialog-header">{dialog.header}</span>}{dialog?.question ?? request.title}</p><button type="button" className="extension-dock-close" aria-label="取消选择" disabled={submitting} onClick={() => respond({ cancelled: true })}><X size={16} /></button></div> : <p className="extension-operation-title extension-dialog-question">{heading?.header === undefined ? null : <span className="extension-dialog-header">{heading.header}</span>}{heading?.question ?? request.title}</p>}
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
    {request.method === "input" ? <input autoFocus className="extension-dialog-input" placeholder={request.placeholder} value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); respond({ value }); } }} /> : null}
    {request.method === "editor" ? <textarea autoFocus className="extension-dialog-input multiline" value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); respond({ value }); } }} rows={8} /> : null}
    {request.method === "select" ? null : <div className="extension-interaction-actions">
      {request.method === "confirm" ? <><button type="button" disabled={submitting} onClick={() => respond({ confirmed: false })}>拒绝</button><button type="button" className="accent" disabled={submitting} onClick={() => respond({ confirmed: true })}>{submitting ? "正在处理…" : "允许"}</button></> : <><button type="button" disabled={submitting} onClick={() => respond({ cancelled: true })}>取消</button><button type="button" className="accent" disabled={submitting} onClick={() => respond({ value })}>{submitting ? "正在提交…" : request.method === "editor" ? "提交修改" : "提交"}</button></>}
    </div>}
    {request.method === "editor" ? <small className="extension-interaction-hint">按 Ctrl / Cmd + Enter 提交</small> : null}
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
  const canExpand = item.outcome === "answered" && (request.method === "input" || request.method === "editor") && item.value !== undefined && item.value !== "";
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
        const groupId = item.groupId ?? item.id;
        if (previous?.kind === "error" && (previous.items[0]?.groupId ?? previous.items[0]?.id) === groupId) previous.items.push(item);
        else result.push({ kind: "error", items: [item] });
      } else if (item.kind === "extension-ui") result.push({ kind: "extension-ui", item });
      else if (item.kind === "thinking") result.push({ kind: "thinking", item });
      else result.push({ kind: "context-summary", item });
    }
  }
  flushTools();
  return result;
}

function hasActiveActivity(items: TimelineItem[], status: SessionStatus): boolean {
  if (status.runState === "idle") return false;
  const last = items.at(-1);
  return last?.kind === "tool" || (last?.kind === "thinking" && last.state === "running");
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
}

/** 以用户消息为界把渲染条目组成回合，并把回合最后一条 assistant 文本提为最终汇报。 */
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
    }
  }
  return turns;
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

/** 回合以未恢复的错误收尾时保持展开。 */
export function turnEndedInFailure(turn: TimelineTurn): boolean {
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

function renderTimelineEntry(entry: TimelineRenderItem, context: TurnRenderContext): ReactNode {
  if (entry.kind === "message") return <MessageItem key={entry.item.id} item={entry.item} streaming={entry.item.id === context.streamingMessageId} editing={entry.item.id === context.editingMessageId} highlighted={entry.item.id === context.highlightedMessageId} onStartEdit={() => context.setEditingMessageId(entry.item.id)} onCancelEdit={() => context.setEditingMessageId(undefined)} onEdit={context.onEditUserMessage} onFork={entry.item.role === "user" ? context.onForkMessage : undefined} baseDir={context.workspaceCwd} />;
  if (entry.kind === "error") return <ErrorItem key={`error:${entry.items[0]?.id ?? "empty"}`} items={entry.items} retrying={context.status.retrying !== undefined} />;
  if (entry.kind === "context-summary") return <ContextSummaryItem key={entry.item.id} item={entry.item} baseDir={context.workspaceCwd} />;
  if (entry.kind === "extension-ui") return <ExtensionUiOperation key={entry.item.id} item={entry.item} onRespond={context.onExtensionUiRespond} />;
  if (entry.kind === "thinking") return <ThinkingItem key={entry.item.id} item={entry.item} baseDir={context.workspaceCwd} />;
  return <ToolActivity key={`activity:${entry.items[0]?.id ?? "empty"}`} items={entry.items} active={entry.items[0]?.id === context.activeActivityId} startedAt={context.status.activeRun?.startedAt} stopping={context.status.runState === "stopping"} />;
}

function TimelineTurnBlock({ turn, active, autoCollapse, ...context }: TurnRenderContext & { turn: TimelineTurn; active: boolean; autoCollapse: boolean }) {
  const foldable = shouldFoldTurnProcess(turn);
  const summary = summarizeTurnProcess(turn);
  // 只有拿到最终汇报、且不需要人工介入、也没有以失败收尾的回合才收起过程。
  const pinned = isTurnPinned(turn);
  const failed = turnEndedInFailure(turn);
  const canAutoCollapse = turn.final !== undefined && !pinned && !failed;
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
  const process = turn.process.map((entry) => renderTimelineEntry(entry, context));
  return <>
    {turn.user === undefined ? null : renderTimelineEntry({ kind: "message", item: turn.user }, context)}
    {!collapsible ? process : <section className={`turn-process ${open ? "expanded" : "collapsed"}`}>
      <button type="button" className="turn-process-summary" aria-expanded={open} aria-label={turnProcessLabel(summary)} onClick={() => { touched.current = true; setOpen((value) => !value); }}>
        <ChevronRight size={13} className={`turn-process-chevron${open ? " expanded" : ""}`} aria-hidden />
        <span className="turn-process-label">过程</span>
        {summary.operations === 0 ? null : <span className="turn-process-count">{summary.operations} 项操作</span>}
        {elapsed === undefined ? null : <time className="turn-process-elapsed">{elapsed}</time>}
      </button>
      {!open ? null : <div className="turn-process-body">{process}</div>}
    </section>}
    {turn.final === undefined ? null : renderTimelineEntry({ kind: "message", item: turn.final }, context)}
  </>;
}

function renderTimelineTurns(items: TimelineItem[], streamingMessageId: string | undefined, status: SessionStatus, onExtensionUiRespond: TimelineProps["onExtensionUiRespond"], onEditUserMessage: TimelineProps["onEditUserMessage"], onForkMessage: TimelineProps["onForkMessage"], editingMessageId: string | undefined, setEditingMessageId: (id: string | undefined) => void, workspaceCwd: string | undefined, highlightedMessageId: string | undefined, autoCollapse: boolean): ReactNode[] {
  const turns = groupTimelineTurns(items);
  const activeActivityId = hasActiveActivity(items, status) ? lastActivityGroupId(items) : undefined;
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
      </button>
      {open ? <div className="thinking-details"><div className="message-content"><MarkdownMessage text={item.text} streaming={item.state === "running"} baseDir={baseDir} /></div></div> : null}
    </article>
  );
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}
