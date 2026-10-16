import { ChevronRight, FileText, Folder, FolderPlus, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DirectoryListing } from "../../shared/protocol";
import type { PluginCatalogItem, PluginSnapshot } from "../../shared/plugins";
import type { SkillEntry, SkillFileContent, SkillFileListing, SkillSnapshot } from "../../shared/skills";
import { api } from "../api";
import { previewKindForPath } from "../lib/file-preview";
import { CodePreview } from "./code-preview";
import { MarkdownMessage } from "./markdown-message";
import { SaveState, SettingsConfirm, useSaveStatus, useSettingsToast } from "./settings-feedback";
import { SectionAction, SettingRow, SettingsCard, SettingsEmptyLine, SettingsLoading, SettingsPageHead, SettingsSection, SettingsSwitch, SettingsTag, StButton } from "./settings-ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

/** 自带插件、推荐插件的一句话说明（接口只给名字）。 */
export const PLUGIN_DESCRIPTIONS: Record<string, string> = {
  "model-groups-router": "按模型组在多个供应商之间路由，失败自动换下一条",
  "session-board": "会话之间可以互相发消息、交接任务",
  "pi-web-access": "联网搜索与网页读取",
  "@juicesharp/rpiv-ask-user-question": "让 AI 用选项卡片向你提问",
  "@mjakl/pi-subagent": "子代理：把任务分给独立上下文执行",
  "pi-playwright": "浏览器自动化（Playwright）",
};

export type ExtensionsTab = "plugins" | "skills";

/** 导航摘要：启用的插件数 · 启用的技能数。 */
export function extensionsSummary(plugins: PluginSnapshot | undefined, skills: SkillSnapshot | undefined): string | undefined {
  if (plugins === undefined && skills === undefined) return undefined;
  const parts: string[] = [];
  if (plugins !== undefined) {
    const recommendedNames = new Set(plugins.recommended.map((item) => item.name));
    const others = plugins.installed.filter((item) => !recommendedNames.has(item.name)).length;
    parts.push(`${String(plugins.bundled.filter((item) => item.enabled).length + plugins.recommended.filter((item) => item.installed && item.enabled).length + others)} 插件`);
  }
  if (skills !== undefined) parts.push(`${String(skills.bundled.filter((item) => item.enabled).length + skills.installed.length)} 技能`);
  return parts.join(" · ");
}

type Confirm =
  | { kind: "plugin-overwrite"; id: string; label: string }
  | { kind: "plugin-disable-modified"; id: string; label: string }
  | { kind: "skill-overwrite"; id: string; label: string }
  | { kind: "skill-disable-modified"; id: string; label: string };

