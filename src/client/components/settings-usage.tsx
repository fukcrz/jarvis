import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import type { UsageBucket, UsageDayRow, UsageRange, UsageStats } from "../../shared/usage";
import { SettingsCard, SettingsPageHead, SettingsSection, StButton } from "./settings-ui";

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "7d", label: "7 天" },
  { id: "30d", label: "30 天" },
  { id: "90d", label: "90 天" },
  { id: "all", label: "全部" },
];

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>("30d");
  const [workspaceId, setWorkspaceId] = useState("");
  const [stats, setStats] = useState<UsageStats | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback((next: UsageRange, workspace: string) => {
    setLoading(true);
    setError(undefined);
    void api.usage(next, workspace).then(setStats, (cause: unknown) => setError(cause instanceof Error ? cause.message : "读取失败")).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(range, workspaceId); }, [load, range, workspaceId]);

  const totals = stats?.totals;

  return <>
    <SettingsPageHead title="用量" extra={<RangeSwitch value={range} onChange={setRange} />} />
    {error !== undefined ? <SettingsCard><div className="usage-empty"><span>{error}</span><StButton onClick={() => load(range, workspaceId)}>重试</StButton></div></SettingsCard> : null}
    {stats === undefined && error === undefined ? <p className="usage-note">读取中…</p> : null}
    {stats === undefined || totals === undefined ? null : <>
      <div className="usage-hero">
        <div className="usage-hero-cost">
          <span>Token</span>
          <strong>{formatTokens(totals.total)}</strong>
          <small>{loading ? "更新中" : heroMeta(stats)}</small>
        </div>
        <div className="usage-hero-side">
          <HeroStat label="调用" value={String(totals.calls)} />
          <HeroStat label="输入" value={formatTokens(totals.input)} />
          <HeroStat label="输出" value={formatTokens(totals.output)} />
          <HeroStat label="缓存命中" value={formatRate(cacheHitRate(totals))} hint={formatTokens(totals.cacheRead)} />
        </div>
      </div>
      {stats.byDay.length > 0 ? <SettingsSection title="按天" hint={daySpan(stats.byDay)}><DayList rows={stats.byDay} /></SettingsSection> : null}
      <div className="usage-split">
        <SettingsSection title="供应商">
          {stats.byProvider.length === 0 ? <p className="usage-note">这段时间没有用量。</p> : <ShareList rows={stats.byProvider} name={(row) => row.provider} bars={false} />}
        </SettingsSection>
        <SettingsSection title="模型">
          {stats.byModel.length === 0 ? null : <ShareList rows={stats.byModel} name={(row) => modelLabel(row)} bars={false} />}
        </SettingsSection>
      </div>
      {stats.byWorkspace.length > 0 ? <SettingsSection title="工作区" action={workspaceId === "" ? undefined : <button type="button" className="st-act" onClick={() => setWorkspaceId("")}>全部</button>}>
        <ShareList rows={stats.byWorkspace} name={(row) => row.label} onPick={(row) => setWorkspaceId(row.workspaceId === workspaceId ? "" : row.workspaceId)} selected={(row) => row.workspaceId === workspaceId} />
      </SettingsSection> : null}
    </>}
  </>;
}

function heroMeta(stats: UsageStats): string {
  const parts = [`${String(stats.sessions)} 个会话`];
  if (stats.totals.cost > 0) parts.push(formatCost(stats.totals.cost));
  if (stats.unreadable > 0) parts.push(`${String(stats.unreadable)} 个读不了`);
  return parts.join(" · ");
}

function RangeSwitch({ value, onChange }: { value: UsageRange; onChange: (range: UsageRange) => void }) {
  return <div className="usage-range" role="group" aria-label="时间范围">
    {RANGES.map((item) => <button type="button" key={item.id} className={item.id === value ? "on" : ""} aria-pressed={item.id === value} onClick={() => onChange(item.id)}>{item.label}</button>)}
  </div>;
}

function HeroStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="usage-hero-stat"><span>{label}</span><b>{value}</b>{hint === undefined ? null : <small>{hint}</small>}</div>;
}

