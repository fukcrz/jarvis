import { useEffect, useState } from "react";
import { ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import type { SubagentCallView, SubagentView, ToolState, ToolTimelineItem } from "../../shared/protocol";
import { imageDataUrl } from "../lib/image";
import { displayModelName } from "../model-display";
import { ImagePreview } from "./image-lightbox";
import { DiffStat, DiffView } from "./diff-view";
import { ElapsedClock } from "./elapsed-clock";
import { commandLabel } from "../lib/command-summary";
import { collapsedToolActivityItems as collapsedItems } from "./timeline-fold";

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
  const state = activityState(items, active);
  const visibleIds = visibleItemIds ?? new Set((showAll ? items : collapsedItems(items, active, showActivePreview)).map((item) => item.id));

  return (
    <article className={`activity-group ${state}`}>
      <div className="activity-items" hidden={visibleIds.size === 0}>{items.map((item) => <div key={item.id} hidden={!visibleIds.has(item.id)}>
        <ToolRow item={item} pending={active && item.state === "running"} grouped={false} open={openItems?.has(item.id) === true} showDetails={showAll} onToggle={() => onToggleItem?.(item.id, openItems?.has(item.id) === true && showAll)} />
      </div>)}</div>
    </article>
  );
}

export type LiveStreamRow =
  | { kind: "item"; key: string; item: ToolTimelineItem }
  | { kind: "run"; key: string; label: string; items: ToolTimelineItem[] }
  | { kind: "waiting"; key: string; count: number; items: ToolTimelineItem[] };

/** 运行中的流：同类连续完成的工具合成一行计数，排队项合成一行等待，失败项始终单独一行。 */
export function liveStreamRows(items: ToolTimelineItem[]): LiveStreamRow[] {
  const rows: LiveStreamRow[] = [];
  let run: { name: string; items: ToolTimelineItem[] } | undefined;
  let waiting: ToolTimelineItem[] = [];
  const flushRun = () => {
    const merged = run;
    run = undefined;
    if (merged === undefined) return;
    const [first] = merged.items;
    if (first === undefined) return;
    rows.push(merged.items.length === 1
      ? { kind: "item", key: `item:${first.id}`, item: first }
      : { kind: "run", key: `run:${first.id}`, label: `${ACTIVITY_KIND_LABELS[merged.name] ?? first.title} ×${String(merged.items.length)}`, items: merged.items });
  };
  const flushWaiting = () => {
    const queued = waiting;
    waiting = [];
    const [first] = queued;
    if (first === undefined) return;
    rows.push({ kind: "waiting", key: `wait:${first.id}`, count: queued.length, items: queued });
  };
  for (const item of items) {
    if (item.state === "queued") {
      flushRun();
      waiting.push(item);
      continue;
    }
    flushWaiting();
    if (item.state !== "completed" || item.subagent !== undefined) {
      flushRun();
      rows.push({ kind: "item", key: `item:${item.id}`, item });
      continue;
    }
    const name = item.name === "powershell" ? "bash" : item.name;
    if (run === undefined || run.name !== name) {
      flushRun();
      run = { name, items: [item] };
    } else run.items.push(item);
  }
  flushWaiting();
  flushRun();
  return rows;
}

function LiveToolStream({ items, active, openItems, onToggleItem }: { items: ToolTimelineItem[]; active: boolean; openItems?: ReadonlySet<string>; onToggleItem?: (id: string, currentlyOpen: boolean) => void }) {
  return <article className={`activity-group live-stream ${activityState(items, active)}`}>
    <div className="activity-items">
      {liveStreamRows(items).map((row) => row.kind === "item" ? <div key={row.key}>
        <ToolRow item={row.item} pending={active && row.item.state === "running"} grouped={false} open={openItems?.has(row.item.id) === true} showDetails onToggle={() => onToggleItem?.(row.item.id, openItems?.has(row.item.id) === true)} />
      </div> : <StreamFoldRow key={row.key} foldId={row.kind === "run" ? `stream:${row.items[0]?.id ?? ""}` : `wait:${row.items[0]?.id ?? ""}`} label={row.kind === "run" ? row.label : `等待 ${String(row.count)} 步`} items={row.items} active={active} openItems={openItems} onToggleItem={onToggleItem} />)}
    </div>
  </article>;
}

