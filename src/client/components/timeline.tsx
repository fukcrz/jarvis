import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Archive, ArrowDown, Check, CircleAlert, Clock3, GitBranch, LoaderCircle, MoreHorizontal, RefreshCw, RotateCcw, Terminal, X, XCircle } from "lucide-react";
import type { ContextSummaryTimelineItem, ExtensionUiRequest, ExtensionUiTimelineItem, MessageTimelineItem, SessionStatus, TimelineItem, ToolTimelineItem, ToolState } from "../../shared/protocol";
import { formatRunElapsed, getRunFeedback, type RunFeedback } from "../run-feedback";
import { imageDataUrl } from "../lib/image";
import { MarkdownMessage } from "./markdown-message";
import { Button } from "./ui/button";

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
  extensionNotices?: Array<{ id: string; message: string; tone: "info" | "warning" | "error" }>;
  onDismissExtensionNotice?: (id: string) => void;
  onEditUserMessage?: (item: MessageTimelineItem) => void;
  onForkMessage?: (item: MessageTimelineItem) => void;
  onExtensionUiRespond?: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void | Promise<void>;
}

export function Timeline({ items, streamingMessageId, hasMore, loadingMore, onLoadMore, error, notice, onDismissNotice, status, onRetryCompaction, extensionNotices = [], onDismissExtensionNotice, onEditUserMessage, onForkMessage, onExtensionUiRespond }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const feedback = getRunFeedback(status, items, streamingMessageId);
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
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 72);
      }}>
        <div className="timeline-inner">
          {hasMore ? <Button variant="secondary" size="sm" className="history-button" disabled={loadingMore} onClick={() => { void loadEarlier(); }}>{loadingMore ? "正在加载历史记录…" : "加载更早记录"}</Button> : null}
          {renderTimelineItems(items, streamingMessageId, status, onExtensionUiRespond, onEditUserMessage, onForkMessage)}
          {status.compacting === undefined ? null : <CompactingIndicator compacting={status.compacting} />}
          {status.retrying === undefined ? null : <RetryingIndicator retrying={status.retrying} />}
          {notice === undefined ? null : <div className="session-notice" role="status"><span>{notice}</span>{onDismissNotice === undefined ? null : <Button variant="ghost" size="icon" aria-label="关闭提示" onClick={onDismissNotice}><X size={14} /></Button>}</div>}
          {error === undefined ? null : <div className="session-error" role="alert">{error}</div>}
          {status.lastError === undefined ? null : <RunFailureCard failure={status.lastError} onRetryCompaction={onRetryCompaction} />}
          {feedback === undefined || hasActiveActivity(items, status) ? null : <WorkingIndicator feedback={feedback} />}
        </div>
      </div>
      {!following ? <Button variant="ghost" size="icon" className="jump-latest" aria-label="跳转到最新消息" title="跳转到最新消息" onClick={() => { const element = scrollRef.current; if (element !== null) element.scrollTop = element.scrollHeight; setFollowing(true); }}><ArrowDown size={16} /></Button> : null}
      {extensionNotices.length === 0 ? null : <aside className="extension-toasts" aria-label="扩展通知">{extensionNotices.map((toast) => <ExtensionToast key={toast.id} toast={toast} onDismiss={onDismissExtensionNotice} />)}</aside>}
    </section>
  );
}