/** Share of the prompt served from cache. Writes count as misses: they were sent, not reused. */
function cacheHitRate(bucket: UsageBucket): number | undefined {
  const prompt = bucket.input + bucket.cacheRead + bucket.cacheWrite;
  if (prompt <= 0) return undefined;
  return bucket.cacheRead / prompt;
}

function formatRate(rate: number | undefined): string {
  if (rate === undefined) return "—";
  return `${String(Math.round(rate * 100))}%`;
}

/** Days ordered as returned (newest first), each bar against the busiest day. */
function DayList({ rows }: { rows: UsageDayRow[] }) {
  const max = Math.max(...rows.map((row) => row.total), 1);
  return <UsageTable>
    {rows.map((row) => {
      const width = Math.max(row.total > 0 ? 2 : 0, Math.round((row.total / max) * 100));
      return <tr key={row.day}>
        <td className="usage-row-name">{formatDay(row.day)}</td>
        <td className="usage-track-cell"><span className="usage-track"><span style={{ width: `${String(width)}%` }} /></span></td>
        <RowFigure bucket={row} meta={dayMeta(row)} />
      </tr>;
    })}
  </UsageTable>;
}

function daySpan(rows: UsageDayRow[]): string {
  const oldest = rows[rows.length - 1]?.day;
  const newest = rows[0]?.day;
  if (oldest === undefined || newest === undefined || oldest === newest) return `${String(rows.length)} 天`;
  return `${formatDay(oldest)} – ${formatDay(newest)}`;
}

function formatDay(day: string): string {
  const [, month, date] = day.split("-");
  return month === undefined || date === undefined ? day : `${String(Number(month))}/${String(Number(date))}`;
}

function dayMeta(row: UsageDayRow): string {
  const calls = `${String(row.calls)} 次`;
  const name = named(row.topProvider);
  if (name === undefined) return calls;
  return row.models > 1 ? `${calls} · ${name} 等 ${String(row.models)} 个` : `${calls} · ${name}`;
}

/** One bar per row, scaled to the row with the most tokens. */
function ShareList<T extends UsageBucket>({ rows, name, detail, bars = true, onPick, selected }: { rows: T[]; name: (row: T) => string; detail?: (row: T) => string; bars?: boolean; onPick?: (row: T) => void; selected?: (row: T) => boolean }) {
  const max = Math.max(...rows.map((row) => row.total), 1);
  return <UsageTable>
    {rows.map((row) => {
      const label = name(row);
      const extra = detail?.(row);
      const width = Math.max(row.total > 0 ? 2 : 0, Math.round((row.total / max) * 100));
      const on = selected?.(row) === true;
      return <tr key={`${extra ?? ""}/${label}`} className={`${onPick === undefined ? "" : "pick"}${on ? " on" : ""}`} aria-pressed={onPick === undefined ? undefined : on} onClick={onPick === undefined ? undefined : () => onPick(row)} onKeyDown={onPick === undefined ? undefined : (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(row); } }}>
        <td className="usage-row-name"><b>{label}</b>{extra === undefined ? null : <small>{extra}</small>}</td>
        {bars ? <td className="usage-track-cell"><span className="usage-track"><span style={{ width: `${String(width)}%` }} /></span></td> : null}
        <RowFigure bucket={row} meta={`${String(row.calls)} 次`} />
      </tr>;
    })}
  </UsageTable>;
}

function UsageTable({ children }: { children: ReactNode }) {
  return <div className="usage-list"><table><tbody>{children}</tbody></table></div>;
}

function RowFigure({ bucket, meta }: { bucket: UsageBucket; meta: string }) {
  const rate = formatRate(cacheHitRate(bucket));
  return <>
    <td className="usage-row-tokens">{formatTokens(bucket.total)}</td>
    <td className="usage-row-meta">{rate === "—" ? meta : `${rate} · ${meta}`}</td>
  </>;
}

/** A missing model name falls back to its provider, so unnamed rows stay distinguishable. */
function modelLabel(row: { model: string; provider: string }): string {
  return named(row.model) ?? named(row.provider) ?? "unknown";
}

function named(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" && value !== "unknown" ? value : undefined;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "—";
  if (cost < 0.001) return "< $0.001";
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
