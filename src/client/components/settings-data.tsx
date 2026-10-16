import { useCallback, useEffect, useRef, useState } from "react";
import { FileArchive, FolderOpen, Trash2 } from "lucide-react";
import type { RecoveryNotice, TrashListing } from "../../shared/system";
import { api } from "../api";
import { isDesktopShell, openLogsFolder } from "../desktop";
import { Button } from "./ui/button";
import { SettingsEmpty, SettingsGroup, SettingsRow } from "./settings-ui";

type SettingsMessageTone = "success" | "error";

/** 数据与恢复：配置恢复记录、回收站、日志与诊断包。 */
export function DataPanel({ onMessage, onSessionRestored }: {
  onMessage: (message: string, tone?: SettingsMessageTone) => void;
  onSessionRestored?: (workspaceId: string) => void;
}) {
  const [recoveries, setRecoveries] = useState<RecoveryNotice[]>([]);
  const [trash, setTrash] = useState<TrashListing | undefined>();
  const [logDirectory, setLogDirectory] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const load = useCallback(async () => {
    const [nextRecoveries, nextTrash] = await Promise.all([
      api.recoveries().catch(() => [] as RecoveryNotice[]),
      api.trash().catch((error: unknown) => {
        onMessageRef.current(error instanceof Error ? error.message : "无法读取回收站", "error");
        return undefined;
      }),
    ]);
    setRecoveries(nextRecoveries);
    void api.systemInfo().then((info) => setLogDirectory(info.logDirectory)).catch(() => undefined);
    if (nextTrash !== undefined) setTrash(nextTrash);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      const result = await api.restoreTrash(id);
      onMessage(`已还原到 ${result.restoredPath}`);
      if (result.entry.kind === "session" && result.entry.workspaceId !== undefined) onSessionRestored?.(result.entry.workspaceId);
      await load();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "还原失败", "error");
    } finally {
      setBusy(undefined);
    }
  };

  const purge = async (id: string) => {
    setBusy(id);
    try {
      await api.removeTrash(id);
      await load();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      setBusy(undefined);
    }
  };

  return <div className="settings-stack">
    {recoveries.length === 0 ? null : <SettingsGroup title="本次启动的配置恢复">
      {recoveries.map((notice) => <div key={`${notice.file}:${notice.at}`} className="settings-row">
        <span className="settings-row-main">
          <strong>{fileName(notice.file)}</strong>
          <small className="settings-plugin-note">{notice.outcome === "backup" ? "读取失败，已从备份恢复" : "读取失败且没有可用备份，已改用默认值"}（{notice.reason}）{notice.corruptPath === undefined ? "" : `。坏文件留存在 ${notice.corruptPath}`}</small>
        </span>
      </div>)}
    </SettingsGroup>}
    <SettingsGroup title="日志与诊断">
      <SettingsRow icon={FileArchive} label={<a className="settings-row-link" href="/api/system/diagnostics" download>导出诊断包</a>} value="日志、版本、配置（不含密码和 token）" />
      <SettingsRow icon={FolderOpen} label="日志目录" value={<span title={logDirectory}>{logDirectory ?? "…"}</span>} control={isDesktopShell() ? <Button size="sm" variant="secondary" onClick={() => { void openLogsFolder().catch(() => onMessage("无法打开日志目录", "error")); }}>打开</Button> : undefined} />
    </SettingsGroup>
    <SettingsGroup title={`最近删除${trash === undefined ? "" : `（保留 ${String(trash.retentionDays)} 天）`}`}>
      {trash === undefined ? <SettingsRow label="读取中…" /> : trash.entries.length === 0 ? <SettingsEmpty icon={Trash2} title="回收站是空的" /> : trash.entries.map((entry) => <div key={entry.id} className="settings-row">
        <span className="settings-row-main">
          <strong>{entry.kind === "session" ? `会话：${entry.label}` : entry.label}</strong>
          <small title={entry.originalPath}>{formatTime(entry.deletedAt)} 删除 · {entry.originalPath}</small>
        </span>
        <span className="settings-row-actions">
          <Button size="sm" variant="secondary" disabled={busy !== undefined} onClick={() => { void restore(entry.id); }}>还原</Button>
          <Button size="sm" variant="danger" disabled={busy !== undefined} onClick={() => { void purge(entry.id); }}>彻底删除</Button>
        </span>
      </div>)}
    </SettingsGroup>
  </div>;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
