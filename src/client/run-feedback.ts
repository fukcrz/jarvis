import type { SessionStatus, TimelineItem, ToolTimelineItem } from "../shared/protocol";

export function formatRunElapsed(startedAt: string | undefined, now = Date.now()): string | undefined {
  if (startedAt === undefined) return undefined;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || started > now) return undefined;
  const elapsed = Math.floor((now - started) / 1_000);
  if (elapsed > 86_400) return undefined;
  return `${String(Math.floor(elapsed / 60))}:${String(elapsed % 60).padStart(2, "0")}`;
}

function isPendingTool(item: TimelineItem): item is ToolTimelineItem {
  return item.kind === "tool" && (item.state === "queued" || item.state === "running");
}

export interface RunStatusActivity {
  label: string;
  /** Which on-screen element the bar scrolls to. */
  target: "tool" | "thinking" | "message" | "bottom";
}

/** One-line description of what the agent is doing now, for the status bar above the composer. */
export function getRunStatusActivity(status: SessionStatus, items: TimelineItem[], streamingMessageId?: string): RunStatusActivity | undefined {
  if (status.runState === "idle") return undefined;
  if (status.runState === "stopping") return { label: "正在停止", target: "bottom" };
  if (status.compacting !== undefined) return { label: "正在压缩上下文", target: "bottom" };
  if (status.retrying !== undefined) return { label: "等待重试", target: "bottom" };
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (isPendingTool(item)) return { label: `${item.state === "queued" ? "准备执行" : "正在执行"}：${toolStep(item)}`, target: "tool" };
    if (item.kind === "thinking" && item.state === "running") return { label: "思考中", target: "thinking" };
    if (item.kind === "message" && item.id === streamingMessageId) return { label: "正在回复", target: "message" };
    if (item.kind === "message" && item.role === "user") break;
  }
  if (streamingMessageId !== undefined) return { label: "正在回复", target: "message" };
  return { label: "执行中", target: "bottom" };
}

function toolStep(tool: ToolTimelineItem): string {
  if (tool.name === "bash" || tool.name === "powershell") {
    const first = (tool.inputPreview ?? tool.target ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "");
    if (first !== undefined) return first;
  }
  return tool.target === undefined || tool.title.includes(tool.target) ? tool.title : `${tool.title} ${tool.target}`;
}
