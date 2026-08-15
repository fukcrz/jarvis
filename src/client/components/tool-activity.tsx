import { useEffect, useState } from "react";
import { Check, Clock3, LoaderCircle, RotateCcw, XCircle } from "lucide-react";
import type { ToolState, ToolTimelineItem } from "../../shared/protocol";
import { formatRunElapsed } from "../run-feedback";

interface ToolActivityProps {
  items: ToolTimelineItem[];
  active: boolean;
  startedAt?: string;
  stopping: boolean;
}

/** Renders Pi tool activity as compact, inline timeline rows. */
export function ToolActivity({ items, active, startedAt, stopping }: ToolActivityProps) {
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
        {summary.label === undefined ? null : <span className="activity-label">{summary.label}</span>}
        {summary.detail === undefined ? null : <span className="activity-detail">{summary.detail}</span>}
        {elapsed === undefined ? null : <time className="activity-elapsed">{elapsed}</time>}
      </button>
      {open ? <div className="activity-items">{items.map((item) => <ToolRow key={item.id} item={item} open={openToolId === item.id} onToggle={() => setOpenToolId((current) => current === item.id ? undefined : item.id)} />)}</div> : null}
    </article>
  );
}

function ToolRow({ item, open, onToggle }: { item: ToolTimelineItem; open: boolean; onToggle: () => void }) {
  return item.name === "bash"
    ? <CommandToolRow item={item} open={open} onToggle={onToggle} />
    : <GenericToolRow item={item} open={open} onToggle={onToggle} />;
}

function activityState(items: ToolTimelineItem[], active: boolean): ToolState {
  if (active) return "running";
  if (items.length > 0 && items.every((item) => item.state === "cancelled")) return "cancelled";
  return "completed";
}

function activitySummary(items: ToolTimelineItem[], state: ToolState, stopping: boolean): { label?: string; detail?: string } {
  if (state === "running") {
    const current = [...items].reverse().find((item) => item.state === "running" || item.state === "queued") ?? items.at(-1);
    return {
      ...(stopping ? { label: `正在停止 ${items.length} 项操作…` } : {}),
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

function GenericToolRow({ item, open, onToggle }: { item: ToolTimelineItem; open: boolean; onToggle: () => void }) {
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

function CommandToolRow({ item, open, onToggle }: { item: ToolTimelineItem; open: boolean; onToggle: () => void }) {
  const command = item.inputPreview ?? item.target ?? "";
  const output = item.error ?? item.output;
  return (
    <article className={`tool-item tool-list-item command-item ${item.state}`}>
      <button className="tool-summary command-summary" type="button" onClick={onToggle} aria-expanded={open}>
        <span className="tool-state-icon">{subtleToolIcon(item.state)}</span>
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
