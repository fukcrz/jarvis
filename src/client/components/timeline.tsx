import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Archive, ArrowDown, Bell, Brain, Check, CircleAlert, Clock3, GitBranch, LoaderCircle, Pencil, RefreshCw, X, XCircle } from "lucide-react";
import type { ContextSummaryTimelineItem, ErrorTimelineItem, ExtensionUiRequest, ExtensionUiTimelineItem, MessageTimelineItem, SessionStatus, ThinkingTimelineItem, TimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { formatRunElapsed, getRunFeedback, type RunFeedback } from "../run-feedback";
import { imageDataUrl } from "../lib/image";
import { MarkdownMessage } from "./markdown-message";
import { ToolActivity } from "./tool-activity";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

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

function stopFollowingOnGesture(element: HTMLDivElement, setFollowing: (value: boolean) => void, deltaY: number) {
  if (shouldStopFollowingOnGesture(element, deltaY)) setFollowing(false);
}

export function Timeline({ items, streamingMessageId, hasMore, loadingMore, onLoadMore, error, notice, onDismissNotice, status, onRetryCompaction, onEditUserMessage, onForkMessage, onExtensionUiRespond, workspaceCwd }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const touchYRef = useRef<number | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  const [editingMessageId, setEditingMessageId] = useState<string>();
  const feedback = getRunFeedback(status, items, streamingMessageId);
  const pendingExtensions = items.filter((item): item is ExtensionUiTimelineItem => item.kind === "extension-ui" && item.outcome === undefined && item.request.method !== "notify");
  const hasMatchingTimelineFailure = status.lastError !== undefined && items.some((item) => item.kind === "error" && item.state === "failed" && item.code === status.lastError!.code && item.message === status.lastError!.message);
  const statusIndicatorKey = `${status.runState}:${status.compacting?.reason ?? ""}:${status.compacting?.retrying?.retryAt ?? ""}:${status.retrying?.retryAt ?? ""}:${status.lastError?.occurredAt ?? ""}:${error ?? ""}:${notice ?? ""}`;

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || !following) return;
    element.scrollTop = element.scrollHeight;
  }, [items, streamingMessageId, feedback?.label, following, statusIndicatorKey]);

  const loadEarlier = async () => {
    const element = scrollRef.current;
    const offset = element === null ? 0 : element.scrollHeight - element.scrollTop;
    await onLoadMore();
    requestAnimationFrame(() => {
      if (element !== null) element.scrollTop = element.scrollHeight - offset;
    });
  };

  return (
    <section className="timeline-shell">
      <div className="timeline" ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX);
      }} onWheel={(event) => {
        stopFollowingOnGesture(event.currentTarget, setFollowing, event.deltaY);
      }} onTouchStart={(event) => {
        touchYRef.current = event.touches[0]?.clientY;
      }} onTouchMove={(event) => {
        const previousY = touchYRef.current;
        const currentY = event.touches[0]?.clientY;
        touchYRef.current = currentY;
        if (previousY !== undefined && currentY !== undefined) stopFollowingOnGesture(event.currentTarget, setFollowing, currentY - previousY);
      }}>
        <div className="timeline-inner">
          {hasMore ? <Button variant="secondary" size="sm" className="history-button" disabled={loadingMore} onClick={() => { void loadEarlier(); }}>{loadingMore ? "正在加载历史记录…" : "加载更早记录"}</Button> : null}
          <div className="timeline-feed">
            {renderTimelineItems(items, streamingMessageId, status, onExtensionUiRespond, onEditUserMessage, onForkMessage, editingMessageId, setEditingMessageId, workspaceCwd)}
            {status.compacting === undefined ? null : <CompactingIndicator compacting={status.compacting} />}
            {status.retrying === undefined ? null : <RetryingIndicator retrying={status.retrying} />}
            {notice === undefined ? null : <div className="session-notice" role="status"><span>{notice}</span>{onDismissNotice === undefined ? null : <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={onDismissNotice}><X size={14} /></Button>}</div>}
            {error === undefined ? null : <div className="session-error" role="alert">{error}</div>}
            {status.lastError === undefined || hasMatchingTimelineFailure ? null : <RunFailureCard failure={status.lastError} onRetryCompaction={onRetryCompaction} />}
            {feedback === undefined || hasActiveActivity(items, status) ? null : <WorkingIndicator feedback={feedback} />}
          </div>
        </div>
      </div>
      {!following ? <Button variant="ghost" size="icon" className="jump-latest" aria-label="跳转到最新消息" title="跳转到最新消息" onClick={() => { const element = scrollRef.current; if (element !== null) element.scrollTop = element.scrollHeight; setFollowing(true); }}><ArrowDown size={16} /></Button> : null}
      {pendingExtensions.length === 0 ? null : <ExtensionInteractionDock items={pendingExtensions} onRespond={onExtensionUiRespond} />}
    </section>
  );
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