export function ExtensionsPage({ tab, onTab, plugins, onPlugins, skills, onSkills, openInstall, onOpenModelGroups, onOpenSkillFiles }: {
  tab: ExtensionsTab;
  onTab: (tab: ExtensionsTab) => void;
  plugins?: PluginSnapshot;
  onPlugins: (snapshot: PluginSnapshot) => void;
  skills?: SkillSnapshot;
  onSkills: (snapshot: SkillSnapshot) => void;
  openInstall?: boolean;
  onOpenModelGroups: () => void;
  onOpenSkillFiles: (id: string) => void;
}) {
  const toast = useSettingsToast();
  const saveStatus = useSaveStatus();
  const [confirm, setConfirm] = useState<Confirm>();
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [installOpen, setInstallOpen] = useState(openInstall === true);
  const [hiddenPlugins, setHiddenPlugins] = useState<Set<string>>(new Set());
  const [hiddenSkills, setHiddenSkills] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { if (openInstall === true) setInstallOpen(true); }, [openInstall]);

  const fail = (error: unknown, fallback = "操作失败") => toast.notify(error instanceof Error ? error.message : fallback, "error");
  const runPlugin = async (key: string, action: () => Promise<PluginSnapshot>, notice?: string) => {
    setBusy(key);
    try {
      onPlugins(await action());
      if (notice !== undefined) toast.notify(notice);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };
  const runSkill = async (key: string, action: () => Promise<SkillSnapshot>, notice?: string) => {
    setBusy(key);
    try {
      onSkills(await action());
      if (notice !== undefined) toast.notify(notice);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };
  const hide = (setter: typeof setHiddenPlugins, key: string, hidden: boolean) => setter((current) => {
    const next = new Set(current);
    if (hidden) next.add(key); else next.delete(key);
    return next;
  });

  const toggleBundledPlugin = (id: string, enabled: boolean) => {
    if (plugins === undefined) return;
    const previous = plugins;
    onPlugins({ ...plugins, bundled: plugins.bundled.map((item) => item.id === id ? { ...item, enabled } : item) });
    void saveStatus.run(`plugin:${id}`, async () => { onPlugins(await api.setBundledPlugin(id, enabled)); }, { rollback: () => onPlugins(previous) });
  };
  const uninstall = (key: string, label: string, commit: () => Promise<PluginSnapshot>) => {
    hide(setHiddenPlugins, key, true);
    toast.showUndo({
      message: `已卸载 ${label}，新开会话生效`,
      undo: () => hide(setHiddenPlugins, key, false),
      commit: async () => { onPlugins(await commit()); hide(setHiddenPlugins, key, false); },
      onCommitError: (error) => { hide(setHiddenPlugins, key, false); fail(error, "卸载失败"); },
    });
  };
  const toggleBundledSkill = (id: string, enabled: boolean) => {
    if (skills === undefined) return;
    const previous = skills;
    onSkills({ ...skills, bundled: skills.bundled.map((item) => item.id === id ? { ...item, enabled } : item) });
    void saveStatus.run(`skill:${id}`, async () => { onSkills(await api.setBundledSkill(id, enabled)); }, { rollback: () => onSkills(previous) });
  };
  const deleteSkill = (skill: SkillEntry) => {
    hide(setHiddenSkills, skill.id, true);
    toast.showUndo({
      message: `已删除技能 ${skill.label || skill.name}（会移进回收站）`,
      undo: () => hide(setHiddenSkills, skill.id, false),
      commit: async () => { onSkills(await api.removeSkill(skill.id)); hide(setHiddenSkills, skill.id, false); },
      onCommitError: (error) => { hide(setHiddenSkills, skill.id, false); fail(error, "删除失败"); },
    });
  };
  const runConfirm = async () => {
    if (confirm === undefined) return;
    setConfirmBusy(true);
    try {
      if (confirm.kind === "plugin-overwrite") onPlugins(await api.overwriteBundledPlugin(confirm.id));
      if (confirm.kind === "plugin-disable-modified") onPlugins(await api.setBundledPlugin(confirm.id, false));
      if (confirm.kind === "skill-overwrite") onSkills(await api.overwriteBundledSkill(confirm.id));
      if (confirm.kind === "skill-disable-modified") onSkills(await api.setBundledSkill(confirm.id, false));
      toast.notify("已完成，新开会话生效");
      setConfirm(undefined);
    } catch (error) {
      fail(error);
    } finally {
      setConfirmBusy(false);
    }
  };

  const recommendedNames = new Set(plugins?.recommended.map((item) => item.name) ?? []);
  const others = plugins?.installed.filter((item) => !recommendedNames.has(item.name) && !hiddenPlugins.has(item.source)) ?? [];

  return <>
    <SettingsPageHead title="插件与技能" description="扩展 AI 能做的事。开关从下一次新开的会话开始生效。" />
    <div className="st-tabs" role="tablist" aria-label="插件与技能">
      <button type="button" role="tab" aria-selected={tab === "plugins"} className={tab === "plugins" ? "on" : undefined} onClick={() => onTab("plugins")}>插件</button>
      <button type="button" role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "on" : undefined} onClick={() => onTab("skills")}>技能</button>
    </div>
    {tab === "plugins" ? <>
      <SettingsSection id="bundled-plugins" title="自带">
        {plugins === undefined ? <SettingsLoading /> : <SettingsCard>
          {plugins.bundled.map((plugin) => <SettingRow key={plugin.id} id={`plugin-${plugin.id}`} title={plugin.label} description={PLUGIN_DESCRIPTIONS[plugin.id]}
            control={<>
              {plugin.modified ? <SettingsTag tone="warn" title="插件文件被改过">已修改</SettingsTag> : null}
              {plugin.modified ? <StButton variant="ghost" onClick={() => setConfirm({ kind: "plugin-overwrite", id: plugin.id, label: plugin.label })}>还原</StButton> : null}
              {plugin.id === "model-groups-router" ? <StButton variant="ghost" onClick={onOpenModelGroups}>配置模型组<ChevronRight size={13} /></StButton> : null}
              <SaveState k={`plugin:${plugin.id}`} />
              <SettingsSwitch checked={plugin.enabled} label={plugin.label} onChange={(enabled) => {
                if (!enabled && plugin.modified) setConfirm({ kind: "plugin-disable-modified", id: plugin.id, label: plugin.label });
                else toggleBundledPlugin(plugin.id, enabled);
              }} />
            </>} />)}
        </SettingsCard>}
      </SettingsSection>
      <SettingsSection id="recommended-plugins" title="推荐" hint="从 npm 安装，写入 Pi 配置">
        {plugins === undefined ? <SettingsLoading /> : <SettingsCard>
          {plugins.recommended.map((plugin) => {
            const installed = plugin.installed && !hiddenPlugins.has(plugin.source);
            const version = plugins.installed.find((item) => item.name === plugin.name)?.version;
            return <SettingRow key={plugin.name} id={`plugin-${plugin.name}`} title={<span className="mono">{plugin.name}</span>} description={[PLUGIN_DESCRIPTIONS[plugin.name], installed && version !== undefined ? `v${version}` : undefined].filter(Boolean).join(" · ")}
              control={busy === `install:${plugin.name}` ? <SettingsTag tone="acc">安装中…</SettingsTag> : installed ? <>
                <SettingsTag>新会话生效</SettingsTag>
                <SettingsSwitch checked label={plugin.name} onChange={() => uninstall(plugin.source, plugin.name, () => api.setRecommendedPlugin(plugin.name, false))} />
              </> : <StButton disabled={busy !== undefined} onClick={() => { void runPlugin(`install:${plugin.name}`, () => api.setRecommendedPlugin(plugin.name, true), `已安装 ${plugin.name}，新开会话生效`); }}>安装</StButton>} />;
          })}
        </SettingsCard>}
      </SettingsSection>
      <SettingsSection id="installed-plugins" title="其他已安装" action={<SectionAction label="安装插件" onClick={() => setInstallOpen(true)} />}>
        {plugins === undefined ? <SettingsLoading /> : <SettingsCard>
          {others.length === 0 ? <SettingsEmptyLine>还没有手动安装的插件。可以搜索 npm，或者填 npm:包名 / GitHub 地址安装。</SettingsEmptyLine> : others.map((plugin) => <SettingRow key={plugin.source} id={`plugin-${plugin.name}`} title={<span className="mono">{plugin.name}</span>} description={[plugin.version === undefined ? undefined : `v${plugin.version}`, plugin.source === plugin.name ? undefined : plugin.source].filter(Boolean).join(" · ")}
            control={<>
              <StButton variant="ghost" disabled={busy !== undefined} onClick={() => { void runPlugin(`update:${plugin.source}`, () => api.updatePlugin(plugin.source), `${plugin.name} 已更新`); }}><RefreshCw size={13} className={busy === `update:${plugin.source}` ? "spin" : undefined} />更新</StButton>
              <StButton variant="ghost" className="danger" onClick={() => uninstall(plugin.source, plugin.name, () => api.removePlugin(plugin.source))}><Trash2 size={13} />卸载</StButton>
            </>} />)}
        </SettingsCard>}
      </SettingsSection>
    </> : <>
      <SettingsSection id="bundled-skills" title="自带">
        {skills === undefined ? <SettingsLoading /> : <SettingsCard>
          {skills.bundled.length === 0 ? <SettingsEmptyLine>没有自带技能</SettingsEmptyLine> : skills.bundled.map((skill) => <SettingRow key={skill.id} id={`skill-${skill.id}`} title={<>{skill.label}<span className="st-sub-id">{skill.id}</span></>} description={skill.description}
            onClick={() => onOpenSkillFiles(skill.id)}
            control={<>
              {skill.modified ? <SettingsTag tone="warn">已修改</SettingsTag> : null}
              {skill.modified && skill.enabled ? <StButton variant="ghost" onClick={() => setConfirm({ kind: "skill-overwrite", id: skill.id, label: skill.label })}>还原</StButton> : null}
              <SaveState k={`skill:${skill.id}`} />
              <SettingsTag>新会话生效</SettingsTag>
              <SettingsSwitch checked={skill.enabled} label={skill.label} onChange={(enabled) => {
                if (!enabled && skill.modified) setConfirm({ kind: "skill-disable-modified", id: skill.id, label: skill.label });
                else toggleBundledSkill(skill.id, enabled);
              }} />
            </>} />)}
        </SettingsCard>}
      </SettingsSection>
      {skills === undefined ? null : (["user", "project", "package"] as const).map((origin) => {
        const entries = skills.installed.filter((item) => item.origin === origin && !hiddenSkills.has(item.id));
        if (entries.length === 0 && origin !== "user") return null;
        return <SettingsSection key={origin} id={`skills-${origin}`} title={origin === "user" ? "用户" : origin === "project" ? "项目" : "包"} hint={origin === "project" ? "来自当前工作区" : origin === "package" ? "随插件包安装" : undefined}
          action={origin === "user" ? <SectionAction label="添加技能文件夹" icon={FolderPlus} onClick={() => setPickerOpen(true)} /> : undefined}>
          <SettingsCard>
            {entries.length === 0 ? <SettingsEmptyLine>还没有自己添加的技能。选一个包含 SKILL.md 的文件夹即可添加。</SettingsEmptyLine> : entries.map((skill) => <SettingRow key={skill.id} id={`skill-${skill.id}`} title={skill.label || skill.name} description={skill.description}
              onClick={() => onOpenSkillFiles(skill.id)}
              control={<>
                {!skill.loaded ? <SettingsTag tone="warn">未加载</SettingsTag> : skill.manualOnly ? <SettingsTag>手动</SettingsTag> : skill.source === undefined ? null : <SettingsTag>{skill.source}</SettingsTag>}
                {skill.canDelete ? <StButton variant="ghost" icon aria-label={`删除 ${skill.name}`} title="删除（移进回收站）" onClick={() => deleteSkill(skill)}><Trash2 size={14} /></StButton> : null}
              </>} />)}
          </SettingsCard>
        </SettingsSection>;
      })}
      {skills !== undefined && skills.diagnostics.length > 0 ? <SettingsSection title="加载问题">
        <SettingsCard>{skills.diagnostics.map((item, index) => <SettingRow key={index} title={item.message} description={item.path} mono />)}</SettingsCard>
      </SettingsSection> : null}
    </>}
    <PluginInstallDialog open={installOpen} onOpenChange={setInstallOpen} busy={busy} onInstall={(source, label) => { setInstallOpen(false); void runPlugin(`install:${source}`, () => api.installPlugin(source), `已安装 ${label}，新开会话生效`); }} />
    <SkillDirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} busy={busy === "import"} onAdd={(path) => { setPickerOpen(false); void runSkill("import", () => api.importSkill(path), "技能已添加，新开会话生效"); }} />
    <SettingsConfirm open={confirm !== undefined} busy={confirmBusy} danger={confirm?.kind.endsWith("disable-modified")}
      title={confirm?.kind.endsWith("overwrite") === true ? "还原成自带版本？" : "关闭被修改过的自带项？"}
      confirmLabel={confirm?.kind.endsWith("overwrite") === true ? "还原" : "关闭"}
      onCancel={() => setConfirm(undefined)} onConfirm={() => { void runConfirm(); }}>
      {confirm === undefined ? null : confirm.kind === "plugin-overwrite" || confirm.kind === "skill-overwrite"
        ? <p><b>{confirm.label}</b> 被修改过。还原会用自带版本覆盖你的修改，<b>不能撤销</b>。</p>
        : confirm.kind === "plugin-disable-modified" ? <p><b>{confirm.label}</b> 被修改过。关闭会删除你的修改，<b>不能撤销</b>。</p>
          : <p><b>{confirm.label}</b> 被修改过。关闭后停止加载，修改会保留。</p>}
    </SettingsConfirm>
  </>;
}

