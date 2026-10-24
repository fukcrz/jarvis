import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { UsageBucket, UsageDayRow, UsageRange, UsageStats } from "../../shared/usage";
import { SettingsCard, SettingsPageHead, SettingsSection, StButton } from "./settings-ui";

const RANGES: { id: UsageRange; label: string }[] = [
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

  return <>
    <SettingsPageHead title="用量" description="每次调用结束时记下用量，删除会话后仍然保留。" extra={<RangeSwitch value={range} onChange={setRange} />} />
    {error !== undefined ? <SettingsCard><div className="usage-empty"><span>{error}</span><StButton onClick={() => load(range, workspaceId)}>重试</StButton></div></SettingsCard> : null}
    {stats === undefined && error === undefined ? <p className="usage-note">读取中…</p> : null}
    {stats === undefined ? null : <>
      <SettingsSection title="合计" hint={loading ? "更新中" : `${String(stats.sessions)} 个会话${stats.unreadable > 0 ? ` · ${String(stats.unreadable)} 个读不了` : ""}`}>
        <div className="usage-totals">
          <div className="usage-totals-row tokens">
            <Total label="输入" value={formatTokens(stats.totals.input)} />
            <Total label="输出" value={formatTokens(stats.totals.output)} />
            <Total label="缓存读取" value={formatTokens(stats.totals.cacheRead)} />
            <Total label="缓存写入" value={formatTokens(stats.totals.cacheWrite)} />
            <Total label="推理" value={formatTokens(stats.totals.reasoning)} />
          </div>
          <div className="usage-totals-row meta">
            <Total label="费用" value={formatCost(stats.totals.cost)} />
            <Total label="调用" value={String(stats.totals.calls)} />
          </div>
        </div>
        {stats.totals.calls > 0 && stats.totals.pricedCalls < stats.totals.calls ? <p className="usage-note">{stats.totals.pricedCalls === 0 ? "供应商没有回报费用。" : `${String(stats.totals.calls - stats.totals.pricedCalls)} 次调用没有回报费用，未计入。`}</p> : null}
      </SettingsSection>
      {stats.byDay.length > 1 ? <SettingsSection title="按天"><DayChart rows={stats.byDay} /></SettingsSection> : null}
      <SettingsSection title="供应商">
        {stats.byProvider.length === 0 ? <p className="usage-note">这段时间没有用量。</p> : <UsageTable rows={stats.byProvider} name={(row) => row.provider} />}
      </SettingsSection>
      <SettingsSection title="模型">
        {stats.byModel.length === 0 ? null : <UsageTable rows={stats.byModel} name={(row) => row.model} detail={(row) => row.provider} />}
      </SettingsSection>
      {stats.byWorkspace.length > 0 ? <SettingsSection title="工作区" action={workspaceId === "" ? undefined : <button type="button" className="st-act" onClick={() => setWorkspaceId("")}>全部</button>}>
        <UsageTable rows={stats.byWorkspace} name={(row) => row.label} onPick={(row) => setWorkspaceId(row.workspaceId === workspaceId ? "" : row.workspaceId)} selected={(row) => row.workspaceId === workspaceId} />
      </SettingsSection> : null}
    </>}
  </>;
}

function RangeSwitch({ value, onChange }: { value: UsageRange; onChange: (range: UsageRange) => void }) {
  return <div className="usage-range" role="group" aria-label="时间范围">
    {RANGES.map((item) => <button type="button" key={item.id} className={item.id === value ? "on" : ""} aria-pressed={item.id === value} onClick={() => onChange(item.id)}>{item.label}</button>)}
  </div>;
}

function Total({ label, value }: { label: string; value: string }) {
  return <div className="usage-total"><span>{label}</span><strong>{value}</strong></div>;
}

function DayChart({ rows }: { rows: UsageDayRow[] }) {
  const max = Math.max(...rows.map((row) => row.total), 1);
  return <div className="usage-days" role="img" aria-label="每天的 token">
    {rows.map((row) => <div key={row.day} className="usage-day" title={`${row.day} · ${formatTokens(row.total)} · ${formatCost(row.cost)}`}>
      <span style={{ height: `${String(Math.max(4, Math.round((row.total / max) * 100)))}%` }} />
    </div>)}
  </div>;
}

const COLUMNS = ["费用", "输入", "输出", "缓存读", "缓存写", "推理", "调用"] as const;

function UsageTable<T extends UsageBucket>({ rows, name, detail, onPick, selected }: { rows: T[]; name: (row: T) => string; detail?: (row: T) => string; onPick?: (row: T) => void; selected?: (row: T) => boolean }) {
  return <div className="usage-table-wrap"><table className="usage-table">
    <thead><tr><th>名称</th>{COLUMNS.map((column) => <th key={column}>{column}</th>)}</tr></thead>
    <tbody>
      {rows.map((row) => {
        const label = name(row);
        const extra = detail?.(row);
        const on = selected?.(row) === true;
        return <tr key={`${extra ?? ""}/${label}`} className={`${onPick === undefined ? "" : "pick"}${on ? " on" : ""}`} aria-current={on ? "true" : undefined} onClick={onPick === undefined ? undefined : () => onPick(row)}>
          <td><b>{label}</b>{extra === undefined ? null : <small>{extra}</small>}</td>
          <td>{formatCost(row.cost)}</td>
          <td>{formatTokens(row.input)}</td>
          <td>{formatTokens(row.output)}</td>
          <td>{formatTokens(row.cacheRead)}</td>
          <td>{formatTokens(row.cacheWrite)}</td>
          <td>{formatTokens(row.reasoning)}</td>
          <td>{String(row.calls)}</td>
        </tr>;
      })}
    </tbody>
  </table></div>;
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
