import { useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, Quote } from "lucide-react";
import type { SubagentCallView, SubagentView, ToolState, ToolTimelineItem } from "../../shared/protocol";
import { imageDataUrl } from "../lib/image";
import { ImagePreview } from "./image-lightbox";

interface ToolActivityProps {
  items: ToolTimelineItem[];
  active: boolean;
  /** 短旁白：当折叠标题，点开才露出工具列表。 */
  narration?: string;
}

/** 工具行平铺；有短旁白时旁白当可点标题，默认收起。 */
export function ToolActivity({ items, active, narration }: ToolActivityProps) {
  const text = narration?.trim() ?? "";
  const narrated = text !== "";
  const [open, setOpen] = useState(() => !narrated || active);
  const touched = useRef(false);
  const [openToolId, setOpenToolId] = useState<string>();
  const state = activityState(items, active);
  const pendingToolId = state === "running"
    ? (items.find((item) => item.state === "running") ?? items.find((item) => item.state === "queued"))?.id
    : undefined;

  useEffect(() => {
    if (!narrated || touched.current) return;
    setOpen(active);
  }, [active, narrated]);

  return (
    <article className={`activity-group ${state}${narrated ? " narrated" : ""}`}>
      {narrated ? <button className="activity-narration" type="button" onClick={() => { touched.current = true; setOpen((value) => !value); }} aria-expanded={open}>
        <span className="activity-narration-icon">{state === "running" && !open ? <LoaderCircle size={14} className="spin" /> : <Quote size={14} />}</span>
        <span className="activity-narration-text">{text}</span>
      </button> : null}
      {!narrated || open ? <div className="activity-items">{items.map((item) => <ToolRow key={item.id} item={item} pending={item.id === pendingToolId} open={openToolId === item.id} onToggle={() => setOpenToolId((current) => current === item.id ? undefined : item.id)} />)}</div> : null}
    </article>
  );
}

function ToolRow({ item, pending, open, onToggle }: { item: ToolTimelineItem; pending: boolean; open: boolean; onToggle: () => void }) {
  if (item.name === "bash") return <CommandToolRow item={item} pending={pending} open={open} onToggle={onToggle} />;
  if (item.subagent !== undefined) return <SubagentToolRow item={item} view={item.subagent} pending={pending} open={open} onToggle={onToggle} />;
  return <GenericToolRow item={item} pending={pending} open={open} onToggle={onToggle} />;
}

function activityState(items: ToolTimelineItem[], active: boolean): ToolState {
  if (active) return "running";
  if (items.length > 0 && items.every((item) => item.state === "cancelled")) return "cancelled";
  return "completed";
}

function toolActivityLabel(item: ToolTimelineItem): string {
  if (item.subagent !== undefined) return subagentActivityLabel(item.subagent);
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

function subagentActivityLabel(view: SubagentView): string {
  if (view.results.length === 1) {
    const call = view.results[0];
    return call === undefined ? "subagent" : `${call.agent} · ${subagentCallStateLabel(call.state)}`;
  }
  if (view.results.length === 0) return "subagent";
  if (view.running > 0) return `${String(view.completed)}/${String(view.total)} 完成`;
  if (view.failed === view.total) return `${String(view.failed)}/${String(view.total)} 失败`;
  const cancelled = view.results.filter((call) => call.state === "cancelled").length;
  if (cancelled === view.total) return `${String(cancelled)} 已停止`;
  return `${String(view.completed)}/${String(view.total)} 完成`;
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
          {images.map((image, index) => <ImagePreview key={`${image.mimeType}:${index}`} src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`}><button type="button" className="message-image-thumb" aria-label={`预览图片 ${String(index + 1)}`}><img src={imageDataUrl(image)} alt={`图片 ${String(index + 1)}`} loading="lazy" /></button></ImagePreview>)}
        </div>}
        {item.name === "read" ? null : item.inputPreview === undefined ? null : <div className="detail-input"><span className="detail-label">输入</span><code>{item.inputPreview}</code></div>}
        {output === undefined ? null : <div><pre className={item.error === undefined ? "" : "tool-error-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function SubagentToolRow({ item, view, pending, open, onToggle }: { item: ToolTimelineItem; view: SubagentView; pending: boolean; open: boolean; onToggle: () => void }) {
  const stateIcon = compactToolStateIcon(item.state, pending);
  return (
    <article className={`tool-item tool-list-item ${item.state}`}>
      <button className="tool-summary" type="button" onClick={onToggle} aria-expanded={open}>
        {stateIcon === undefined ? null : <span className="tool-state-icon">{stateIcon}</span>}
        <span className="tool-title">{subagentActivityLabel(view)}</span>
      </button>
      {open ? <div className="tool-details inline-details">
        {view.results.map((call, index) => <SubagentCallDetails key={`${call.agent}:${String(index)}`} call={call} />)}
        {view.results.length === 0 && item.error !== undefined ? <div><pre className="tool-error-output">{item.error}</pre></div> : null}
      </div> : null}
    </article>
  );
}

function SubagentCallDetails({ call }: { call: SubagentCallView }) {
  const tools = call.toolCalls ?? [];
  return (
    <div>
      <div className="detail-input"><span className="detail-label">{call.agent}</span>{call.prompt === "" ? null : <code>{call.prompt}</code>}</div>
      {tools.length === 0 ? null : <div className="detail-input"><code>{tools.map((entry) => entry.summary === "" ? entry.name : `${entry.name} ${entry.summary}`).join(" · ")}</code></div>}
      {call.output === undefined ? null : <div><pre>{call.output}</pre></div>}
      {call.error === undefined ? null : <div><pre className="tool-error-output">{call.error}</pre></div>}
    </div>
  );
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
