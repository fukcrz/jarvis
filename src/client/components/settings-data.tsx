import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import type { RecoveryNotice, TrashListing } from "../../shared/system";
import { api, type SystemInfo } from "../api";
import { isDesktopShell, openLogsFolder } from "../desktop";
import { useSettingsToast } from "./settings-feedback";
import { SettingRow, SettingsCard, SettingsEmptyLine, SettingsLoading, SettingsPageHead, SettingsSection, SettingsTag, StButton } from "./settings-ui";

/** 数据与恢复：配置恢复记录、回收站、日志与诊断包。 */
export function DataPage({ onSessionRestored, onTrashCount }: { onSessionRestored?: (workspaceId: string) => void; onTrashCount?: (count: number) => void }) {
  const toast = useSettingsToast();
  const [recoveries, setRecoveries] = useState<RecoveryNotice[]>([]);
  const [trash, setTrash] = useState<TrashListing | undefined>();
  const [info, setInfo] = useState<SystemInfo | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [nextRecoveries, nextTrash] = await Promise.all([
      api.recoveries().catch(() => [] as RecoveryNotice[]),
      api.trash().catch((error: unknown) => {
        toast.notify(error instanceof Error ? error.message : "无法读取回收站", "error");
        return undefined;
      }),
    ]);
    setRecoveries(nextRecoveries);
    void api.systemInfo().then(setInfo).catch(() => undefined);
    if (nextTrash !== undefined) setTrash(nextTrash);
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  const visibleTrash = trash?.entries.filter((entry) => !hidden.has(entry.id)) ?? [];
  useEffect(() => { if (trash !== undefined) onTrashCount?.(visibleTrash.length); }, [onTrashCount, trash, visibleTrash.length]);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      const result = await api.restoreTrash(id);
      toast.notify(`已还原到 ${result.restoredPath}`);
      if (result.entry.kind === "session" && result.entry.workspaceId !== undefined) onSessionRestored?.(result.entry.workspaceId);
      await load();
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "还原失败", "error");
    } finally {
      setBusy(undefined);
    }
  };
  const purge = (id: string, label: string) => {
    const setHide = (value: boolean) => setHidden((current) => { const next = new Set(current); if (value) next.add(id); else next.delete(id); return next; });
    setHide(true);
    toast.showUndo({
      message: `已彻底删除 ${label}`,
      undo: () => setHide(false),
      commit: async () => { await api.removeTrash(id); await load(); setHide(false); },
      onCommitError: (error) => { setHide(false); toast.notify(error instanceof Error ? error.message : "删除失败", "error"); },
    });
  };

  const warnings = info?.warnings ?? [];
  return <>
    <SettingsPageHead title="数据与恢复" description="回收站、配置恢复记录、日志与诊断包。" />
    {warnings.length === 0 ? null : <SettingsSection id="startup-warnings" title="启动提示">
      <SettingsCard>{warnings.map((warning) => <SettingRow key={warning} leading={<AlertTriangle size={15} className="st-row-glyph warn" />} title={warning} />)}</SettingsCard>
    </SettingsSection>}
    {recoveries.length === 0 ? null : <SettingsSection id="recoveries" title="本次启动的配置恢复">
      <SettingsCard>{recoveries.map((notice) => <SettingRow key={`${notice.file}:${notice.at}`} title={fileName(notice.file)}
        description={`${notice.outcome === "backup" ? "读取失败，已从备份恢复" : "读取失败且没有可用备份，已改用默认值"}（${notice.reason}）${notice.corruptPath === undefined ? "" : `。坏文件留在 ${notice.corruptPath}`}`}
        control={<SettingsTag tone={notice.outcome === "backup" ? "acc" : "warn"}>{notice.outcome === "backup" ? "已恢复" : "已重置"}</SettingsTag>} />)}</SettingsCard>
    </SettingsSection>}
    <SettingsSection id="trash" title="最近删除" hint={trash === undefined ? undefined : `保留 ${String(trash.retentionDays)} 天`}>
      {trash === undefined ? <SettingsLoading /> : <SettingsCard>
        {visibleTrash.length === 0 ? <SettingsEmptyLine>回收站是空的。删除的会话、技能会先放在这里。</SettingsEmptyLine> : visibleTrash.map((entry) => {
          const label = entry.kind === "session" ? `会话：${entry.label}` : entry.label;
          return <SettingRow key={entry.id} id={`trash-${entry.id}`} title={label} description={`${formatTime(entry.deletedAt)} 删除 · ${entry.originalPath}`}
            control={<>
              <StButton disabled={busy !== undefined} onClick={() => { void restore(entry.id); }}><RotateCcw size={13} />还原</StButton>
              <StButton variant="ghost" icon className="danger" aria-label={`彻底删除 ${label}`} title="彻底删除" onClick={() => purge(entry.id, label)}><Trash2 size={14} /></StButton>
            </>} />;
        })}
      </SettingsCard>}
    </SettingsSection>
    <SettingsSection id="diagnostics" title="日志与诊断">
      <SettingsCard>
        <SettingRow title="导出诊断包" description="日志、版本、配置（不含密码和 token），反馈问题时附上" control={<a className="st-btn" href="/api/system/diagnostics" download><Download size={13} />导出</a>} />
        <SettingRow id="logs" title="日志目录" mono description={info?.logDirectory ?? "…"} control={isDesktopShell() ? <StButton onClick={() => { void openLogsFolder().catch(() => toast.notify("无法打开日志目录", "error")); }}><FolderOpen size={13} />打开</StButton> : undefined} />
        {info?.snapshotDirectory === undefined ? null : <SettingRow id="snapshots" title={`每日快照（保留 ${String(info.snapshotKeep ?? 7)} 份）`} mono
          description={info.snapshots === undefined || info.snapshots.length === 0 ? `还没有快照 · ${info.snapshotDirectory}` : `最近一份 ${info.snapshots[0]?.name.replace(/\.zip$/, "") ?? ""}，共 ${String(info.snapshots.length)} 份 · ${info.snapshotDirectory}`} />}
      </SettingsCard>
    </SettingsSection>
  </>;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
