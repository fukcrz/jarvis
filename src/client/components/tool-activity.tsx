import type { ReactNode } from "react";
import { ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import type { SubagentRecord, ToolState, ToolTimelineItem } from "../../shared/protocol";
import { imageDataUrl } from "../lib/image";
import { ImagePreview } from "./image-lightbox";
import { DiffStat, DiffView } from "./diff-view";
import { ElapsedClock } from "./elapsed-clock";
import { commandLabel } from "../lib/command-summary";
import { collapsedToolActivityItems as collapsedItems } from "./timeline-fold";
import { formatElapsedMs } from "../lib/subagents";

export { collapsedToolActivityItems } from "./timeline-fold";

interface ToolActivityProps {
  items: ToolTimelineItem[];
  active: boolean;
  /** Whether the enclosing process shows its full content. */
  showAll?: boolean;
  /** Keep the default live preview while its enclosing process is untouched. */
  showActivePreview?: boolean;
  /** IDs selected by the timeline fold state. */
  openItems?: ReadonlySet<string>;
  onToggleItem?: (id: string, currentlyOpen: boolean) => void;
  visibleItemIds?: ReadonlySet<string>;
  /** Deprecated: tool rows are always shown flat. */
  groupCollapsed?: boolean;
  onToggleGroup?: (currentlyCollapsed: boolean) => void;
  /** Deprecated: tool rows are always shown flat. */
  liveStream?: boolean;
}

/** Render every tool call as its own row; the enclosing process owns folding. */
export function ToolActivity({ items, active, showAll = true, showActivePreview = true, openItems, onToggleItem, visibleItemIds }: ToolActivityProps) {
  const presentedItems = items.filter((item) => item.name !== "session_update");
  const state = activityState(presentedItems, active);
  const visibleIds = visibleItemIds ?? new Set((showAll ? presentedItems : collapsedItems(presentedItems, active, showActivePreview)).map((item) => item.id));

  return (
    <article className={`activity-group ${state}`}>
      <div className="activity-items" hidden={visibleIds.size === 0}>{presentedItems.map((item) => <div key={item.id} hidden={!visibleIds.has(item.id)}>
        <ToolRow item={item} pending={active && item.state === "running"} open={openItems?.has(item.id) === true} showDetails={showAll} onToggle={() => onToggleItem?.(item.id, openItems?.has(item.id) === true && showAll)} />
      </div>)}</div>
    </article>
  );
}

const ACTIVITY_KIND_LABELS: Record<string, string> = { read: "读取", write: "写入", edit: "编辑", bash: "命令", powershell: "命令", grep: "搜索", find: "查找", ls: "目录" };

export function summarizeToolActivity(items: ToolTimelineItem[]): string {
  const chunks: Array<{ key: string; count: number }> = [];
  for (const item of items) {
    if (item.name === "session_update") continue;
    const label = ACTIVITY_KIND_LABELS[item.name] ?? item.title;
    const existing = chunks.find((chunk) => chunk.key === label);
    if (existing === undefined) chunks.push({ key: label, count: 1 });
    else existing.count += 1;
  }
  return chunks.map((chunk) => `${chunk.key} ${String(chunk.count)}`).join(" · ");
}

function ToolRow({ item, pending, open, showDetails, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; showDetails: boolean; onToggle: () => void }) {
  if (item.name === "bash" || item.name === "powershell") return <CommandToolRow item={item} pending={pending} open={open} showDetails={showDetails} onToggle={onToggle} />;
  return <GenericToolRow item={item} pending={pending} open={open} showDetails={showDetails} onToggle={onToggle} />;
}

function activityState(items: ToolTimelineItem[], active: boolean): ToolState {
  if (active) return "running";
  if (items.some((item) => item.state === "failed")) return "failed";
  if (items.length > 0 && items.every((item) => item.state === "cancelled")) return "cancelled";
  return "completed";
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
  return commandLabel(value);
}

function GenericToolRow({ item, pending, open, showDetails, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; showDetails: boolean; onToggle: () => void }) {
  const output = item.error ?? item.output;
  const images = item.images ?? [];
  const stateIcon = compactToolStateIcon(item.state, pending);
  const change = item.fileChange;
  return (
    <article className={`tool-item tool-list-item ${item.state}`}>
      <button className={`tool-summary${change === undefined ? "" : " has-diff"}`} type="button" onClick={onToggle} aria-expanded={open && showDetails}>
        <ChevronRight size={13} className={`turn-process-chevron${open && showDetails ? " expanded" : ""}`} aria-hidden />
        {stateIcon === undefined ? null : <span className="tool-state-icon">{stateIcon}</span>}
        <span className="tool-title">{toolActivityLabel(item)}</span>
        {pending || change !== undefined ? <span className="tool-summary-tail">
          {pending ? <ElapsedClock startedAt={item.createdAt} /> : null}
          {change === undefined ? null : <DiffStat added={change.added} removed={change.removed} />}
        </span> : null}
      </button>
      {open ? <div className="tool-details inline-details" hidden={!showDetails}>
        {images.length === 0 ? null : <div className="tool-images" aria-label="读取到的图片">
          {images.map((image, index) => <ImagePreview key={`${image.mimeType}:${index}`} className="message-image-thumb" src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`}><img src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`} loading="lazy" /></ImagePreview>)}
        </div>}
        {change !== undefined ? <DiffView change={change} /> : item.name === "read" || item.inputPreview === undefined ? null : <div className="detail-input"><span className="detail-label">输入</span><code>{item.inputPreview}</code></div>}
        {output === undefined || (change !== undefined && item.error === undefined) ? null : <div><pre className={item.error === undefined ? "" : "tool-error-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

/** 子代理的一条状态记录：派发、完成、失败或停止，各自独立成行，收进过程折叠。 */
export function SubagentRecordRow({ record, onOpen }: { record: SubagentRecord; onOpen?: (record: SubagentRecord) => void }) {
  const verb = record.state === "dispatched" ? "派发" : record.state === "completed" ? "完成" : record.state === "failed" ? "失败" : "已停止";
  const tone = record.state === "failed" ? "failed" : record.state === "stopped" ? "cancelled" : record.state === "completed" ? "completed" : "running";
  const facts = [
    record.durationMs === undefined ? "" : formatElapsedMs(record.durationMs),
    record.tokens === undefined ? "" : `${formatTokenCount(record.tokens)} tok`,
  ].filter(Boolean).join(" · ");
  return (
    <article className={`subagent-record ${tone}`} data-subagent-paths={record.path}>
      <button className="tool-summary subagent-record-summary" type="button" onClick={() => { onOpen?.(record); }} aria-haspopup="dialog">
        <span className={`subagent-type-dot ${tone}`} data-tone={subagentTypeTone(record.agent)} aria-hidden />
        <span className="subagent-record-verb">{verb}</span>
        <span className="subagent-role">{record.agent}</span>
        <span className="tool-title">{record.prompt}</span>
        {facts === "" ? null : <span className="subagent-record-facts">{facts}</span>}
      </button>
    </article>
  );
}

/** 子代理的类型色微点：同类同名颜色稳定，不同类能一眼分开。 */
const SUBAGENT_TONES = ["violet", "teal", "amber", "pink", "blue", "green"] as const;

export function subagentTypeTone(type: string): string {
  if (type === "") return SUBAGENT_TONES[0];
  let hash = 0;
  for (const character of type) hash = (hash * 31 + character.codePointAt(0)!) % 997;
  return SUBAGENT_TONES[hash % SUBAGENT_TONES.length]!;
}

function formatTokenCount(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

/** 子代理的工具动作一行：和主会话同一套措辞。 */
export function subagentToolLine(name: string, summary: string): string {
  if (name === "edit") return `编辑了 ${compactTarget(summary) || "文件"}`;
  if (name === "read") return `读取了 ${compactTarget(summary) || "文件"}`;
  if (name === "write") return `写入了 ${compactTarget(summary) || "文件"}`;
  if (name === "bash" || name === "powershell") return `执行了 ${compactCommand(summary)}`;
  if (name === "grep") return summary.trim() === "" ? "搜索了项目文件" : `搜索了 ${truncateEnd(summary.trim(), 42)}`;
  if (name === "find") return "查找了项目文件";
  if (name === "ls") return summary.trim() === "" ? "查看了目录" : `查看了 ${compactTarget(summary) || "目录"}`;
  const target = compactTarget(summary);
  return target === "" ? name : `${name} ${target}`;
}

function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function CommandToolRow({ item, pending, open, showDetails, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; showDetails: boolean; onToggle: () => void }) {
  const command = item.inputPreview ?? item.target ?? "";
  const headline = commandLabel(command);
  const output = item.error ?? item.output;
  const stateIcon = compactToolStateIcon(item.state, pending);
  return (
    <article className={`tool-item tool-list-item command-item ${item.state}`}>
      <button className="tool-summary command-summary" type="button" onClick={onToggle} aria-expanded={open && showDetails}>
        <ChevronRight size={13} className={`turn-process-chevron${open && showDetails ? " expanded" : ""}`} aria-hidden />
        {stateIcon === undefined ? null : <span className="tool-state-icon">{stateIcon}</span>}
        <span className="tool-target">{open && showDetails ? "命令" : headline}</span>
        {pending ? <ElapsedClock startedAt={item.createdAt} /> : null}
        {item.excludeFromContext === true ? <span className="command-excluded" title="输出不会发送给模型">不进上下文</span> : null}
      </button>
      {open ? <div className="tool-details command-details inline-details" hidden={!showDetails}>
        <div className="detail-command-line"><code>$ {command || "(empty)"}</code></div>
        {item.cwd === undefined ? null : <div className="detail-input"><span className="detail-label">工作目录</span><code>{item.cwd}</code></div>}
        {output === undefined ? null : <div><pre className={item.error === undefined ? "command-output" : "tool-error-output command-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function compactToolStateIcon(state: ToolTimelineItem["state"], pending: boolean): ReactNode {
  if (pending) return <LoaderCircle size={14} className="spin" />;
  if (state === "queued") return <span className="tool-subtle-queued" aria-label="等待执行">·</span>;
  if (state === "failed") return <CircleAlert size={14} aria-label="操作未完成" />;
  if (state === "cancelled") return <span className="tool-subtle-failure" aria-label="操作已停止">·</span>;
  return undefined;
}