function StreamFoldRow({ foldId, label, items, active, openItems, onToggleItem }: { foldId: string; label: string; items: ToolTimelineItem[]; active: boolean; openItems?: ReadonlySet<string>; onToggleItem?: (id: string, currentlyOpen: boolean) => void }) {
  const open = openItems?.has(foldId) === true;
  return <>
    <button type="button" className="tool-summary stream-fold" aria-expanded={open} onClick={() => onToggleItem?.(foldId, open)}>
      <ChevronRight size={13} className={`turn-process-chevron${open ? " expanded" : ""}`} aria-hidden />
      <span className="tool-title">{label}</span>
    </button>
    {open ? <div className="stream-rows">{items.map((item) => <div key={item.id}>
      <ToolRow item={item} pending={active && item.state === "running"} grouped={false} open={openItems?.has(item.id) === true} showDetails onToggle={() => onToggleItem?.(item.id, openItems?.has(item.id) === true)} />
    </div>)}</div> : null}
  </>;
}

const ACTIVITY_KIND_LABELS: Record<string, string> = { read: "读取", write: "写入", edit: "编辑", bash: "命令", powershell: "命令", grep: "搜索", find: "查找", ls: "目录", session_update: "更新会话" };

export function summarizeToolActivity(items: ToolTimelineItem[]): string {
  const chunks: Array<{ key: string; count: number }> = [];
  for (const item of items) {
    if (item.subagent !== undefined) {
      chunks.push({ key: `subagent:${subagentGroupLabel(item.subagent)}`, count: 1 });
      continue;
    }
    const label = ACTIVITY_KIND_LABELS[item.name] ?? item.title;
    const existing = chunks.find((chunk) => chunk.key === label);
    if (existing === undefined) chunks.push({ key: label, count: 1 });
    else existing.count += 1;
  }
  return chunks.map((chunk) => formatActivityChunk(chunk.key, chunk.count)).join(" · ");
}

function formatActivityChunk(key: string, count: number): string {
  if (key.startsWith("subagent:")) return key.slice("subagent:".length);
  if (key === "更新会话" && count === 1) return key;
  return `${key} ${String(count)}`;
}

function ToolRow({ item, pending, open, showDetails, grouped, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; showDetails: boolean; grouped: boolean; onToggle: () => void }) {
  if (item.name === "bash" || item.name === "powershell") return <CommandToolRow item={item} pending={pending} open={open} showDetails={showDetails} onToggle={onToggle} />;
  if (item.subagent !== undefined) return <SubagentToolRow item={item} view={item.subagent} pending={pending} grouped={grouped} open={open} showDetails={showDetails} onToggle={onToggle} />;
  return <GenericToolRow item={item} pending={pending} open={open} showDetails={showDetails} onToggle={onToggle} />;
}

function activityState(items: ToolTimelineItem[], active: boolean): ToolState {
  if (active) return "running";
  if (items.some((item) => item.state === "failed")) return "failed";
  if (items.length > 0 && items.every((item) => item.state === "cancelled")) return "cancelled";
  return "completed";
}