/** 安装插件：搜索 npm 和按地址安装合在一个对话框里。 */
function PluginInstallDialog({ open, onOpenChange, busy, onInstall }: { open: boolean; onOpenChange: (open: boolean) => void; busy?: string; onInstall: (source: string, label: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PluginCatalogItem[]>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const trimmed = query.trim();
  const looksLikeSource = /^(npm:|git:|github:|https?:\/\/|git@|\.{0,2}\/|[A-Za-z]:\\)/u.test(trimmed);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setError(undefined);
      void api.searchPlugins(looksLikeSource ? "" : trimmed).then(setResults).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "搜索失败")).finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, trimmed, looksLikeSource]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="安装插件" className="st-install-dialog">
      <div className="st-search-row boxed"><Search size={14} /><input autoFocus value={query} placeholder="搜索 npm，或粘贴 npm:包名 / GitHub 地址" aria-label="搜索或填写地址" onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && trimmed !== "") { event.preventDefault(); onInstall(trimmed, trimmed); } }} /></div>
      {trimmed === "" ? null : <button type="button" className="st-install-source" disabled={busy !== undefined} onClick={() => onInstall(trimmed, trimmed)}><Plus size={14} />按地址安装 <span className="mono">{trimmed}</span></button>}
      <div className="st-install-results">
        {error === undefined ? null : <SettingsEmptyLine><span className="st-err-text">{error}</span></SettingsEmptyLine>}
        {searching && results === undefined ? <SettingsLoading label="搜索中…" /> : null}
        {results?.length === 0 ? <SettingsEmptyLine>没有找到相关插件</SettingsEmptyLine> : null}
        {results?.map((item) => <div key={item.name} className="st-install-item">
          <div><b className="mono">{item.name}</b><small>v{item.version}</small>{item.description === "" ? null : <p>{item.description}</p>}<a href={item.url} target="_blank" rel="noreferrer">{item.url}</a></div>
          {item.installed ? <SettingsTag tone="ok">已安装</SettingsTag> : <StButton disabled={busy !== undefined} onClick={() => onInstall(item.source, item.name)}>安装</StButton>}
        </div>)}
      </div>
    </DialogContent>
  </Dialog>;
}

