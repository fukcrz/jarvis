import { ArrowDown, ArrowUp, ChevronLeft, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelGroup, ModelGroupRoute, ModelGroupsConfig, ModelGroupsSnapshot } from "../../shared/plugins";
import { api } from "../api";
import { DirtyBar, SettingsConfirm, useDirtyRegistration, useSettingsToast } from "./settings-feedback";
import type { ProviderSettings } from "./settings-providers";
import { SectionAction, SettingRow, SettingsBanner, SettingsCard, SettingsEmptyLine, SettingsField, SettingsFormSwitch, SettingsLoading, SettingsPageHead, SettingsSection, SettingsTag, StButton } from "./settings-ui";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABELS: Record<ThinkingLevel, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };
const NULL_LEVEL = "__null__";
const CUSTOM_LEVEL = "__custom__";
export const MODEL_GROUPS_PLUGIN_ID = "model-groups-router";

interface GroupEntry {
  /** 只在本页使用的稳定 key，改 ID 不会让表单重建。 */
  key: string;
  id: string;
  group: ModelGroup;
}
interface Draft {
  rest: { version: number; retry?: ModelGroupsConfig["retry"]; compaction?: ModelGroupsConfig["compaction"]; [key: string]: unknown };
  entries: GroupEntry[];
}

const newGroup = (): ModelGroup => ({
  name: "新模型组",
  contextWindow: 128000,
  maxTokens: 8192,
  reasoning: false,
  input: ["text"],
  routes: [{ provider: "", model: "" }],
});

let entrySeed = 0;
function draftOf(config: ModelGroupsConfig): Draft {
  const { groups, ...rest } = config;
  return { rest, entries: Object.entries(groups).map(([id, group]) => ({ key: `g${String(++entrySeed)}`, id, group })) };
}

function configOf(draft: Draft): ModelGroupsConfig {
  const groups: Record<string, ModelGroup> = {};
  for (const entry of draft.entries) {
    const group = { ...entry.group };
    if (group.thinkingLevelMap !== undefined && Object.keys(group.thinkingLevelMap).length === 0) delete group.thinkingLevelMap;
    groups[entry.id.trim()] = group;
  }
  return { ...draft.rest, groups } as ModelGroupsConfig;
}

function comparable(draft: Draft): string {
  return JSON.stringify({ rest: draft.rest, entries: draft.entries.map((entry) => [entry.id, entry.group]) });
}

/** ID 为空或重复会让保存后的配置丢组，是这页唯一拦截的情况。 */
function idProblem(draft: Draft, entry: GroupEntry): string | undefined {
  const id = entry.id.trim();
  if (id === "") return "ID 不能为空";
  if (draft.entries.some((other) => other.key !== entry.key && other.id.trim() === id)) return "和另一个模型组的 ID 重复";
  return undefined;
}

