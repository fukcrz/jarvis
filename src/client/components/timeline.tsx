import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDown, Check, ChevronDown, Clipboard, Clock3, LoaderCircle, RotateCcw, Terminal, XCircle } from "lucide-react";
import type { MessageTimelineItem, SessionStatus, TimelineItem, ToolTimelineItem, ToolState } from "../../shared/protocol";
import { formatRunElapsed, getRunFeedback, type RunFeedback } from "../run-feedback";
import { MarkdownMessage } from "./markdown-message";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

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

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || !following) return;
    element.scrollTop = element.scrollHeight;
  }, [items, streamingMessageId, feedback?.label, following]);

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

const MessageItem = memo(function MessageItem({ item, streaming }: { item: Extract<TimelineItem, { kind: "message" }>; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      setCopied(false);
    }
  };
  return (
    <article className={`message-row ${item.role} ${streaming ? "streaming" : ""}`}>
      <div className={`message-body ${item.role}`}>
        <div className={`message-content ${streaming ? "streaming" : ""}`}>
          <MarkdownMessage text={item.text} streaming={streaming} />
        </div>
        <Tooltip label={copied ? "已复制" : "复制消息"}>
          <button type="button" className="message-copy" aria-label="复制消息" onClick={() => { void copy(); }}><Clipboard size={14} /></button>
        </Tooltip>
      </div>
    </article>
  );
});

export type TimelineRenderItem =
  | { kind: "message"; item: MessageTimelineItem }
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
      result.push({ kind: "message", item });
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

  return grouped.map((entry, index) => entry.kind === "message"
    ? <MessageItem key={entry.item.id} item={entry.item} streaming={entry.item.id === streamingMessageId} />
    : <ActivityGroup key={`activity:${entry.items[0]?.id ?? "empty"}`} items={entry.items} active={index === activeActivityIndex} startedAt={status.activeRun?.startedAt} stopping={status.runState === "stopping"} />);
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