const MessageItem = memo(function MessageItem({ item, streaming, editing, onStartEdit, onCancelEdit, onEdit, onFork, baseDir }: { item: Extract<TimelineItem, { kind: "message" }>; streaming: boolean; editing: boolean; onStartEdit: () => void; onCancelEdit: () => void; onEdit?: TimelineProps["onEditUserMessage"]; onFork?: (item: MessageTimelineItem) => void; baseDir?: string }) {
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
    <article className={`message-row ${item.role} ${streaming ? "streaming" : ""} ${editing ? "editing" : ""}`}>
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
  if (streaming || item.role !== "user" || (onEdit === undefined && onFork === undefined)) return null;
  return <div className="message-actions">
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

function ExtensionInteractionDock({ items, onRespond }: { items: ExtensionUiTimelineItem[]; onRespond: TimelineProps["onExtensionUiRespond"] }) {
  const item = items[0];
  if (item === undefined) return null;
  return <aside className="extension-interaction-dock" aria-label="待处理的扩展交互">
    <div className="extension-dock-header"><span><CircleAlert size={14} />需要你的操作</span>{items.length > 1 ? <small>{items.length} 项待处理</small> : null}</div>
    <ExtensionUiOperation item={item} onRespond={onRespond} docked />
  </aside>;
}

function ExtensionUiOperation({ item, onRespond, docked = false }: { item: ExtensionUiTimelineItem; onRespond: TimelineProps["onExtensionUiRespond"]; docked?: boolean }) {
  if (item.request.method === "notify") return <ExtensionNotification item={item} />;
  return <ExtensionDialogOperation item={item} onRespond={onRespond} docked={docked} />;
}

function ExtensionDialogOperation({ item, onRespond, docked = false }: { item: ExtensionUiTimelineItem; onRespond: TimelineProps["onExtensionUiRespond"]; docked?: boolean }) {
  const request = item.request as ExtensionDialogRequest;
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [activeIndex, setActiveIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setActiveIndex(0);
    optionRefs.current = [];
    setSubmitting(false);
    setShowResult(false);
  }, [request]);

  const respond = (response: ExtensionResponse) => {
    if (item.outcome !== undefined || submitting || onRespond === undefined) return;
    setSubmitting(true);
    Promise.resolve(onRespond(request.id, response)).catch(() => setSubmitting(false));
  };
  const onSelectKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (request.method !== "select") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown"
        ? (activeIndex + 1) % request.options.length
        : (activeIndex - 1 + request.options.length) % request.options.length;
      setActiveIndex(nextIndex);
      requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      respond({ value: request.options[activeIndex] });
    }
  };

  if (item.outcome !== undefined) return <ExtensionResult item={item} expanded={showResult} onToggle={() => setShowResult((current) => !current)} />;
  return <article className={`extension-operation pending ${request.method} ${docked ? "docked" : ""}`} aria-label={`扩展操作：${request.title}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); respond({ cancelled: true }); } }}>
    <div className="extension-operation-heading"><Clock3 size={14} /><span>{extensionOperationPrompt(request.method)}</span><ExtensionTimeout timeout={request.timeout} createdAt={item.createdAt} /></div>
    {request.method === "select" ? <div className="extension-operation-title-row"><p className="extension-operation-title">{request.title}</p><button type="button" className="extension-dock-close" aria-label="取消选择" disabled={submitting} onClick={() => respond({ cancelled: true })}><X size={16} /></button></div> : <p className="extension-operation-title">{request.title}</p>}
    {request.method === "confirm" && request.message !== undefined ? <p className="extension-operation-message">{request.message}</p> : null}
    {request.method === "select" ? <div className="extension-select-list" role="listbox" aria-label={request.title} tabIndex={0} onKeyDown={onSelectKeyDown}>
      {request.options.map((option, index) => <button ref={(element) => { optionRefs.current[index] = element; }} key={option} type="button" role="option" aria-selected={false} disabled={submitting} onFocus={() => setActiveIndex(index)} onClick={() => respond({ value: option })}>{option}</button>)}
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
  return <article className={`extension-operation ${item.outcome ?? "closed"}`} aria-label={`扩展操作：${request.title}`}>
    <div className="extension-result-line"><span className="extension-operation-icon">{item.outcome === "answered" ? <Check size={14} /> : <XCircle size={14} />}</span><span>{extensionOperationLabel(item)}</span>{canExpand ? <button type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? "收起" : "查看内容"}</button> : null}</div>
    {canExpand && expanded ? <pre className="extension-result-content">{item.value}</pre> : null}
  </article>;
}

function extensionOperationPrompt(method: ExtensionDialogRequest["method"]): string {
  return method === "confirm" ? "需要确认" : method === "select" ? "需要选择" : method === "editor" ? "需要编辑" : "需要输入";
}

function extensionOperationLabel(item: ExtensionUiTimelineItem): string {
  if (item.outcome === "answered") {
    if (item.request.method === "confirm") return item.confirmed === true ? "已允许" : "已拒绝";
    if (item.request.method === "select") return `已选择：${item.value ?? "未选择"}`;
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

function renderTimelineItems(items: TimelineItem[], streamingMessageId: string | undefined, status: SessionStatus, onExtensionUiRespond: TimelineProps["onExtensionUiRespond"], onEditUserMessage: TimelineProps["onEditUserMessage"], onForkMessage: TimelineProps["onForkMessage"], editingMessageId: string | undefined, setEditingMessageId: (id: string | undefined) => void, workspaceCwd: string | undefined): ReactNode[] {
  const grouped = groupTimelineItems(items);
  const lastActivityIndex = grouped.reduce((lastIndex, entry, index) => entry.kind === "activity" ? index : lastIndex, -1);
  const activeActivityIndex = hasActiveActivity(items, status) ? lastActivityIndex : -1;

  return grouped.map((entry, index) => {
    if (entry.kind === "message") return <MessageItem key={entry.item.id} item={entry.item} streaming={entry.item.id === streamingMessageId} editing={entry.item.id === editingMessageId} onStartEdit={() => setEditingMessageId(entry.item.id)} onCancelEdit={() => setEditingMessageId(undefined)} onEdit={onEditUserMessage} onFork={entry.item.role === "user" ? onForkMessage : undefined} baseDir={workspaceCwd} />;
    if (entry.kind === "error") return <ErrorItem key={`error:${entry.items[0]?.id ?? "empty"}`} items={entry.items} retrying={status.retrying !== undefined} />;
    if (entry.kind === "context-summary") return <ContextSummaryItem key={entry.item.id} item={entry.item} baseDir={workspaceCwd} />;
    if (entry.kind === "extension-ui") return entry.item.request.method !== "notify" && entry.item.outcome === undefined ? null : <ExtensionUiOperation key={entry.item.id} item={entry.item} onRespond={onExtensionUiRespond} />;
    if (entry.kind === "thinking") return <ThinkingItem key={entry.item.id} item={entry.item} baseDir={workspaceCwd} />;
    return <ToolActivity key={`activity:${entry.items[0]?.id ?? "empty"}`} items={entry.items} active={index === activeActivityIndex} startedAt={status.activeRun?.startedAt} stopping={status.runState === "stopping"} />;
  });
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
