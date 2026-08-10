import { useState } from "react";
import { Archive, LoaderCircle } from "lucide-react";
import type { ContextUsage } from "../../shared/protocol";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { Tooltip } from "./ui/tooltip";

const RING_RADIUS = 14;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type UsageTone = "unknown" | "ok" | "warm" | "hot";

interface ContextButtonProps {
  contextUsage?: ContextUsage;
  /** Websocket is not live; opening the details is pointless. */
  disabled: boolean;
  /** A run is active or compaction is pending; the compact action is blocked. */
  busy: boolean;
  onCompact: () => void;
}

export function ContextButton({ contextUsage, disabled, busy, onCompact }: ContextButtonProps) {
  const [open, setOpen] = useState(false);
  const percent = contextUsage?.percent ?? null;
  const tone = usageTone(percent);
  const label = percent === null ? "查看上下文详情" : `上下文已使用 ${Math.round(percent)}%（点击查看详情）`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip label={label}>
        <Button variant="ghost" size="icon" className={`context-ring ${tone}`} aria-label="上下文详情" disabled={disabled} onClick={() => setOpen(true)}>
          {percent === null ? <Archive size={14} /> : <Ring percent={percent} />}
        </Button>
      </Tooltip>
      <DialogContent className="selector-sheet context-dialog" title="上下文">
        <div className="context-dialog-body">
          <div className={`context-dialog-ring ${tone}`}>
            {percent === null ? <Archive size={24} /> : <>
              <Ring percent={percent} />
              <span>{Math.round(percent)}%</span>
            </>}
          </div>
          <div className="context-dialog-stats">
            <div><span>已用</span><strong>{percent === null ? "—" : formatTokens(contextUsage?.tokens ?? 0)}</strong></div>
            <div><span>窗口</span><strong>{formatTokens(contextUsage?.contextWindow ?? 0)}</strong></div>
            <div><span>占用</span><strong>{percent === null ? "—" : `${Math.round(percent)}%`}</strong></div>
          </div>
          <p className="context-dialog-hint">{usageHint(percent)}</p>
          <Button variant="default" className="context-compact" disabled={disabled || busy} onClick={() => { setOpen(false); onCompact(); }}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}
            {busy ? "运行中无法压缩" : "压缩上下文"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Ring({ percent }: { percent: number }) {
  return (
    <svg className="context-ring-svg" viewBox="0 0 36 36" aria-hidden="true">
      <circle className="context-ring-track" cx="18" cy="18" r={RING_RADIUS} />
      <circle
        className="context-ring-progress"
        cx="18"
        cy="18"
        r={RING_RADIUS}
        style={{ strokeDasharray: `${(percent / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}` }}
      />
    </svg>
  );
}

function usageTone(percent: number | null): UsageTone {
  if (percent === null) return "unknown";
  if (percent < 60) return "ok";
  if (percent < 85) return "warm";
  return "hot";
}

function usageHint(percent: number | null): string {
  if (percent === null) return "当前无法估算上下文使用量。";
  if (percent < 60) return "上下文使用正常。";
  if (percent < 85) return "上下文接近上限，建议压缩以继续长任务。";
  return "上下文即将耗尽，建议立即压缩。";
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
