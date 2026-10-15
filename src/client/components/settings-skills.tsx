import { FolderPlus, Library } from "lucide-react";
import { useEffect, useState } from "react";
import type { DirectoryListing } from "../../shared/protocol";
import type { SkillEntry, SkillFileContent, SkillFileListing, SkillSnapshot } from "../../shared/skills";
import { api } from "../api";
import { previewKindForPath } from "../lib/file-preview";
import { CodePreview } from "./code-preview";
import { MarkdownMessage } from "./markdown-message";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { SettingsEmpty, SettingsGroup, SettingsRow, SettingsSwitch } from "./settings-ui";

type Confirm =
  | { kind: "overwrite"; id: string; label: string }
  | { kind: "disable"; id: string; label: string }
  | { kind: "delete"; id: string; label: string };

export function SkillsPanel({ page, skillId, onOpenFiles, onMessage }: {
  page: "skills" | "skill-files";
  skillId?: string;
  onOpenFiles: (id: string) => void;
  onMessage: (message: string, tone?: "success" | "error") => void;
}) {
  const [snapshot, setSnapshot] = useState<SkillSnapshot | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<Confirm | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);

  const fail = (error: unknown) => onMessage(error instanceof Error ? error.message : "操作失败", "error");

  useEffect(() => {
    void api.skills().then(setSnapshot).catch(fail);
  }, []);

  const run = async (key: string, action: () => Promise<SkillSnapshot>, notice?: string) => {
    setBusy(key);
    try {
      setSnapshot(await action());
      if (notice !== undefined) onMessage(notice);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
      setConfirm(undefined);
    }
  };

  if (page === "skill-files" && skillId !== undefined) {
    return <SkillFiles skillId={skillId} onMessage={onMessage} />;
  }

  const installed = snapshot?.installed ?? [];
  const groups: Array<{ title: string; entries: SkillEntry[] }> = [
    { title: "用户", entries: installed.filter((item) => item.origin === "user") },
    { title: "包", entries: installed.filter((item) => item.origin === "package") },
    { title: "项目", entries: installed.filter((item) => item.origin === "project") },
  ];

  return <div className="settings-stack">
    <SettingsGroup title="自带">
      {snapshot === undefined ? <SettingsRow label="读取中…" /> : snapshot.bundled.map((skill) => <div key={skill.id} className="settings-row">
        <button type="button" className="settings-row-main-button" onClick={() => onOpenFiles(skill.id)}>
          <strong>{skill.label}</strong>
          {skill.modified ? <small className="settings-plugin-note">已修改</small> : skill.description === undefined ? null : <small>{skill.description}</small>}
        </button>
        <span className="settings-row-actions">
          {skill.modified && skill.enabled ? <Button size="sm" variant="secondary" disabled={busy !== undefined} onClick={() => setConfirm({ kind: "overwrite", id: skill.id, label: skill.label })}>覆盖</Button> : null}
          <SettingsSwitch checked={skill.enabled} disabled={busy !== undefined} label={skill.label} onChange={(enabled) => {
            if (!enabled && skill.modified) setConfirm({ kind: "disable", id: skill.id, label: skill.label });
            else void run(skill.id, () => api.setBundledSkill(skill.id, enabled), "新开会话后生效");
          }} />
        </span>
      </div>)}
    </SettingsGroup>
    {groups.map((group) => group.entries.length === 0 ? null : <SettingsGroup key={group.title} title={group.title}>
      {group.entries.map((skill) => <div key={skill.id} className="settings-row">
        <button type="button" className="settings-row-main-button" onClick={() => onOpenFiles(skill.id)}>
          <strong>{skill.name}</strong>
          {skill.description === undefined ? null : <small>{skill.description}</small>}
        </button>
        <span className="settings-row-actions">
          {rowValue(skill) === undefined ? null : <span className="settings-row-value">{rowValue(skill)}</span>}
          {skill.canDelete ? <Button size="sm" variant="danger" disabled={busy !== undefined} onClick={() => setConfirm({ kind: "delete", id: skill.id, label: skill.name })}>删除</Button> : null}
        </span>
      </div>)}
    </SettingsGroup>)}
    <SettingsGroup>
      <SettingsRow icon={FolderPlus} label="添加" chevron onClick={() => setPickerOpen(true)} />
    </SettingsGroup>
    {snapshot !== undefined && snapshot.bundled.length === 0 && installed.length === 0 ? <SettingsEmpty icon={Library} title="没有技能" /> : null}
    <SkillDirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} busy={busy === "import"} onAdd={(path) => { setPickerOpen(false); void run("import", () => api.importSkill(path), "新开会话后生效"); }} />
    <Dialog open={confirm !== undefined} onOpenChange={(open) => { if (!open && busy === undefined) setConfirm(undefined); }}>
      <DialogContent title={confirm?.kind === "overwrite" ? "覆盖" : confirm?.kind === "disable" ? "关闭" : "删除"}>
        <p className="delete-session-message">{confirm === undefined ? "" : confirm.kind === "overwrite" ? <><strong>{confirm.label}</strong>的修改将被自带版本替换，不可恢复。</> : confirm.kind === "disable" ? <><strong>{confirm.label}</strong>将停止加载，修改会保留。</> : <><strong>{confirm.label}</strong>及其全部内容将被永久删除。</>}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirm(undefined)} disabled={busy !== undefined}>取消</Button>
          <Button variant={confirm?.kind === "overwrite" ? "default" : "danger"} disabled={busy !== undefined} onClick={() => {
            if (confirm?.kind === "overwrite") void run(confirm.id, () => api.overwriteBundledSkill(confirm.id), "新开会话后生效");
            if (confirm?.kind === "disable") void run(confirm.id, () => api.setBundledSkill(confirm.id, false), "新开会话后生效");
            if (confirm?.kind === "delete") void run(confirm.id, () => api.removeSkill(confirm.id), "新开会话后生效");
          }}>{busy !== undefined ? "处理中…" : "确认"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

function rowValue(skill: SkillEntry): string | undefined {
  if (!skill.loaded) return "未加载";
  if (skill.manualOnly) return "手动";
  return skill.source;
}

function SkillFiles({ skillId, onMessage }: { skillId: string; onMessage: (message: string, tone?: "success" | "error") => void }) {
  const [listing, setListing] = useState<SkillFileListing | undefined>();
  const [relative, setRelative] = useState("");
  const [preview, setPreview] = useState<SkillFileContent | undefined>();
  const [previewKind, setPreviewKind] = useState<string | undefined>();

  const open = (path: string) => {
    setRelative(path);
    setPreview(undefined);
    setPreviewKind(undefined);
    void api.skillFiles(skillId, path).then(setListing).catch((error: unknown) => onMessage(error instanceof Error ? error.message : "操作失败", "error"));
  };

  useEffect(() => { open(""); }, [skillId]);

  const openFile = (path: string) => {
    const kind = previewKindForPath(path);
    setPreviewKind(kind);
    setPreview(undefined);
    if (kind !== "text" && kind !== "markdown" && kind !== "table") return;
    void api.skillFile(skillId, path).then(setPreview).catch((error: unknown) => onMessage(error instanceof Error ? error.message : "操作失败", "error"));
  };

  return <div className="settings-stack">
    {listing === undefined ? <SettingsRow label="读取中…" /> : <SettingsGroup>
      {listing.parent === undefined ? null : <SettingsRow label="上一级" chevron onClick={() => open(listing.parent ?? "")} />}
      {listing.entries.map((entry) => <SettingsRow key={entry.path} label={entry.name} chevron={entry.kind === "directory"} onClick={() => { if (entry.kind === "directory") open(entry.path); else openFile(entry.path); }} />)}
      {listing.entries.length === 0 ? <SettingsEmpty icon={Library} title="没有文件" /> : null}
    </SettingsGroup>}
    {previewKind !== undefined && previewKind !== "text" && previewKind !== "markdown" && previewKind !== "table" ? <p className="settings-page-note">无法预览</p> : null}
    {preview === undefined ? null : <div className="skill-file-preview">
      {previewKind === "markdown" ? <MarkdownMessage text={preview.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")} /> : <CodePreview text={preview.content} path={preview.name} className="skill-file-code" lineClassName="skill-file-line" />}
    </div>}
  </div>;
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