function ExtensionToast({ toast, onDismiss }: { toast: NonNullable<TimelineProps["extensionNotices"]>[number]; onDismiss: TimelineProps["onDismissExtensionNotice"] }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss?.(toast.id), toast.tone === "error" ? 8_000 : 4_500);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toast.id, toast.tone]);
  return <div className={`extension-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}><span>{toast.message}</span>{onDismiss === undefined ? null : <button type="button" aria-label="关闭扩展通知" onClick={() => onDismiss(toast.id)}><X size={14} /></button>}</div>;
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

  return <article className="run-failure" role="alert">
    <header className="run-failure-header">
      <span className="run-failure-icon"><CircleAlert size={16} /></span>
      <span className="run-failure-copy"><strong>{title}</strong><span>{summary}</span></span>
      <button type="button" className="run-failure-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "收起诊断" : "查看诊断"}</button>
    </header>
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

const MessageItem = memo(function MessageItem({ item, streaming, onEdit, onFork }: { item: Extract<TimelineItem, { kind: "message" }>; streaming: boolean; onEdit?: (item: MessageTimelineItem) => void; onFork?: (item: MessageTimelineItem) => void }) {
  const images = item.images ?? [];
  const [previewIndex, setPreviewIndex] = useState<number>();
  const preview = previewIndex === undefined ? undefined : images[previewIndex];
  return (
    <article className={`message-row ${item.role} ${streaming ? "streaming" : ""}`}>
      <div className={`message-body ${item.role}`}>
        <MessageActions item={item} streaming={streaming} onEdit={onEdit} onFork={onFork} />
        {images.length === 0 ? null : <div className="message-images" aria-label="消息图片">
          {images.map((image, index) => <button key={`${image.mimeType}:${index}`} type="button" className="message-image-thumb" aria-label={`预览图片 ${index + 1}`} onClick={() => setPreviewIndex(index)}><img src={imageDataUrl(image)} alt={`图片 ${index + 1}`} loading="lazy" /></button>)}
        </div>}
        {item.text === "" ? null : <div className={`message-content ${streaming ? "streaming" : ""}`}>
          <MarkdownMessage text={item.text} streaming={streaming} />
        </div>}
        {preview === undefined ? null : <div className="image-lightbox" role="dialog" aria-label={`预览图片 ${previewIndex! + 1}`} onClick={() => setPreviewIndex(undefined)}>
          <button type="button" className="image-lightbox-close" aria-label="关闭图片预览" onClick={() => setPreviewIndex(undefined)}><XCircle size={20} /></button>
          <img src={imageDataUrl(preview)} alt={`图片 ${previewIndex! + 1}`} onClick={(event) => event.stopPropagation()} />
        </div>}
      </div>
    </article>
  );
});

function MessageActions({ item, streaming, onEdit, onFork }: { item: MessageTimelineItem; streaming: boolean; onEdit?: (item: MessageTimelineItem) => void; onFork?: (item: MessageTimelineItem) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (streaming || (onEdit === undefined && onFork === undefined)) return null;
  return <div className="message-actions" ref={rootRef} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } }}>
    <button type="button" aria-label="消息操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={15} /></button>
    {open ? <div className="message-action-menu" role="menu">
      {item.role !== "user" || onEdit === undefined ? null : <button type="button" role="menuitem" onClick={() => { setOpen(false); onEdit(item); }}>编辑并重发</button>}
      {onFork === undefined ? null : <button type="button" role="menuitem" onClick={() => { setOpen(false); onFork(item); }}>Fork 会话</button>}
    </div> : null}
  </div>;
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionResponse = { value?: string; confirmed?: boolean; cancelled?: boolean };

function ExtensionUiOperation({ item, onRespond }: { item: ExtensionUiTimelineItem; onRespond: TimelineProps["onExtensionUiRespond"] }) {
  const request = item.request as ExtensionDialogRequest;
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [showResult, setShowResult] = useState(false);

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setSelectedIndex(0);
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
      setSelectedIndex((current) => (event.key === "ArrowDown" ? (current + 1) % request.options.length : (current - 1 + request.options.length) % request.options.length));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      respond({ value: request.options[selectedIndex] });
    }
  };

  if (item.outcome !== undefined) return <ExtensionResult item={item} expanded={showResult} onToggle={() => setShowResult((current) => !current)} />;
  return <article className={`extension-operation pending ${request.method}`} aria-label={`扩展操作：${request.title}`} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); respond({ cancelled: true }); } }}>
    <div className="extension-operation-heading"><Clock3 size={14} /><span>{extensionOperationPrompt(request.method)}</span><ExtensionTimeout timeout={request.timeout} createdAt={item.createdAt} /></div>
    <p className="extension-operation-title">{request.title}</p>
    {request.method === "confirm" && request.message !== undefined ? <p className="extension-operation-message">{request.message}</p> : null}
    {request.method === "select" ? <div className="extension-select-list" role="listbox" aria-label={request.title} tabIndex={0} onKeyDown={onSelectKeyDown}>
      {request.options.map((option, index) => <button key={option} type="button" role="option" aria-selected={selectedIndex === index} className={selectedIndex === index ? "selected" : ""} disabled={submitting} onMouseEnter={() => setSelectedIndex(index)} onFocus={() => setSelectedIndex(index)} onClick={() => respond({ value: option })}>{option}</button>)}
    </div> : null}
    {request.method === "input" ? <input autoFocus className="extension-dialog-input" placeholder={request.placeholder} value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); respond({ value }); } }} /> : null}
    {request.method === "editor" ? <textarea autoFocus className="extension-dialog-input multiline" value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); respond({ value }); } }} rows={8} /> : null}
    <div className="extension-interaction-actions">
      {request.method === "confirm" ? <><button type="button" disabled={submitting} onClick={() => respond({ confirmed: false })}>拒绝</button><button type="button" className="accent" disabled={submitting} onClick={() => respond({ confirmed: true })}>{submitting ? "正在提交…" : "允许"}</button></> : <><button type="button" disabled={submitting} onClick={() => respond({ cancelled: true })}>取消</button><button type="button" className="accent" disabled={submitting} onClick={() => respond({ value })}>{submitting ? "正在提交…" : request.method === "editor" ? "提交修改" : "提交"}</button></>}
    </div>
    {request.method === "editor" ? <small className="extension-interaction-hint">按 Ctrl / Cmd + Enter 提交</small> : null}
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

const ContextSummaryItem = memo(function ContextSummaryItem({ item }: { item: ContextSummaryTimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  const isCompaction = item.summaryType === "compaction";
  const label = isCompaction ? "上下文已压缩" : "分支上下文摘要";
  return <article className={`context-summary ${item.summaryType}`}>
    <button className="context-summary-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span className="context-summary-icon">{isCompaction ? <Archive size={15} /> : <GitBranch size={15} />}</span>
      <span className="context-summary-copy"><strong>{label}</strong>{item.tokensBefore === undefined ? null : <small>压缩前 {formatTokenCount(item.tokensBefore)} tokens</small>}</span>
    </button>
    {expanded ? <div className="context-summary-details"><div className="message-content"><MarkdownMessage text={item.summary} streaming={false} /></div></div> : null}
  </article>;
});

export type TimelineRenderItem =
  | { kind: "message"; item: MessageTimelineItem }
  | { kind: "context-summary"; item: ContextSummaryTimelineItem }
  | { kind: "extension-ui"; item: ExtensionUiTimelineItem }
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
      else if (item.kind === "extension-ui") result.push({ kind: "extension-ui", item });
      else result.push({ kind: "context-summary", item });
    }
  }
  flushTools();
  return result;
}

function hasActiveActivity(items: TimelineItem[], status: SessionStatus): boolean {
  return status.runState !== "idle" && items.at(-1)?.kind === "tool";
}

function renderTimelineItems(items: TimelineItem[], streamingMessageId: string | undefined, status: SessionStatus, onExtensionUiRespond: TimelineProps["onExtensionUiRespond"], onEditUserMessage: TimelineProps["onEditUserMessage"], onForkMessage: TimelineProps["onForkMessage"]): ReactNode[] {
  const grouped = groupTimelineItems(items);
  const lastActivityIndex = grouped.reduce((lastIndex, entry, index) => entry.kind === "activity" ? index : lastIndex, -1);
  const activeActivityIndex = hasActiveActivity(items, status) ? lastActivityIndex : -1;

  return grouped.map((entry, index) => {
    if (entry.kind === "message") return <MessageItem key={entry.item.id} item={entry.item} streaming={entry.item.id === streamingMessageId} onEdit={onEditUserMessage} onFork={onForkMessage} />;
    if (entry.kind === "context-summary") return <ContextSummaryItem key={entry.item.id} item={entry.item} />;
    if (entry.kind === "extension-ui") return <ExtensionUiOperation key={entry.item.id} item={entry.item} onRespond={onExtensionUiRespond} />;
    return <ActivityGroup key={`activity:${entry.items[0]?.id ?? "empty"}`} items={entry.items} active={index === activeActivityIndex} startedAt={status.activeRun?.startedAt} stopping={status.runState === "stopping"} />;
  });
}

function ActivityGroup({ items, active, startedAt, stopping }: { items: ToolTimelineItem[]; active: boolean; startedAt?: string; stopping: boolean }) {
  // 用户 !cmd 命令（id 以 bash: 开头）默认展开成可见的命令气泡，像 TUI 一样。
  const [open, setOpen] = useState(() => items.some((item) => item.name === "bash" && item.id.startsWith("bash:")));
  const [openToolId, setOpenToolId] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const state = activityState(items, active);
  const summary = activitySummary(items, state, stopping);
  const elapsed = active ? formatRunElapsed(startedAt, now) : undefined;

  useEffect(() => {
    if (!active || startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return (
    <article className={`activity-group ${state}`}>
      <button className="activity-summary" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="activity-state-icon">{toolIcon(state)}</span>
        <span className="activity-label">{summary.label}</span>
        {summary.detail === undefined ? null : <span className="activity-detail">{summary.detail}</span>}
        {elapsed === undefined ? null : <time className="activity-elapsed">{elapsed}</time>}
      </button>
      {open ? <div className="activity-items">{items.map((item) => <ToolItem key={item.id} item={item} open={openToolId === item.id} onToggle={() => setOpenToolId((current) => current === item.id ? undefined : item.id)} />)}</div> : null}
    </article>
  );
}

function ToolItem({ item, open, onToggle }: { item: ToolTimelineItem; open: boolean; onToggle: () => void }) {
  return item.name === "bash"
    ? <CommandToolItem item={item} open={open} onToggle={onToggle} />
    : <GenericToolItem item={item} open={open} onToggle={onToggle} />;
}

function activityState(items: ToolTimelineItem[], active: boolean): ToolState {
  // The group owns the visual running state. Individual fast tools may settle
  // while the next tool is being added, but the icon should not oscillate.
  if (active) return "running";
  if (items.length > 0 && items.every((item) => item.state === "cancelled")) return "cancelled";
  return "completed";
}

function activitySummary(items: ToolTimelineItem[], state: ToolState, stopping: boolean): { label: string; detail?: string } {
  if (state === "running") {
    const current = [...items].reverse().find((item) => item.state === "running" || item.state === "queued") ?? items.at(-1);
    return {
      label: stopping ? `正在停止 ${items.length} 项操作…` : `正在处理 ${items.length} 项操作…`,
      ...(current === undefined ? {} : { detail: toolActivityLabel(current) }),
    };
  }
  if (state === "cancelled") return { label: `已停止 ${items.length} 项操作` };
  return { label: `已执行 ${items.length} 项操作` };
}

function toolActivityLabel(item: ToolTimelineItem): string {
  const target = compactTarget(item.target);
  if (item.name === "bash") return `执行了 ${compactCommand(item.inputPreview ?? item.target)}`;
  if (item.name === "read") return `读取了 ${target || "文件"}`;
  if (item.name === "write") return `写入了 ${target || "文件"}`;
  if (item.name === "edit") return `编辑了 ${target || "文件"}`;
  if (item.name === "grep") return "搜索了项目文件";
  if (item.name === "find") return "查找了项目文件";
  if (item.name === "ls") return "查看了目录";
  return item.title;
}

function compactTarget(value?: string): string {
  if (value === undefined || value.trim() === "") return "";
  const normalized = value.trim().replaceAll("\\", "/");
  return normalized.split("/").at(-1) ?? normalized;
}

function compactCommand(value?: string): string {
  if (value === undefined || value.trim() === "") return "命令";
  const normalized = value.trim().replace(/^(?:cd\s+[^;&]+\s*&&\s*)+/i, "").replace(/\s+/g, " ");
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
}

function GenericToolItem({ item, open, onToggle }: { item: ToolTimelineItem; open: boolean; onToggle: () => void }) {
  const output = item.error ?? item.output;
  return (
    <article className={`tool-item tool-list-item ${item.state}`}>
      <button className="tool-summary" type="button" onClick={onToggle} aria-expanded={open}>
        <span className="tool-state-icon">{subtleToolIcon(item.state)}</span>
        <span className="tool-title">{toolActivityLabel(item)}</span>
        {item.durationMs === undefined ? null : <span className="tool-duration">{formatDuration(item.durationMs)}</span>}
      </button>
      {open ? <div className="tool-details inline-details">
        {item.name === "read" ? null : item.inputPreview === undefined ? null : <div className="detail-input"><span className="detail-label">输入</span><code>{item.inputPreview}</code></div>}
        {output === undefined ? null : <div><pre className={item.error === undefined ? "" : "tool-error-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function CommandToolItem({ item, open, onToggle }: { item: ToolTimelineItem; open: boolean; onToggle: () => void }) {
  const command = item.inputPreview ?? item.target ?? "";
  const output = item.error ?? item.output;
  return (
    <article className={`tool-item tool-list-item command-item ${item.state}`}>
      <button className="tool-summary command-summary" type="button" onClick={onToggle} aria-expanded={open}>
        <span className="tool-state-icon">{subtleToolIcon(item.state)}</span>
        <Terminal size={13} className="command-terminal-icon" />
        <span className="tool-target">{compactCommand(command)}</span>
        {item.excludeFromContext === true ? <span className="command-excluded" title="输出不会发送给模型">不进上下文</span> : null}
        {item.durationMs === undefined ? null : <span className="command-duration">{formatDuration(item.durationMs)}</span>}
      </button>
      {open ? <div className="tool-details command-details inline-details">
        <div className="detail-command-line"><code>$ {command || "(empty)"}</code></div>
        {item.cwd === undefined ? null : <div className="detail-input"><span className="detail-label">工作目录</span><code>{item.cwd}</code></div>}
        {output === undefined ? null : <div><pre className={item.error === undefined ? "command-output" : "tool-error-output command-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function subtleToolIcon(state: ToolTimelineItem["state"]) {
  if (state === "running" || state === "queued") return <LoaderCircle size={14} className="spin" />;
  if (state === "failed") return <span className="tool-subtle-failure" aria-label="操作未完成">!</span>;
  if (state === "cancelled") return <span className="tool-subtle-failure" aria-label="操作已停止">·</span>;
  return <Check size={14} />;
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(tokens);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function toolIcon(state: ToolTimelineItem["state"]) {
  if (state === "running") return <LoaderCircle size={15} className="spin" />;
  if (state === "completed") return <Check size={15} />;
  if (state === "failed") return <XCircle size={15} />;
  if (state === "cancelled") return <RotateCcw size={15} />;
  return <Clock3 size={15} />;
}
