import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import type { SubagentCallView, SubagentView, ToolState, ToolTimelineItem } from "../../shared/protocol";
import { imageDataUrl } from "../lib/image";
import { ImagePreview } from "./image-lightbox";

interface ToolActivityProps {
  items: ToolTimelineItem[];
  active: boolean;
  /** The enclosing process was expanded by the user. */
  expanded?: boolean;
  /** Keep the default live preview while its enclosing process is folded. */
  showActivePreview?: boolean;
  onExpand?: () => void;
}

/** Consecutive operations share one summary; untouched folds preview live work and failures. */
export function ToolActivity({ items, active, expanded = false, showActivePreview = true, onExpand }: ToolActivityProps) {
  const [open, setOpen] = useState(expanded);
  const touched = useRef(false);
  const [openToolId, setOpenToolId] = useState<string>();
  const state = activityState(items, active);
  const collapsible = items.length > 1 && !items.some((item) => item.id.startsWith("bash:"));
  const explicitlyHiddenByProcess = !expanded && !showActivePreview;
  const visible = !explicitlyHiddenByProcess && (open || !collapsible && showActivePreview)
    ? items
    : collapsedToolActivityItems(items, active, showActivePreview && !touched.current);

  useLayoutEffect(() => {
    if (!expanded) {
      touched.current = false;
      setOpen(false);
      setOpenToolId(undefined);
    } else if (!touched.current) {
      setOpen(true);
    }
  }, [expanded]);

  return (
    <article className={`activity-group ${state}`}>
      {!collapsible ? null : <button className="activity-narration" type="button" onClick={() => { touched.current = true; if (!open) onExpand?.(); else setOpenToolId(undefined); setOpen((value) => !value); }} aria-expanded={open}>
        <span className="activity-narration-icon"><ChevronRight size={13} className={open ? "expanded" : ""} /></span>
        <span className="activity-narration-text">{summarizeToolActivity(items)}</span>
      </button>}
      {visible.length === 0 ? null : <div className="activity-items">{visible.map((item) => <ToolRow key={item.id} item={item} pending={active && (item.state === "running" || item.state === "queued")} grouped={collapsible} open={openToolId === item.id} onToggle={() => { if (openToolId !== item.id) { touched.current = true; onExpand?.(); setOpen(true); } setOpenToolId((current) => current === item.id ? undefined : item.id); }} />)}</div>}
    </article>
  );
}

