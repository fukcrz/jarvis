import type { SessionStatus, TimelineItem, ToolTimelineItem } from "../shared/protocol";

export interface RunFeedback {
  label: string;
  tone: "working" | "stopping";
  startedAt?: string;
}

export function getRunFeedback(status: SessionStatus, items: TimelineItem[], streamingMessageId?: string): RunFeedback | undefined {
  if (status.runState === "idle") return undefined;
  if (status.runState === "stopping") return { label: "正在停止…", tone: "stopping", startedAt: status.activeRun?.startedAt };
  if (status.compacting !== undefined || status.retrying !== undefined || streamingMessageId !== undefined) return undefined;

  const activeTool = [...items].reverse().find(isPendingTool);
  if (activeTool !== undefined) {
    const verb = activeTool.state === "queued" ? "准备中" : "执行中";
    return { label: `${verb} ${activeTool.title}`, tone: "working", startedAt: status.activeRun?.startedAt };
  }
  return { label: "执行中…", tone: "working", startedAt: status.activeRun?.startedAt };
}

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
