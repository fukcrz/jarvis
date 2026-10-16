import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelGroup, ModelGroupRoute, ModelGroupsConfig, ModelGroupsSnapshot } from "../../shared/plugins";
import { api } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { SettingsEmpty, SettingsForm, SettingsFormSection, SettingsFormSwitch, SettingsGroup, SettingsRow, SettingsSubpage } from "./settings-ui";

type DeleteTarget = { kind: "group"; id: string } | { kind: "route"; index: number };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABELS: Record<ThinkingLevel, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };
const NULL_LEVEL = "__null__";
const CUSTOM_LEVEL = "__custom__";

const newGroup = (): ModelGroup => ({
  name: "新模型组",
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
  input: ["text"],
  routes: [{ provider: "", model: "" }],
});

export function ModelGroupsPanel({ onBack, onMessage }: { onBack: () => void; onMessage: (message: string, tone?: "success" | "error") => void }) {
  const [snapshot, setSnapshot] = useState<ModelGroupsSnapshot>();
  const [revision, setRevision] = useState<string>();
  const [config, setConfig] = useState<ModelGroupsConfig>();
  const [selectedId, setSelectedId] = useState<string>();
  const [draftId, setDraftId] = useState("");
  const [customLevels, setCustomLevels] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const configRef = useRef<ModelGroupsConfig | undefined>(undefined);

  const syncGroupDraft = (id: string | undefined) => {
    setDraftId(id ?? "");
    setCustomLevels({});
  };

  const load = async () => {
    try {
      const next = await api.modelGroups();
      setSnapshot(next);
      setRevision(next.revision);
      setConfig(next.config);
      configRef.current = next.config;
      const first = Object.keys(next.config.groups)[0];
      const nextId = selectedId !== undefined && next.config.groups[selectedId] !== undefined ? selectedId : first;
      setSelectedId(nextId);
      syncGroupDraft(nextId);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "读取失败", "error");
    }
  };

  useEffect(() => { void load(); }, []);

  const group = selectedId === undefined || config === undefined ? undefined : config.groups[selectedId];

  const groupEntries = useMemo(() => Object.entries(config?.groups ?? {}), [config]);
  const updateConfig = (updater: (current: ModelGroupsConfig) => ModelGroupsConfig) => setConfig((current) => {
    if (current === undefined) return current;
    const next = updater(current);
    configRef.current = next;
    return next;
  });
  const selectGroup = (id: string | undefined) => {
    setSelectedId(id);
    syncGroupDraft(id);
  };
  const updateGroup = (updater: (current: ModelGroup) => ModelGroup) => {
    if (selectedId === undefined) return;
    updateConfig((current) => ({ ...current, groups: { ...current.groups, [selectedId]: updater(current.groups[selectedId]!) } }));
  };
  const updateRoute = (index: number, updater: (current: ModelGroupRoute) => ModelGroupRoute) => updateGroup((current) => ({
    ...current,
    routes: current.routes.map((route, routeIndex) => routeIndex === index ? updater(route) : route),
  }));
  const updateThinkingLevel = (level: ThinkingLevel, value: string) => updateGroup((current) => {
    const next = { ...current.thinkingLevelMap };
    if (value === "" || value === CUSTOM_LEVEL) delete next[level];
    else next[level] = value === NULL_LEVEL ? null : value;
    const groupNext = { ...current };
    if (Object.keys(next).length === 0) delete groupNext.thinkingLevelMap;
    else groupNext.thinkingLevelMap = next;
    return groupNext;
  });

  const addGroup = () => {
    if (config === undefined) return;
    const base = "new-group";
    let id = base;
    let suffix = 2;
    while (config.groups[id] !== undefined) id = `${base}-${String(suffix++)}`;
    const nextConfig = { ...config, groups: { ...config.groups, [id]: newGroup() } };
    setConfig(nextConfig);
    configRef.current = nextConfig;
    selectGroup(id);
  };

  const addRoute = () => updateGroup((current) => ({ ...current, routes: [...current.routes, { provider: "", model: "" }] }));

  const removeGroup = () => {
    if (deleteTarget?.kind !== "group" || config === undefined) return;
    const remaining = Object.fromEntries(Object.entries(config.groups).filter(([id]) => id !== deleteTarget.id));
    const nextConfig = { ...config, groups: remaining };
    setConfig(nextConfig);
    configRef.current = nextConfig;
    selectGroup(Object.keys(remaining)[0]);
    setDeleteTarget(undefined);
  };

  const removeRoute = () => {
    if (deleteTarget?.kind !== "route") return;
    updateGroup((current) => ({ ...current, routes: current.routes.filter((_, index) => index !== deleteTarget.index) }));
    setDeleteTarget(undefined);
  };

  const save = async () => {
    if (config === undefined) return;
    if (selectedId === undefined || group === undefined) {
      setBusy(true);
      try {
        const next = await api.saveModelGroups(config, revision);
        setSnapshot(next);
        setRevision(next.revision);
        setConfig(next.config);
        configRef.current = next.config;
        onMessage("模型组已保存");
      } catch (error) {
        onMessage(error instanceof Error ? error.message : "保存失败", "error");
      } finally {
        setBusy(false);
      }
      return;
    }
    const nextId = draftId.trim();
    if (nextId === "") {
      onMessage("模型组 ID 不能为空", "error");
      return;
    }
    if (nextId !== selectedId && config.groups[nextId] !== undefined) {
      onMessage("模型组 ID 已存在", "error");
      return;
    }
    const nextGroup: ModelGroup = { ...group };
    if (nextGroup.thinkingLevelMap !== undefined && Object.keys(nextGroup.thinkingLevelMap).length === 0) delete nextGroup.thinkingLevelMap;
    const groups = { ...config.groups };
    delete groups[selectedId];
    groups[nextId] = nextGroup;
    const nextConfig = { ...config, groups };
    setBusy(true);
    try {
      const next = await api.saveModelGroups(nextConfig, revision);
      setSnapshot(next);
      setRevision(next.revision);
      setConfig(next.config);
      configRef.current = next.config;
      selectGroup(nextId);
      onMessage("模型组已保存");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  if (snapshot === undefined || config === undefined) {
    return <SettingsSubpage title="模型组" onBack={onBack}><p className="settings-page-note">读取中…</p></SettingsSubpage>;
  }
  if (!snapshot.enabled) {
    return <SettingsSubpage title="模型组" onBack={onBack}><p className="settings-page-note">插件未启用</p></SettingsSubpage>;
  }

  return <SettingsSubpage title="模型组" onBack={onBack} action={<Button size="sm" onClick={() => { void save(); }} disabled={busy}><Save size={14} />保存</Button>}>
    <div className="settings-stack model-groups-page">
      {snapshot.error === undefined ? null : <p className="settings-page-note settings-error-note">{snapshot.error}</p>}
      <SettingsGroup title="全局">
        <div className="model-groups-globals">
          <label className="settings-form-field"><span>重试等待 ms</span><input type="number" min="0" disabled={busy} value={config.retry?.groupRetryDelayMs ?? ""} onChange={(event) => updateConfig((current) => ({ ...current, retry: { ...current.retry, groupRetryDelayMs: optionalNumber(event.target.value, current.retry?.groupRetryDelayMs) } }))} /></label>
          <label className="settings-form-field"><span>压缩阈值 Token</span><input type="number" min="0" disabled={busy} value={config.compaction?.thresholdTokens ?? ""} onChange={(event) => updateConfig((current) => ({ ...current, compaction: { ...current.compaction, thresholdTokens: optionalNumber(event.target.value, current.compaction?.thresholdTokens) } }))} /></label>
          <label className="settings-form-field"><span>压缩预留 Token</span><input type="number" min="0" disabled={busy} value={config.compaction?.reserveTokens ?? ""} onChange={(event) => updateConfig((current) => ({ ...current, compaction: { ...current.compaction, reserveTokens: optionalNumber(event.target.value, current.compaction?.reserveTokens) } }))} /></label>
        </div>
      </SettingsGroup>
      <div className="model-groups-layout">
        <SettingsGroup title="模型组">
          {groupEntries.length === 0 ? <SettingsEmpty icon={Plus} title="暂无模型组" actionLabel="添加模型组" onAction={busy ? undefined : addGroup} /> : groupEntries.map(([id, item]) => <SettingsRow key={id} label={item.name || id} value={`${String(item.routes.length)} 条路由`} accent={id === selectedId} disabled={busy} onClick={() => selectGroup(id)} />)}
          {groupEntries.length > 0 ? <SettingsRow icon={Plus} label="添加" disabled={busy} onClick={addGroup} /> : null}
        </SettingsGroup>
        {group === undefined ? null : <SettingsForm>
          <SettingsFormSection>
            <div className="model-groups-fields">
              <label className="settings-form-field"><span>ID</span><input disabled={busy} value={draftId} onChange={(event) => setDraftId(event.target.value)} /></label>
              <label className="settings-form-field"><span>名称</span><input disabled={busy} value={group.name} onChange={(event) => updateGroup((current) => ({ ...current, name: event.target.value }))} /></label>
              <label className="settings-form-field"><span>上下文窗口</span><input type="number" min="0" disabled={busy} value={group.contextWindow} onChange={(event) => updateGroup((current) => ({ ...current, contextWindow: Number(event.target.value) }))} /></label>
              <label className="settings-form-field"><span>最大输出 Token</span><input type="number" min="0" disabled={busy} value={group.maxTokens} onChange={(event) => updateGroup((current) => ({ ...current, maxTokens: Number(event.target.value) }))} /></label>
              <SettingsFormSwitch label="思考" checked={group.reasoning} disabled={busy} onChange={(reasoning) => updateGroup((current) => ({ ...current, reasoning }))} />
              <div className="model-groups-inputs"><span>输入</span><label className="settings-checkbox"><input type="checkbox" disabled={busy} checked={group.input.includes("text")} onChange={(event) => updateGroup((current) => ({ ...current, input: toggleInput(current.input, "text", event.target.checked) }))} /><span>文本</span></label><label className="settings-checkbox"><input type="checkbox" disabled={busy} checked={group.input.includes("image")} onChange={(event) => updateGroup((current) => ({ ...current, input: toggleInput(current.input, "image", event.target.checked) }))} /><span>图片</span></label></div>
            </div>
          </SettingsFormSection>
          {group.reasoning ? <SettingsFormSection title="思考等级">
            <div className="model-groups-levels">{THINKING_LEVELS.map((level) => {
              const current = group.thinkingLevelMap?.[level];
              const custom = customLevels[level] === true || (typeof current === "string" && !THINKING_LEVELS.includes(current as ThinkingLevel));
              return <label className="settings-form-field" key={level}><span>{LEVEL_LABELS[level]}</span>{custom
                ? <input disabled={busy} value={typeof current === "string" ? current : ""} onChange={(event) => updateThinkingLevel(level, event.target.value)} />
                : <select disabled={busy} value={current === undefined ? "" : current === null ? NULL_LEVEL : current} onChange={(event) => {
                  if (event.target.value === CUSTOM_LEVEL) {
                    setCustomLevels((existing) => ({ ...existing, [level]: true }));
                    updateThinkingLevel(level, "");
                    return;
                  }
                  updateThinkingLevel(level, event.target.value);
                }}>
                  <option value="">默认</option>
                  <option value={NULL_LEVEL}>不支持</option>
                  {THINKING_LEVELS.map((option) => <option key={option} value={option}>{LEVEL_LABELS[option]}</option>)}
                  <option value={CUSTOM_LEVEL}>自定义</option>
                </select>}</label>;
            })}</div>
          </SettingsFormSection> : null}
          <SettingsFormSection title="路由" extra={<Button size="sm" variant="secondary" disabled={busy} onClick={addRoute}><Plus size={14} />添加</Button>}>
            <div className="model-groups-route-list">
              <div className="model-groups-route-head"><span>供应商</span><span>模型</span><span>并发</span><span /></div>
              {group.routes.map((route, index) => <div className="model-groups-route" key={index}>
                <label className="settings-form-field"><span>供应商</span><input disabled={busy} value={route.provider} onChange={(event) => updateRoute(index, (current) => ({ ...current, provider: event.target.value }))} /></label>
                <label className="settings-form-field"><span>模型</span><input disabled={busy} value={route.model} onChange={(event) => updateRoute(index, (current) => ({ ...current, model: event.target.value }))} /></label>
                <label className="settings-form-field"><span>并发</span><input type="number" min="0" disabled={busy} value={route.recommendedConcurrency ?? ""} onChange={(event) => updateRoute(index, (current) => ({ ...current, recommendedConcurrency: optionalNumber(event.target.value, current.recommendedConcurrency) }))} /></label>
                <Button size="icon" variant="ghost" aria-label="删除路由" title="删除路由" disabled={group.routes.length <= 1 || busy} onClick={() => setDeleteTarget({ kind: "route", index })}><Trash2 size={14} /></Button>
              </div>)}
            </div>
          </SettingsFormSection>
          <button type="button" className="settings-form-link danger" disabled={busy} onClick={() => { if (selectedId !== undefined) setDeleteTarget({ kind: "group", id: selectedId }); }}>删除模型组</button>
        </SettingsForm>}
      </div>
    </div>
    <Dialog open={deleteTarget !== undefined} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(undefined); }}>
      <DialogContent title={deleteTarget?.kind === "group" ? "删除模型组" : "删除路由"}>
        <p className="delete-session-message">{deleteTarget?.kind === "group" ? <>模型组及其路由将被删除，此操作不可恢复。</> : <>路由将被删除，此操作不可恢复。</>}</p>
        <div className="dialog-actions"><Button variant="secondary" onClick={() => setDeleteTarget(undefined)} disabled={busy}>取消</Button><Button variant="danger" onClick={deleteTarget?.kind === "group" ? removeGroup : removeRoute} disabled={busy}>删除</Button></div>
      </DialogContent>
    </Dialog>
  </SettingsSubpage>;
}

function optionalNumber(value: string, previous: number | undefined): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : previous;
}

function toggleInput(input: Array<"text" | "image">, value: "text" | "image", enabled: boolean): Array<"text" | "image"> {
  if (enabled) return input.includes(value) ? input : [...input, value];
  return input.filter((item) => item !== value);
}