/** 技能文件浏览（只读）。 */
export function SkillFilesPage({ skillId, label, onBack }: { skillId: string; label?: string; onBack: () => void }) {
  const toast = useSettingsToast();
  const [listing, setListing] = useState<SkillFileListing | undefined>();
  const [preview, setPreview] = useState<SkillFileContent | undefined>();
  const [previewKind, setPreviewKind] = useState<string | undefined>();
  const [selected, setSelected] = useState<string>();

  const open = (path: string) => {
    setPreview(undefined);
    setPreviewKind(undefined);
    setSelected(undefined);
    void api.skillFiles(skillId, path).then(setListing).catch((error: unknown) => toast.notify(error instanceof Error ? error.message : "读取失败", "error"));
  };
  useEffect(() => { open(""); }, [skillId]);
  const openFile = (path: string) => {
    const kind = previewKindForPath(path);
    setSelected(path);
    setPreviewKind(kind);
    setPreview(undefined);
    if (kind !== "text" && kind !== "markdown" && kind !== "table") return;
    void api.skillFile(skillId, path).then(setPreview).catch((error: unknown) => toast.notify(error instanceof Error ? error.message : "读取失败", "error"));
  };
  const sorted = useMemo(() => listing === undefined ? [] : [...listing.entries].sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1), [listing]);

  return <>
    <SettingsPageHead crumb={{ label: "插件与技能", onClick: onBack }} title={label ?? skillId} description={listing === undefined || listing.path === "" ? "技能文件（只读）" : listing.path} />
    <SettingsSection>
      {listing === undefined ? <SettingsLoading /> : <SettingsCard>
        {listing.parent === undefined ? null : <SettingRow leading={<Folder size={15} className="st-row-glyph" />} title="上一级" onClick={() => open(listing.parent ?? "")} />}
        {sorted.map((entry) => <SettingRow key={entry.path} className={entry.path === selected ? "selected" : undefined} leading={entry.kind === "directory" ? <Folder size={15} className="st-row-glyph" /> : <FileText size={15} className="st-row-glyph" />} title={entry.name}
          onClick={() => { if (entry.kind === "directory") open(entry.path); else openFile(entry.path); }} />)}
        {listing.entries.length === 0 ? <SettingsEmptyLine>没有文件</SettingsEmptyLine> : null}
      </SettingsCard>}
    </SettingsSection>
    {previewKind !== undefined && previewKind !== "text" && previewKind !== "markdown" && previewKind !== "table" ? <SettingsEmptyLine>这个文件不能预览</SettingsEmptyLine> : null}
    {preview === undefined ? null : <SettingsCard className="skill-file-preview">
      {previewKind === "markdown" ? <MarkdownMessage text={preview.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")} /> : <CodePreview text={preview.content} path={preview.name} className="skill-file-code" lineClassName="skill-file-line" />}
    </SettingsCard>}
  </>;
}

function SkillDirectoryPicker({ open, onOpenChange, busy, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; busy: boolean; onAdd: (path: string) => void }) {
  const [directory, setDirectory] = useState<DirectoryListing | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const browse = async (path?: string, roots = false) => {
    setPending(true);
    setError(undefined);
    try {
      setDirectory(await api.directory(path, roots));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法打开目录");
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setDirectory(undefined);
    setError(undefined);
    void browse(undefined, true);
  }, [open]);

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="选择文件夹" className="workspace-dialog">
      {error === undefined ? null : <div className="workspace-error" role="alert">{error}</div>}
      <section className="directory-browser">
        <div className="directory-location">
          {directory?.isRootPicker === true ? null : <Button variant="secondary" size="sm" onClick={() => { void browse(undefined, true); }} disabled={pending}>磁盘</Button>}
          {directory?.parent === undefined ? null : <Button variant="secondary" size="sm" onClick={() => { void browse(directory.parent); }} disabled={pending}>上一级</Button>}
          <span className="directory-path" title={directory?.path}>{directory?.isRootPicker === true ? "选择磁盘" : directory?.path ?? "正在打开目录…"}</span>
        </div>
        <div className="directory-list" aria-label="目录列表">
          {directory?.entries.map((entry) => <button type="button" className="directory-row" key={entry.path} onClick={() => { void browse(entry.path); }} disabled={pending}>
            <span>{entry.name}</span>
          </button>)}
          {directory !== undefined && directory.entries.length === 0 ? <p className="directory-empty">没有子目录</p> : null}
        </div>
        <footer className="directory-selection">
          <div><strong>{directory?.name}</strong>{directory?.isRootPicker === true ? null : <span>{directory?.path}</span>}</div>
          <Button onClick={() => { if (directory !== undefined && !directory.isRootPicker) onAdd(directory.path); }} disabled={directory === undefined || directory.isRootPicker || pending || busy}><FolderPlus size={16} /> 添加</Button>
        </footer>
      </section>
    </DialogContent>
  </Dialog>;
}
