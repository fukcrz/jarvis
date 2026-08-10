import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Archive, ArrowDown, Check, ChevronDown, Clock3, GitBranch, LoaderCircle, RotateCcw, Terminal, XCircle } from "lucide-react";
import type { ContextSummaryTimelineItem, MessageTimelineItem, SessionStatus, TimelineItem, ToolTimelineItem, ToolState } from "../../shared/protocol";
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
  error?: string;
  status: SessionStatus;
}

export function Timeline({ items, streamingMessageId, hasMore, loadingMore, onLoadMore, error, status }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const feedback = getRunFeedback(status, items, streamingMessageId);
  const statusIndicatorKey = `${status.runState}:${status.compacting?.reason ?? ""}:${status.compacting?.retrying?.retryAt ?? ""}:${status.retrying?.retryAt ?? ""}:${error ?? ""}`;

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
          {renderTimelineItems(items, streamingMessageId, status)}
          {status.compacting === undefined ? null : <CompactingIndicator compacting={status.compacting} />}
          {status.retrying === undefined ? null : <RetryingIndicator retrying={status.retrying} />}
          {error === undefined ? null : <div className="session-error" role="alert">{error}</div>}
          {feedback === undefined || hasActiveActivity(items, status) ? null : <WorkingIndicator feedback={feedback} />}
        </div>
      </div>
      {!following ? <Button variant="ghost" size="icon" className="jump-latest" aria-label="跳转到最新消息" title="跳转到最新消息" onClick={() => { const element = scrollRef.current; if (element !== null) element.scrollTop = element.scrollHeight; setFollowing(true); }}><ArrowDown size={16} /></Button> : null}
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
  return <RunStatusIndicator className="retrying-indicator" icon={<RotateCcw className="spin" size={15} />} label={`模型响应失败，正在重试（${String(retrying.attempt)}/${String(retrying.maxAttempts)}）`} detail={retrying.errorMessage} retrying={retrying} />;
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

const MessageItem = memo(function MessageItem({ item, streaming }: { item: Extract<TimelineItem, { kind: "message" }>; streaming: boolean }) {
  const images = item.images ?? [];
  return (
    <article className={`message-row ${item.role} ${streaming ? "streaming" : ""}`}>
      <div className={`message-body ${item.role}`}>
        {images.length === 0 ? null : <div className="message-images">
          {images.map((image, index) => <a key={`${image.mimeType}:${index}`} href={imageDataUrl(image)} target="_blank" rel="noreferrer" aria-label={`查看图片 ${index + 1}`}><img src={imageDataUrl(image)} alt={`图片 ${index + 1}`} loading="lazy" /></a>)}
        </div>}
        {item.text === "" ? null : <div className={`message-content ${streaming ? "streaming" : ""}`}>
          <MarkdownMessage text={item.text} streaming={streaming} />
        </div>}
      </div>
    </article>
  );
});

const ContextSummaryItem = memo(function ContextSummaryItem({ item }: { item: ContextSummaryTimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  const isCompaction = item.summaryType === "compaction";
  const label = isCompaction ? "上下文已压缩" : "分支上下文摘要";
  return <article className={`context-summary ${item.summaryType}`}>
    <button className="context-summary-toggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      <span className="context-summary-icon">{isCompaction ? <Archive size={15} /> : <GitBranch size={15} />}</span>
      <span className="context-summary-copy"><strong>{label}</strong>{item.tokensBefore === undefined ? null : <small>压缩前 {formatTokenCount(item.tokensBefore)} tokens</small>}</span>
      <ChevronDown className={expanded ? "chevron-open" : ""} size={15} />
    </button>
    {expanded ? <div className="context-summary-details"><div className="message-content"><MarkdownMessage text={item.summary} streaming={false} /></div></div> : null}
  </article>;
});

export type TimelineRenderItem =
  | { kind: "message"; item: MessageTimelineItem }
  | { kind: "context-summary"; item: ContextSummaryTimelineItem }
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
      result.push(item.kind === "message" ? { kind: "message", item } : { kind: "context-summary", item });
    }
  }
  flushTools();
  return result;
}

function hasActiveActivity(items: TimelineItem[], status: SessionStatus): boolean {
  return status.runState !== "idle" && items.at(-1)?.kind === "tool";
}

function renderTimelineItems(items: TimelineItem[], streamingMessageId: string | undefined, status: SessionStatus): ReactNode[] {
  const grouped = groupTimelineItems(items);
  const lastActivityIndex = grouped.reduce((lastIndex, entry, index) => entry.kind === "activity" ? index : lastIndex, -1);
  const activeActivityIndex = hasActiveActivity(items, status) ? lastActivityIndex : -1;

  return grouped.map((entry, index) => {
    if (entry.kind === "message") return <MessageItem key={entry.item.id} item={entry.item} streaming={entry.item.id === streamingMessageId} />;
    if (entry.kind === "context-summary") return <ContextSummaryItem key={entry.item.id} item={entry.item} />;
    return <ActivityGroup key={`activity:${entry.items[0]?.id ?? "empty"}`} items={entry.items} active={index === activeActivityIndex} startedAt={status.activeRun?.startedAt} stopping={status.runState === "stopping"} />;
  });
}

function ActivityGroup({ items, active, startedAt, stopping }: { items: ToolTimelineItem[]; active: boolean; startedAt?: string; stopping: boolean }) {
  const [open, setOpen] = useState(false);
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
        <ChevronDown className={open ? "chevron-open" : ""} size={15} />
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
        {hasToolDetails(item) ? <ChevronDown className={open ? "chevron-open" : ""} size={14} /> : null}
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
        {item.durationMs === undefined ? null : <span className="command-duration">{formatDuration(item.durationMs)}</span>}
        {hasToolDetails(item) ? <ChevronDown className={open ? "chevron-open" : ""} size={14} /> : null}
      </button>
      {open ? <div className="tool-details command-details inline-details">
        <div className="detail-command-line"><code>$ {command || "(empty)"}</code></div>
        {item.cwd === undefined ? null : <div className="detail-input"><span className="detail-label">工作目录</span><code>{item.cwd}</code></div>}
        {output === undefined ? null : <div><pre className={item.error === undefined ? "command-output" : "tool-error-output command-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function hasToolDetails(item: ToolTimelineItem): boolean {
  return item.inputPreview !== undefined || item.output !== undefined || item.error !== undefined || item.name === "bash" && item.cwd !== undefined;
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
