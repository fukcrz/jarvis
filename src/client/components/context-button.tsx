import { useEffect, useState } from "react";
import { Archive, LoaderCircle } from "lucide-react";
import type { AssistantGenerationStats, ContextUsage, LiveGenerationStats, TokenUsage } from "../../shared/protocol";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { Tooltip } from "./ui/tooltip";

const RING_RADIUS = 14;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type UsageTone = "unknown" | "ok" | "warm" | "hot";

interface ContextButtonProps {
  contextUsage?: ContextUsage;
  sessionUsage?: TokenUsage;
  latestGeneration?: AssistantGenerationStats;
  liveGeneration?: LiveGenerationStats;
  /** Websocket is not live; opening the details is pointless. */
  disabled: boolean;
  /** A run is active or compaction is pending; the compact action is blocked. */
  busy: boolean;
  onCompact: () => void;
}

export function ContextButton({ contextUsage, sessionUsage, latestGeneration, liveGeneration, disabled, busy, onCompact }: ContextButtonProps) {
  const [open, setOpen] = useState(false);
  const percent = contextUsage?.percent ?? null;
  const tone = usageTone(percent);
  const label = percent === null ? "上下文" : `上下文已使用 ${Math.round(percent)}%`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip label={label}>
        <Button variant="ghost" size="icon" className={`context-ring ${tone}`} aria-label="上下文详情" disabled={disabled} onClick={() => setOpen(true)}>
          {/* 始终显示圆形进度环：用量未知（如压缩后）时显示空环，而不是退化成图标 */}
          <Ring percent={percent ?? 0} />
        </Button>
      </Tooltip>
      <DialogContent className="selector-sheet context-dialog" title="上下文">
        <div className="context-dialog-body">
          <div className={`context-dialog-ring ${tone}`}>
            <Ring percent={percent ?? 0} />
            <span>{percent === null ? "—" : `${Math.round(percent)}%`}</span>
          </div>
          <div className="context-dialog-section">
            <strong className="context-dialog-section-title">上下文</strong>
            <div className="context-dialog-stats">
              <div><span>已用</span><strong>{percent === null ? "—" : formatTokens(contextUsage?.tokens ?? 0)}</strong></div>
              <div><span>窗口</span><strong>{formatTokens(contextUsage?.contextWindow ?? 0)}</strong></div>
              <div><span>占用</span><strong>{percent === null ? "—" : `${Math.round(percent)}%`}</strong></div>
            </div>
          </div>
          {liveGeneration === undefined && latestGeneration === undefined ? null : <GenerationSection live={liveGeneration} latest={latestGeneration} />}
          {sessionUsage === undefined ? null : <UsageSection usage={sessionUsage} />}
          <Button variant="default" className="context-compact" disabled={disabled || busy} onClick={() => { setOpen(false); onCompact(); }}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />}
            {busy ? "运行中无法压缩" : "压缩上下文"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GenerationSection({ live, latest }: { live?: LiveGenerationStats; latest?: AssistantGenerationStats }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (live === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live?.startedAt]);
  const liveSection = live === undefined ? null : (() => {
    const started = Date.parse(live.startedAt);
    const durationMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
    const speed = durationMs > 0 && (live.estimatedOutputTokens ?? 0) > 0 ? (live.estimatedOutputTokens ?? 0) / (durationMs / 1_000) : undefined;
    return <div className="context-dialog-section">
      <strong className="context-dialog-section-title">正在生成</strong>
      <div className="context-dialog-stats generation-stats">
        <div><span>已生成</span><strong>{live.estimatedOutputTokens === undefined ? "—" : `≈${formatTokens(live.estimatedOutputTokens)}`}</strong></div>
        <div><span>速度</span><strong>{speed === undefined ? "计算中" : `≈${formatRate(speed)}`}</strong></div>
        <div><span>用时</span><strong>{formatDuration(durationMs)}</strong></div>
      </div>
    </div>;
  })();
  const latestSection = latest === undefined ? null : (() => {
    const speed = latest.durationMs === undefined || latest.durationMs <= 0 ? undefined : latest.usage.output / (latest.durationMs / 1_000);
    return <div className="context-dialog-section">
      <strong className="context-dialog-section-title">最近一轮</strong>
      <div className="context-dialog-stats generation-stats">
        <div><span>输出</span><strong>{formatTokens(latest.usage.output)}</strong></div>
        <div><span>速度</span><strong>{speed === undefined ? "—" : formatRate(speed)}</strong></div>
        <div><span>用时</span><strong>{latest.durationMs === undefined ? "—" : formatDuration(latest.durationMs)}</strong></div>
      </div>
    </div>;
  })();
  return <>{liveSection}{latestSection}</>;
}

function UsageSection({ usage }: { usage: TokenUsage }) {
  return <div className="context-dialog-section">
    <strong className="context-dialog-section-title">会话累计</strong>
    <div className="context-dialog-usage">
      <div><span>输入</span><strong>{formatTokens(usage.input)}</strong></div>
      <div><span>输出</span><strong>{formatTokens(usage.output)}</strong></div>
      <div><span>缓存读取</span><strong>{formatTokens(usage.cacheRead)}</strong></div>
      <div><span>缓存写入</span><strong>{formatTokens(usage.cacheWrite)}</strong></div>
      <div><span>总计</span><strong>{formatTokens(usage.total)}</strong></div>
      {usage.cost === undefined || usage.cost <= 0 ? null : <div><span>费用</span><strong>{formatCost(usage.cost)}</strong></div>}
    </div>
  </div>;
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} token/s`;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "—";
  if (cost < 0.001) return "< $0.001";
  return `$${cost.toFixed(3)}`;
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

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}