function toolActivityLabel(item: ToolTimelineItem): string {
  if (item.subagent !== undefined) return subagentRowLabel(item.subagent, false);
  if (item.name === "session_update") return "更新会话";
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

export function subagentGroupLabel(view: SubagentView): string {
  if (view.total <= 0) return "子代理";
  if (view.failed === view.total) return `子代理 ${String(view.failed)}/${String(view.total)} 失败`;
  const cancelled = view.results.filter((call) => call.state === "cancelled").length;
  if (cancelled === view.total) return `子代理 ${String(cancelled)} 已停止`;
  if (view.failed > 0) return `子代理 ${String(view.completed)}/${String(view.total)} · ${String(view.failed)} 失败`;
  return `子代理 ${String(view.completed)}/${String(view.total)}`;
}

export function subagentRowLabel(view: SubagentView, grouped: boolean): string {
  const only = view.results.length === 1 ? view.results[0] : undefined;
  if (only !== undefined) return `${subagentCallName(only)} · ${subagentCallStateLabel(only.state)}`;
  if (view.results.length === 0) return "子代理";
  const who = runningAgentLabel(view);
  const failed = view.failed === 0 ? "" : `${String(view.failed)} 失败`;
  if (who !== "" && grouped) return [failed, who, "执行中"].filter(Boolean).join(" · ");
  if (who !== "") return [`子代理 ${String(view.completed)}/${String(view.total)}`, failed, who].filter(Boolean).join(" · ");
  if (view.failed === view.total) return `${String(view.failed)}/${String(view.total)} 失败`;
  const cancelled = view.results.filter((call) => call.state === "cancelled").length;
  if (cancelled === view.total) return `${String(cancelled)} 已停止`;
  return [`子代理 ${String(view.completed)}/${String(view.total)}`, failed].filter(Boolean).join(" · ");
}

function runningAgentLabel(view: SubagentView): string {
  const names = [...new Set(view.results.filter((call) => call.state === "running").map(subagentCallName))];
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join("、");
  return `${names.slice(0, 2).join("、")} 等`;
}

function subagentCallName(call: SubagentCallView): string {
  return call.agent === "子代理" && call.label !== undefined && call.label !== "" ? call.label : call.agent;
}

function subagentCallStateLabel(state: SubagentCallView["state"]): string {
  if (state === "running") return "执行中";
  if (state === "partial") return "未收尾";
  if (state === "failed") return "失败";
  if (state === "cancelled") return "已停止";
  return "完成";
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

function SubagentToolRow({ item, view, pending, grouped, open, showDetails, onToggle }: { item: ToolTimelineItem; view: SubagentView; pending: boolean; grouped: boolean; open: boolean; showDetails: boolean; onToggle: () => void }) {
  const stateIcon = compactToolStateIcon(item.state, pending);
  return (
    <article className={`tool-item tool-list-item subagent-item ${item.state}`}>
      <button className="tool-summary subagent-summary" type="button" onClick={onToggle} aria-expanded={open && showDetails}>
        <ChevronRight size={13} className={`turn-process-chevron${open && showDetails ? " expanded" : ""}`} aria-hidden />
        {stateIcon === undefined ? null : <span className="tool-state-icon">{stateIcon}</span>}
        <span className="subagent-heading">
          <span className="tool-title">{subagentRowLabel(view, grouped)}</span>
          {pending ? <ElapsedClock startedAt={item.createdAt} /> : item.durationMs === undefined ? null : <time className="run-elapsed">{formatElapsedMs(item.durationMs)}</time>}
        </span>
      </button>
      {open ? <div className="tool-details inline-details" hidden={!showDetails}>
        {view.results.length === 0 ? null : <SubagentCallList results={view.results} />}
        {view.results.length === 0 && item.error !== undefined ? <p className="subagent-error">{item.error}</p> : null}
      </div> : null}
    </article>
  );
}

export function SubagentCallList({ results }: { results: SubagentCallView[] }) {
  return (
    <div className="subagent-body">
      {results.map((call, index) => <SubagentCallBlock call={call} key={`${String(call.callIndex ?? index)}:${call.agent}`} showAgent={results.length > 1} />)}
    </div>
  );
}

/** 单个 call 的卡体：一张卡只有一个 worker 时用它。 */
export function SubagentCallBody({ call }: { call: SubagentCallView }) {
  return <SubagentCallList results={[call]} />;
}

/** 一个 worker 的过程块：块头一行，下面是它自己的过程。 */
function SubagentCallBlock({ call, showAgent }: { call: SubagentCallView; showAgent: boolean }) {
  const steps = call.recentSteps ?? [];
  const meta = subagentCallMeta(call);
  return (
    <section className={`subagent-call ${call.state}`}>
      <p className="subagent-call-head">
        {showAgent ? <span className="subagent-call-agent">{subagentCallName(call)}</span> : null}
        {showAgent && meta !== "" ? <span className="subagent-call-sep" aria-hidden>·</span> : null}
        {meta === "" ? null : <span className="subagent-call-meta">{meta}</span>}
        <span className="subagent-call-tail">
          {call.turns === undefined ? null : <span className="subagent-call-turns">{String(call.turns)} 轮</span>}
          <span className="subagent-call-state">{subagentCallStateLabel(call.state)}</span>
          <SubagentCallClock call={call} />
        </span>
      </p>
      <SubagentPrompt text={call.fullPrompt ?? ""} />
      {steps.length === 0 ? <LegacySubagentStream call={call} /> : <SubagentProcess steps={steps} />}
      {call.error === undefined ? null : <p className="subagent-error">{call.error}</p>}
    </section>
  );
}

/** 单个 worker 的计时：执行中走秒，结束后给总时长。 */
function SubagentCallClock({ call }: { call: SubagentCallView }) {
  if (call.state === "running") return call.startedAt === undefined ? null : <ElapsedClock startedAt={call.startedAt} />;
  return call.durationMs === undefined ? null : <time className="run-elapsed">{formatElapsedMs(call.durationMs)}</time>;
}

/** 提示词：挂在它自己的 worker 块上，默认收起，展开后按灰竖线缩进。 */
function SubagentPrompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const body = text.trim();
  if (body === "") return null;
  return (
    <div className="subagent-prompt">
      <button type="button" className="subagent-prompt-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <ChevronRight size={12} className={`turn-process-chevron${open ? " expanded" : ""}`} aria-hidden />
        <span>提示词</span>
      </button>
      {open ? <div className="subagent-prompt-body">
        <p className="subagent-prompt-text">{promptText(body)}</p>
      </div> : null}
    </div>
  );
}

/** 提示词原文：只去掉 markdown 标记，保留分行。 */
export function promptText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*]\s+/, "· ").trimEnd())
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
}