export function collapsedToolActivityItems(items: ToolTimelineItem[], active: boolean, showActivePreview: boolean): ToolTimelineItem[] {
  return items.filter((item) => item.state === "failed"
    || showActivePreview && active && (item.state === "running" || item.state === "queued"));
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

function ToolRow({ item, pending, open, grouped, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; grouped: boolean; onToggle: () => void }) {
  if (item.name === "bash") return <CommandToolRow item={item} pending={pending} open={open} onToggle={onToggle} />;
  if (item.subagent !== undefined) return <SubagentToolRow item={item} view={item.subagent} pending={pending} grouped={grouped} open={open} onToggle={onToggle} />;
  return <GenericToolRow item={item} pending={pending} open={open} onToggle={onToggle} />;
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
  return `子代理 ${String(view.completed)}/${String(view.total)}`;
}

export function subagentRowLabel(view: SubagentView, grouped: boolean): string {
  const only = view.results.length === 1 ? view.results[0] : undefined;
  if (only !== undefined) return `${only.agent} · ${subagentCallStateLabel(only.state)}`;
  if (view.results.length === 0) return "子代理";
  const who = runningAgentLabel(view);
  if (who !== "" && grouped) return `${who} · 执行中`;
  if (who !== "") return `子代理 ${String(view.completed)}/${String(view.total)} · ${who}`;
  if (view.failed === view.total) return `${String(view.failed)}/${String(view.total)} 失败`;
  const cancelled = view.results.filter((call) => call.state === "cancelled").length;
  if (cancelled === view.total) return `${String(cancelled)} 已停止`;
  return `子代理 ${String(view.completed)}/${String(view.total)}`;
}

function runningAgentLabel(view: SubagentView): string {
  const names = [...new Set(view.results.filter((call) => call.state === "running").map((call) => call.agent))];
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join("、");
  return `${names.slice(0, 2).join("、")} 等`;
}

function subagentCallStateLabel(state: SubagentCallView["state"]): string {
  if (state === "running") return "执行中";
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
  if (value === undefined || value.trim() === "") return "命令";
  const normalized = value.trim().replace(/^(?:cd\s+[^;&]+\s*&&\s*)+/i, "").replace(/\s+/g, " ");
  return normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized;
}

function GenericToolRow({ item, pending, open, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; onToggle: () => void }) {
  const output = item.error ?? item.output;
  const images = item.images ?? [];
  const stateIcon = compactToolStateIcon(item.state, pending);
  return (
    <article className={`tool-item tool-list-item ${item.state}`}>
      <button className="tool-summary" type="button" onClick={onToggle} aria-expanded={open}>
        {stateIcon === undefined ? null : <span className="tool-state-icon">{stateIcon}</span>}
        <span className="tool-title">{toolActivityLabel(item)}</span>
      </button>
      {open ? <div className="tool-details inline-details">
        {images.length === 0 ? null : <div className="tool-images" aria-label="读取到的图片">
          {images.map((image, index) => <ImagePreview key={`${image.mimeType}:${index}`} className="message-image-thumb" src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`}><img src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`} loading="lazy" /></ImagePreview>)}
        </div>}
        {item.name === "read" ? null : item.inputPreview === undefined ? null : <div className="detail-input"><span className="detail-label">输入</span><code>{item.inputPreview}</code></div>}
        {output === undefined ? null : <div><pre className={item.error === undefined ? "" : "tool-error-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function SubagentToolRow({ item, view, pending, grouped, open, onToggle }: { item: ToolTimelineItem; view: SubagentView; pending: boolean; grouped: boolean; open: boolean; onToggle: () => void }) {
  const stateIcon = compactToolStateIcon(item.state, pending);
  const preview = open ? "" : subagentLivePreview(view);
  const single = view.results.length === 1 ? view.results[0] : undefined;
  return (
    <article className={`tool-item tool-list-item subagent-item ${item.state}`}>
      <button className="tool-summary subagent-summary" type="button" onClick={onToggle} aria-expanded={open}>
        {stateIcon === undefined ? null : <span className="tool-state-icon">{stateIcon}</span>}
        <span className="subagent-summary-copy">
          <span className="tool-title">{subagentRowLabel(view, grouped)}</span>
          {preview === "" ? null : <span className="subagent-preview">{preview}</span>}
        </span>
      </button>
      {open ? <div className="tool-details inline-details">
        {single !== undefined ? <SubagentCallBody call={single} /> : <SubagentCallList results={view.results} />}
        {view.results.length === 0 && item.error !== undefined ? <p className="subagent-error">{item.error}</p> : null}
      </div> : null}
    </article>
  );
}

export function SubagentCallList({ results }: { results: SubagentCallView[] }) {
  const [openIndex, setOpenIndex] = useState<number>();
  return (
    <div className="subagent-calls">
      {results.map((call, index) => {
        const callOpen = openIndex === index;
        const preview = callOpen || call.state !== "running" ? "" : subagentStatusLine(call.output ?? "");
        return (
          <div className={`subagent-call ${call.state}`} key={`${call.agent}:${String(index)}`}>
            <button className="subagent-call-summary" type="button" aria-expanded={callOpen} onClick={() => setOpenIndex(callOpen ? undefined : index)}>
              {call.state === "failed" ? <CircleAlert size={13} aria-label="失败" /> : null}
              <span>{call.agent} · {subagentCallStateLabel(call.state)}</span>
            </button>
            {preview === "" ? null : <p className="subagent-preview subagent-call-preview">{preview}</p>}
            {callOpen ? <SubagentCallBody call={call} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function SubagentCallBody({ call }: { call: SubagentCallView }) {
  const task = subagentTaskLine(call.prompt);
  const tools = call.toolCalls ?? [];
  const note = call.output === undefined ? "" : stripMarkdown(call.output).trim();
  return (
    <div className="subagent-call-body">
      {task === "" ? null : <p className="subagent-task">{task}</p>}
      {tools.length === 0 ? null : <ul className="subagent-steps">
        {tools.map((entry, index) => <li key={`${entry.name}:${String(index)}`}>{subagentToolLine(entry.name, entry.summary)}</li>)}
      </ul>}
      {note === "" ? null : <p className="subagent-note">{note}</p>}
      {call.error === undefined ? null : <p className="subagent-error">{call.error}</p>}
    </div>
  );
}

function subagentLivePreview(view: SubagentView): string {
  const running = [...view.results].reverse().find((call) => call.state === "running" && (call.output ?? "") !== "");
  return running?.output === undefined ? "" : subagentStatusLine(running.output);
}

const SUBAGENT_TASK_CHARS = 42;
const SUBAGENT_PREVIEW_CHARS = 36;

export function subagentTaskLine(prompt: string): string {
  const plain = stripMarkdown(prompt).replace(/\s+/g, " ").trim();
  if (plain === "") return "";
  const fullColon = plain.lastIndexOf("：");
  const asciiColon = plain.lastIndexOf(": ");
  const colon = Math.max(fullColon, asciiColon);
  const suffix = colon < 0 ? "" : plain.slice(colon + (plain[colon] === "：" ? 1 : 2)).trim();
  return truncateEnd(suffix.length >= 8 ? suffix : plain, SUBAGENT_TASK_CHARS);
}

export function subagentStatusLine(text: string): string {
  const plain = stripMarkdown(text).replace(/\s+/g, " ").trim();
  if (plain === "") return "";
  const parts = plain.split(/(?<=[。！？.!?])/).map((part) => part.trim()).filter((part) => part !== "");
  return truncateEnd(parts.at(-1) ?? plain, SUBAGENT_PREVIEW_CHARS);
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
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "");
}

function truncateEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function CommandToolRow({ item, pending, open, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; onToggle: () => void }) {
  const command = item.inputPreview ?? item.target ?? "";
  const output = item.error ?? item.output;
  const stateIcon = compactToolStateIcon(item.state, pending);
  return (
    <article className={`tool-item tool-list-item command-item ${item.state}`}>
      <button className="tool-summary command-summary" type="button" onClick={onToggle} aria-expanded={open}>
        {stateIcon === undefined ? null : <span className="tool-state-icon">{stateIcon}</span>}
        <span className="tool-target">{compactCommand(command)}</span>
        {item.excludeFromContext === true ? <span className="command-excluded" title="输出不会发送给模型">不进上下文</span> : null}
      </button>
      {open ? <div className="tool-details command-details inline-details">
        <div className="detail-command-line"><code>$ {command || "(empty)"}</code></div>
        {item.cwd === undefined ? null : <div className="detail-input"><span className="detail-label">工作目录</span><code>{item.cwd}</code></div>}
        {output === undefined ? null : <div><pre className={item.error === undefined ? "command-output" : "tool-error-output command-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function compactToolStateIcon(state: ToolTimelineItem["state"], pending: boolean) {
  if (pending) return <LoaderCircle size={14} className="spin" />;
  if (state === "failed") return <CircleAlert size={14} aria-label="操作未完成" />;
  if (state === "cancelled") return <span className="tool-subtle-failure" aria-label="操作已停止">·</span>;
  return undefined;
}