export function ModelGroupsPage({ ps, refreshKey, onOpenPlugins, onSnapshot, focusGroupId, focusToken }: { ps: ProviderSettings; refreshKey: number; onOpenPlugins: () => void; onSnapshot?: (snapshot: ModelGroupsSnapshot) => void; focusGroupId?: string; focusToken?: string }) {
  const toast = useSettingsToast();
  const [snapshot, setSnapshot] = useState<ModelGroupsSnapshot>();
  const [saved, setSaved] = useState<Draft>();
  const [draft, setDraft] = useState<Draft>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [removePending, setRemovePending] = useState<GroupEntry>();
  const [customLevels, setCustomLevels] = useState<Record<string, true>>({});
  const dirty = draft !== undefined && saved !== undefined && comparable(draft) !== comparable(saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = draft?.entries.find((item) => item.key === selectedKey)?.id.trim();
  useDirtyRegistration("model-groups", dirty);

  // 从搜索跳过来：选中对应的模型组。
  // 每次跳转（focusToken 变化）只选中一次，之后用户自己点别的不再被拉回来。
  const appliedFocusRef = useRef<string | undefined>(undefined);
  const focusTargetKey = focusGroupId === undefined ? undefined : draft?.entries.find((item) => item.id === focusGroupId)?.key;
  useEffect(() => {
    if (focusTargetKey === undefined || appliedFocusRef.current === focusToken) return;
    appliedFocusRef.current = focusToken;
    setSelectedKey(focusTargetKey);
    setMobileDetailOpen(true);
  }, [focusTargetKey, focusToken]);

  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const apply = useCallback((next: ModelGroupsSnapshot, force: boolean) => {
    setSnapshot(next);
    onSnapshotRef.current?.(next);
    if (!force && dirtyRef.current) return;
    const nextDraft = draftOf(next.config);
    setSaved(nextDraft);
    setDraft(nextDraft);
    setSelectedKey(nextDraft.entries.find((entry) => entry.id === selectedIdRef.current)?.key ?? nextDraft.entries[0]?.key);
  }, []);
  const load = useCallback(async (force = false) => {
    try {
      apply(await api.modelGroups(), force);
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "模型组读取失败", "error");
    }
  }, [apply, toast]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const entry = draft?.entries.find((item) => item.key === selectedKey);
  const providerIds = useMemo(() => ps.visibleProviders.map((provider) => provider.id), [ps.visibleProviders]);
  const modelsOf = (providerId: string) => ps.providers.find((provider) => provider.id === providerId)?.models.map((model) => model.id) ?? [];
  const problems = draft?.entries.map((item) => idProblem(draft, item)).filter((problem) => problem !== undefined) ?? [];

  const updateDraft = (updater: (current: Draft) => Draft) => setDraft((current) => current === undefined ? current : updater(current));
  const updateEntry = (key: string, updater: (current: GroupEntry) => GroupEntry) => updateDraft((current) => ({ ...current, entries: current.entries.map((item) => item.key === key ? updater(item) : item) }));
  const updateGroup = (updater: (current: ModelGroup) => ModelGroup) => { if (entry !== undefined) updateEntry(entry.key, (current) => ({ ...current, group: updater(current.group) })); };
  const updateRoute = (index: number, updater: (current: ModelGroupRoute) => ModelGroupRoute) => updateGroup((current) => ({ ...current, routes: current.routes.map((route, routeIndex) => routeIndex === index ? updater(route) : route) }));
  const moveRoute = (index: number, direction: -1 | 1) => updateGroup((current) => {
    const routes = [...current.routes];
    const target = index + direction;
    if (target < 0 || target >= routes.length) return current;
    const [item] = routes.splice(index, 1);
    if (item !== undefined) routes.splice(target, 0, item);
    return { ...current, routes };
  });
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
    if (draft === undefined) return;
    let id = "new-group";
    let suffix = 2;
    while (draft.entries.some((item) => item.id === id)) id = `new-group-${String(suffix++)}`;
    const created: GroupEntry = { key: `g${String(++entrySeed)}`, id, group: newGroup() };
    updateDraft((current) => ({ ...current, entries: [...current.entries, created] }));
    setSelectedKey(created.key);
    setMobileDetailOpen(true);
  };
  const removeGroup = (target: GroupEntry) => {
    if (draft === undefined) return;
    const index = draft.entries.findIndex((item) => item.key === target.key);
    const remaining = draft.entries.filter((item) => item.key !== target.key);
    updateDraft((current) => ({ ...current, entries: current.entries.filter((item) => item.key !== target.key) }));
    setSelectedKey(remaining[Math.max(0, index - 1)]?.key);
    toast.showUndo({
      message: `已移除模型组 ${target.group.name || target.id}（保存后生效）`,
      undo: () => {
        updateDraft((current) => {
          const entries = [...current.entries];
          entries.splice(Math.min(index, entries.length), 0, target);
          return { ...current, entries };
        });
        setSelectedKey(target.key);
      },
    });
  };
  const removeRoute = (index: number) => {
    if (entry === undefined) return;
    const key = entry.key;
    const route = entry.group.routes[index];
    if (route === undefined) return;
    updateGroup((current) => ({ ...current, routes: current.routes.filter((_, routeIndex) => routeIndex !== index) }));
    toast.showUndo({
      message: `已移除路由 ${route.provider || "?"}/${route.model || "?"}`,
      undo: () => updateEntry(key, (current) => {
        const routes = [...current.group.routes];
        routes.splice(Math.min(index, routes.length), 0, route);
        return { ...current, group: { ...current.group, routes } };
      }),
    });
  };
  const save = async () => {
    if (draft === undefined || problems.length > 0) return;
    setSaving(true);
    try {
      apply(await api.saveModelGroups(configOf(draft), snapshot?.revision), true);
      toast.notify("模型组已保存，新开会话生效");
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "模型组保存失败", "error");
    } finally {
      setSaving(false);
    }
  };
  const enablePlugin = async () => {
    setEnabling(true);
    try {
      await api.setBundledPlugin(MODEL_GROUPS_PLUGIN_ID, true);
      await load(true);
      toast.notify("已启用「模型组路由」插件");
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "启用失败", "error");
    } finally {
      setEnabling(false);
    }
  };

  const head = <SettingsPageHead title="模型组" description="把多个供应商的模型合成一个「虚拟模型」：按顺序路由，失败自动换下一条。由自带插件「模型组路由」提供。" />;
  if (snapshot === undefined || draft === undefined) return <>{head}<SettingsLoading /></>;

  const warnings = entry === undefined ? [] : entry.group.routes.flatMap((route, index) => {
    if (route.provider.trim() === "" || route.model.trim() === "") return [`第 ${String(index + 1)} 条路由还没填完整`];
    if (ps.loading) return [];
    if (!ps.providers.some((provider) => provider.id === route.provider)) return [`第 ${String(index + 1)} 条路由的供应商「${route.provider}」不存在`];
    const known = modelsOf(route.provider);
    return known.length > 0 && !known.includes(route.model) ? [`第 ${String(index + 1)} 条路由的模型「${route.model}」不在供应商的模型列表里`] : [];
  });

  return <>
    {head}
    {snapshot.enabled ? null : <SettingsBanner action={<StButton variant="primary" disabled={enabling} onClick={() => { void enablePlugin(); }}>{enabling ? "启用中…" : "启用插件"}</StButton>}>
      「模型组路由」插件没有启用，这里的配置暂时不会生效。<button type="button" className="st-link" onClick={onOpenPlugins}>去插件页</button>
    </SettingsBanner>}
    {snapshot.error === undefined ? null : <SettingsBanner>{snapshot.error}</SettingsBanner>}
    <div className="st-master-detail">
      <SettingsSection id="model-group-list" title="模型组" hint={`${String(draft.entries.length)} 个`} action={<SectionAction label="新建" onClick={addGroup} />}>
        <SettingsCard>
          {draft.entries.length === 0 ? <SettingsEmptyLine>还没有模型组</SettingsEmptyLine> : draft.entries.map((item) => <SettingRow key={item.key} id={`model-group-${item.id}`} className={item.key === selectedKey ? "selected" : undefined}
            title={item.group.name || item.id} description={`${item.id} · ${String(item.group.routes.length)} 条路由`} onClick={() => { setSelectedKey(item.key); setCustomLevels({}); setMobileDetailOpen(true); }} />)}
        </SettingsCard>
      </SettingsSection>
      {entry === undefined ? <SettingsSection><SettingsEmptyLine>新建一个模型组开始配置</SettingsEmptyLine></SettingsSection> : <div className={`st-detail${mobileDetailOpen ? " mobile-open" : ""}`}>
        <button type="button" className="st-mobile-detail-back" onClick={() => setMobileDetailOpen(false)}><ChevronLeft size={16} />模型组列表</button>
        <SettingsSection title={entry.group.name || entry.id} action={<StButton variant="ghost" className="danger" onClick={() => setRemovePending(entry)}><Trash2 size={13} />删除</StButton>}>
          <SettingsCard className="st-form st-form-grid">
            <SettingsField label="名称" hint="显示在模型选择器里"><input value={entry.group.name} onChange={(event) => updateGroup((current) => ({ ...current, name: event.target.value }))} /></SettingsField>
            <SettingsField label="ID" error={idProblem(draft, entry)} hint="会话里引用的模型 ID"><input value={entry.id} spellCheck={false} onChange={(event) => updateEntry(entry.key, (current) => ({ ...current, id: event.target.value }))} /></SettingsField>
            <SettingsField label="上下文窗口" hint="单位 token"><input inputMode="numeric" value={entry.group.contextWindow} onChange={(event) => updateGroup((current) => ({ ...current, contextWindow: numberOr(event.target.value, current.contextWindow) }))} /></SettingsField>
            <SettingsField label="最大输出" hint="单位 token"><input inputMode="numeric" value={entry.group.maxTokens} onChange={(event) => updateGroup((current) => ({ ...current, maxTokens: numberOr(event.target.value, current.maxTokens) }))} /></SettingsField>
            <SettingsFormSwitch label="支持思考" checked={entry.group.reasoning} onChange={(reasoning) => updateGroup((current) => ({ ...current, reasoning }))} />
            <SettingsFormSwitch label="支持图片" checked={entry.group.input.includes("image")} onChange={(checked) => updateGroup((current) => ({ ...current, input: toggleInput(current.input, "image", checked) }))} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection id="model-group-routes" title="路由" hint="从上到下依次尝试" action={<SectionAction label="添加路由" onClick={() => updateGroup((current) => ({ ...current, routes: [...current.routes, { provider: "", model: "" }] }))} />}>
          <SettingsCard className="st-routes">
            <datalist id="st-route-providers">{providerIds.map((id) => <option key={id} value={id} />)}</datalist>
            {entry.group.routes.map((route, index) => <div className="st-route" key={index}>
              <span className="st-route-no">{index + 1}</span>
              <input aria-label="供应商" placeholder="供应商" list="st-route-providers" value={route.provider} onChange={(event) => updateRoute(index, (current) => ({ ...current, provider: event.target.value }))} />
              <input aria-label="模型" placeholder="模型" list={`st-route-models-${String(index)}`} value={route.model} onChange={(event) => updateRoute(index, (current) => ({ ...current, model: event.target.value }))} />
              <datalist id={`st-route-models-${String(index)}`}>{modelsOf(route.provider).map((id) => <option key={id} value={id} />)}</datalist>
              <input aria-label="并发" placeholder="并发" className="st-route-num" inputMode="numeric" value={route.recommendedConcurrency ?? ""} onChange={(event) => updateRoute(index, (current) => ({ ...current, recommendedConcurrency: optionalNumber(event.target.value, current.recommendedConcurrency) }))} />
              <span className="st-route-actions">
                <StButton variant="ghost" icon aria-label="上移" title="上移" disabled={index === 0} onClick={() => moveRoute(index, -1)}><ArrowUp size={13} /></StButton>
                <StButton variant="ghost" icon aria-label="下移" title="下移" disabled={index === entry.group.routes.length - 1} onClick={() => moveRoute(index, 1)}><ArrowDown size={13} /></StButton>
                <StButton variant="ghost" icon aria-label="删除路由" title="删除路由" onClick={() => removeRoute(index)}><Trash2 size={13} /></StButton>
              </span>
            </div>)}
            {entry.group.routes.length === 0 ? <SettingsEmptyLine>还没有路由，这个模型组暂时用不了</SettingsEmptyLine> : null}
          </SettingsCard>
          {warnings.length === 0 ? null : <p className="st-soft-warn">{warnings.join("；")}。仍然可以保存。</p>}
        </SettingsSection>
        {entry.group.reasoning ? <details className="st-advanced st-advanced-card">
          <summary>思考等级映射<small>{entry.group.thinkingLevelMap === undefined ? "默认" : `${String(Object.keys(entry.group.thinkingLevelMap).length)} 项自定义`}</small></summary>
          <div className="st-advanced-body st-form-grid">{THINKING_LEVELS.map((level) => {
            const current = entry.group.thinkingLevelMap?.[level];
            const custom = customLevels[level] === true || (typeof current === "string" && !THINKING_LEVELS.includes(current as ThinkingLevel));
            return <SettingsField key={level} label={LEVEL_LABELS[level]}>{custom
              ? <input value={typeof current === "string" ? current : ""} onChange={(event) => updateThinkingLevel(level, event.target.value)} />
              : <select value={current === undefined ? "" : current === null ? NULL_LEVEL : current} onChange={(event) => {
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
              </select>}</SettingsField>;
          })}</div>
        </details> : null}
      </div>}
    </div>
    <details className="st-advanced st-advanced-card" id="setting-model-group-globals">
      <summary>高级<small>重试与上下文压缩，所有模型组共用</small></summary>
      <div className="st-advanced-body st-form-grid">
        <SettingsField label="重试等待" hint="毫秒，换下一条路由前等多久"><input inputMode="numeric" value={draft.rest.retry?.groupRetryDelayMs ?? ""} placeholder="默认" onChange={(event) => updateDraft((current) => ({ ...current, rest: { ...current.rest, retry: { ...current.rest.retry, groupRetryDelayMs: optionalNumber(event.target.value, current.rest.retry?.groupRetryDelayMs) } } }))} /></SettingsField>
        <SettingsField label="压缩阈值" hint="token，超过后压缩上下文"><input inputMode="numeric" value={draft.rest.compaction?.thresholdTokens ?? ""} placeholder="默认" onChange={(event) => updateDraft((current) => ({ ...current, rest: { ...current.rest, compaction: { ...current.rest.compaction, thresholdTokens: optionalNumber(event.target.value, current.rest.compaction?.thresholdTokens) } } }))} /></SettingsField>
        <SettingsField label="压缩预留" hint="token"><input inputMode="numeric" value={draft.rest.compaction?.reserveTokens ?? ""} placeholder="默认" onChange={(event) => updateDraft((current) => ({ ...current, rest: { ...current.rest, compaction: { ...current.rest.compaction, reserveTokens: optionalNumber(event.target.value, current.rest.compaction?.reserveTokens) } } }))} /></SettingsField>
      </div>
    </details>
    {snapshot.enabled ? null : <p className="st-foot-note"><SettingsTag tone="warn">插件未启用</SettingsTag> 保存的配置会在启用插件后生效。</p>}
    <DirtyBar show={dirty} saving={saving} saveDisabled={problems.length > 0} message={problems.length > 0 ? `有未保存的修改 · ${problems[0] ?? ""}` : "模型组有未保存的修改"}
      onDiscard={() => { if (saved !== undefined) { setDraft(saved); setSelectedKey((current) => saved.entries.find((item) => item.key === current)?.key ?? saved.entries[0]?.key); } }}
      onSave={() => { void save(); }} />
    <SettingsConfirm open={removePending !== undefined} busy={false} danger title="删除模型组？" confirmLabel="删除" onCancel={() => setRemovePending(undefined)} onConfirm={() => {
      if (removePending === undefined) return;
      const target = removePending;
      setRemovePending(undefined);
      removeGroup(target);
    }}>
      <p><b>{removePending?.group.name || removePending?.id}</b> 将从当前配置草稿移除，保存后不再参与模型路由。</p>
    </SettingsConfirm>
  </>;
}

function numberOr(value: string, previous: number): number {
  const parsed = Number(value);
  return value.trim() === "" ? 0 : Number.isFinite(parsed) ? parsed : previous;
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

/** 导航摘要用：模型组数量。 */
export function modelGroupCount(snapshot: ModelGroupsSnapshot | undefined): number | undefined {
  return snapshot === undefined ? undefined : Object.keys(snapshot.config.groups).length;
}