/** 旧快照只有拍平的动作和末段正文。 */
function LegacySubagentStream({ call }: { call: SubagentCallView }) {
  const tools = call.toolCalls ?? [];
  const note = call.output === undefined ? "" : stripMarkdown(call.output).trim();
  return <>
    {tools.length === 0 ? null : <div className="subagent-process">
      {tools.map((entry, index) => <p className="subagent-do" key={`${entry.name}:${String(index)}`}>{subagentToolLine(entry.name, entry.summary)}</p>)}
    </div>}
    {note === "" ? null : <p className="subagent-line">{note}</p>}
  </>;
}

/** 同一条消息里既有正文又有思考时，思考是同一件事的草稿，只留正文。 */
export function visibleSubagentSteps(steps: NonNullable<SubagentCallView["recentSteps"]>): NonNullable<SubagentCallView["recentSteps"]> {
  const withText = new Set(steps.flatMap((step) => step.kind === "text" && (step.text ?? "").trim() !== "" && step.at !== undefined ? [step.at] : []));
  return steps.filter((step) => !(step.kind === "thinking" && step.at !== undefined && withText.has(step.at)));
}

/** 子代理过程：正文一档，思考与动作是旁注一档。 */
function SubagentProcess({ steps }: { steps: NonNullable<SubagentCallView["recentSteps"]> }) {
  return (
    <div className="subagent-process">
      {visibleSubagentSteps(steps).map((step, index) => {
        const key = `${step.at ?? "step"}:${String(index)}`;
        if (step.kind === "tool") return <p className="subagent-do" key={key}>{subagentToolLine(step.name ?? "tool", step.summary ?? "")}</p>;
        if (step.kind === "thinking") return <p className="subagent-think" key={key}>{stripMarkdown(step.text ?? "").trim()}</p>;
        return <p className="subagent-line" key={key}>{stripMarkdown(step.text ?? "").trim()}</p>;
      })}
    </div>
  );
}

/** 块头的执行配置：后端/profile · 短模型名 · 思考等级。 */
export function subagentCallMeta(call: SubagentCallView): string {
  return [
    call.backend !== undefined && call.backend !== "pi" ? call.backend : "",
    call.profile === undefined || call.profile === "general" ? "" : call.profile,
    call.model === undefined ? "" : displayModelName(call.model).split("/").at(-1) ?? "",
    call.thinkingLevel ?? "",
    call.worktree === true ? "worktree" : "",
  ].filter((part) => part !== "").join(" · ");
}

const SUBAGENT_TASK_CHARS = 42;

/** 已完成的子代理总耗时。 */
export function formatElapsedMs(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  return seconds < 3_600
    ? `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`
    : `${String(Math.floor(seconds / 3_600))}:${String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function subagentToolLine(name: string, summary: string): string {
  if (name === "edit") return `编辑了 ${compactTarget(summary) || "文件"}`;
  if (name === "read") return `读取了 ${compactTarget(summary) || "文件"}`;
  if (name === "write") return `写入了 ${compactTarget(summary) || "文件"}`;
  if (name === "bash" || name === "powershell") return `执行了 ${compactCommand(summary)}`;
  if (name === "grep") return summary.trim() === "" ? "搜索了项目文件" : `搜索了 ${truncateEnd(summary.trim(), SUBAGENT_TASK_CHARS)}`;
  if (name === "find") return "查找了项目文件";
  if (name === "ls") return summary.trim() === "" ? "查看了目录" : `查看了 ${compactTarget(summary) || "目录"}`;
  const target = compactTarget(summary);
  return target === "" ? name : `${name} ${target}`;
}

export function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/\*\*/g, "");
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

function compactToolStateIcon(state: ToolTimelineItem["state"], pending: boolean) {
  if (pending) return <LoaderCircle size={14} className="spin" />;
  if (state === "queued") return <span className="tool-subtle-queued" aria-label="等待执行">·</span>;
  if (state === "failed") return <CircleAlert size={14} aria-label="操作未完成" />;
  if (state === "cancelled") return <span className="tool-subtle-failure" aria-label="操作已停止">·</span>;
  return undefined;
}
