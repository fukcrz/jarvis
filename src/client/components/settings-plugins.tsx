import { Puzzle, Settings2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { PluginCatalogItem, PluginSnapshot } from "../../shared/plugins";
import { api } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { SettingsEmpty, SettingsFormSection, SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-ui";

type Confirm =
  | { kind: "overwrite"; id: string; label: string }
  | { kind: "disable-modified"; id: string; label: string }
  | { kind: "remove"; source: string; label: string }
  | { kind: "install"; source: string; label: string };

export function PluginsPanel({ page, onOpenBrowse, onOpenModelGroups, onMessage }: {
  page: "plugins" | "plugins-install";
  onOpenBrowse: () => void;
  onOpenModelGroups: () => void;
  onMessage: (message: string, tone?: "success" | "error") => void;
}) {
  const [snapshot, setSnapshot] = useState<PluginSnapshot | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<Confirm | undefined>();
  const [installOpen, setInstallOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [results, setResults] = useState<PluginCatalogItem[] | undefined>();
  const [searching, setSearching] = useState(false);

  const fail = (error: unknown) => onMessage(error instanceof Error ? error.message : "操作失败", "error");

  useEffect(() => {
    void api.plugins().then(setSnapshot).catch((error: unknown) => onMessage(error instanceof Error ? error.message : "操作失败", "error"));
  }, [onMessage]);

  useEffect(() => {
    if (page !== "plugins-install") return;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void api.searchPlugins(query).then(setResults).catch(fail).finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [page, query]);

  const run = async (key: string, action: () => Promise<PluginSnapshot>) => {
    setBusy(key);
    try {
      setSnapshot(await action());
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
      setConfirm(undefined);
    }
  };

  const submitSource = (event: FormEvent) => {
    event.preventDefault();
    const value = source.trim();
    if (value === "") return;
    setInstallOpen(false);
    void run(`install:${value}`, () => api.installPlugin(value));
  };

  if (page === "plugins-install") {
    return <div className="settings-stack">
      <SettingsFormSection>
        <label className="settings-form-field"><span>搜索</span><input value={query} placeholder="包名" onChange={(event) => setQuery(event.target.value)} /></label>
      </SettingsFormSection>
      {searching && results === undefined ? <SettingsRow label="搜索中…" /> : null}
      {results?.length === 0 ? <SettingsEmpty icon={Puzzle} title="无结果" /> : null}
      <div className="plugin-market">
        {results?.map((item) => <article key={item.name} className="plugin-card">
          <div className="plugin-card-head"><strong>{item.name}</strong><span>{item.version}</span></div>
          {item.description === "" ? null : <p className="plugin-card-desc">{item.description}</p>}
          <a className="plugin-card-link" href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
          <div className="plugin-card-actions">{item.installed ? <span className="plugin-card-state">已安装</span> : <Button size="sm" variant="secondary" disabled={busy !== undefined} onClick={() => setConfirm({ kind: "install", source: item.source, label: item.name })}>安装</Button>}</div>
        </article>)}
      </div>
      <ConfirmDialog confirm={confirm} busy={busy !== undefined} onCancel={() => setConfirm(undefined)} onConfirm={() => { if (confirm?.kind === "install") void run(`install:${confirm.source}`, () => api.installPlugin(confirm.source)); }} />
    </div>;
  }

  return <div className="settings-stack">
    <SettingsGroup>
      <SettingsRow label="安装" onClick={() => { setSource(""); setInstallOpen(true); }} />
      <SettingsRow label="浏览" chevron onClick={onOpenBrowse} />
    </SettingsGroup>
    <SettingsGroup title="自带">
      {snapshot === undefined ? <SettingsRow label="读取中…" /> : snapshot.bundled.map((plugin) => <div key={plugin.id} className="settings-row">
        <span className="settings-row-main">
          <strong>{plugin.label}</strong>
          {plugin.modified ? <small className="settings-plugin-note">插件已修改</small> : null}
        </span>
        <span className="settings-row-actions">
          {plugin.id === "model-groups-router" && plugin.enabled ? <Button size="sm" variant="secondary" disabled={busy !== undefined} onClick={onOpenModelGroups}><Settings2 size={14} />配置</Button> : null}
          {plugin.modified ? <Button size="sm" variant="secondary" disabled={busy !== undefined} onClick={() => setConfirm({ kind: "overwrite", id: plugin.id, label: plugin.label })}>还原</Button> : null}
          <SettingsSwitch checked={plugin.enabled} disabled={busy !== undefined} label={plugin.label} onChange={(enabled) => {
            if (!enabled && plugin.modified) setConfirm({ kind: "disable-modified", id: plugin.id, label: plugin.label });
            else void run(plugin.id, () => api.setBundledPlugin(plugin.id, enabled));
          }} />
        </span>
      </div>)}
    </SettingsGroup>
    <SettingsGroup title="推荐">
      {snapshot?.recommended.map((plugin) => <SettingsRow key={plugin.name} label={plugin.name} value={plugin.installed ? snapshot.installed.find((item) => item.name === plugin.name)?.version : "未安装"} control={<SettingsSwitch checked={plugin.enabled} disabled={busy !== undefined} label={plugin.name} onChange={(enabled) => {
        if (!enabled && plugin.installed) setConfirm({ kind: "remove", source: plugin.source, label: plugin.name });
        else void run(plugin.name, () => api.setRecommendedPlugin(plugin.name, enabled));
      }} />} />)}
    </SettingsGroup>
    <SettingsGroup title="已安装">
      {snapshot !== undefined && snapshot.installed.length === 0 ? <SettingsEmpty icon={Puzzle} title="未安装" /> : null}
      {snapshot?.installed.map((plugin) => <SettingsRow key={plugin.source} label={plugin.name} value={plugin.version} control={<span className="settings-row-actions"><Button size="sm" variant="secondary" disabled={busy !== undefined} onClick={() => { void run(`update:${plugin.source}`, () => api.updatePlugin(plugin.source)); }}>更新</Button><Button size="sm" variant="danger" disabled={busy !== undefined} onClick={() => setConfirm({ kind: "remove", source: plugin.source, label: plugin.name })}>卸载</Button></span>} />)}
    </SettingsGroup>
    <Dialog open={installOpen} onOpenChange={setInstallOpen}>
      <DialogContent title="安装">
        <form className="settings-form" onSubmit={submitSource}>
          <label className="settings-form-field"><span>地址</span><input autoFocus value={source} placeholder="npm:包名 或 https://github.com/用户/仓库" onChange={(event) => setSource(event.target.value)} /></label>
          <div className="dialog-actions"><Button variant="secondary" type="button" onClick={() => setInstallOpen(false)}>取消</Button><Button type="submit" disabled={source.trim() === ""}>安装</Button></div>
        </form>
      </DialogContent>
    </Dialog>
    <ConfirmDialog confirm={confirm} busy={busy !== undefined} onCancel={() => { if (busy === undefined) setConfirm(undefined); }} onConfirm={() => {
      if (confirm?.kind === "overwrite") void run(confirm.id, () => api.overwriteBundledPlugin(confirm.id));
      if (confirm?.kind === "disable-modified") void run(confirm.id, () => api.setBundledPlugin(confirm.id, false));
      if (confirm?.kind === "remove") {
        const recommended = snapshot?.recommended.find((item) => item.source === confirm.source || item.name === confirm.label);
        void run(confirm.source, () => recommended !== undefined && confirm.label === recommended.name ? api.setRecommendedPlugin(recommended.name, false) : api.removePlugin(confirm.source));
      }
    }} />
  </div>;
}

function ConfirmDialog({ confirm, busy, onCancel, onConfirm }: { confirm: Confirm | undefined; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const copy = confirm === undefined ? "" : confirm.kind === "overwrite"
    ? "的修改将被自带版本替换，不可恢复。"
    : confirm.kind === "disable-modified"
      ? "的修改将被删除，不可恢复。"
      : confirm.kind === "install"
        ? "将写入 Pi 配置，并随会话加载。"
        : "将从配置目录移除。";
  return <Dialog open={confirm !== undefined} onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent title={confirm?.kind === "install" ? "安装" : confirm?.kind === "overwrite" ? "还原" : confirm?.kind === "disable-modified" ? "关闭" : "卸载"}>
      <p className="delete-session-message">{confirm === undefined ? "" : confirm.kind === "install" ? <>将安装 <strong>{confirm.label}</strong>，并写入 Pi 配置。</> : <><strong>{confirm.label}</strong>{copy}</>}</p>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>取消</Button>
        <Button variant={confirm?.kind === "remove" || confirm?.kind === "disable-modified" ? "danger" : "default"} onClick={onConfirm} disabled={busy}>{busy ? "处理中…" : "确认"}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

