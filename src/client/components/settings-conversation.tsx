import { useEffect, useState } from "react";
import type { ConversationModel, ConversationSettings, ConversationSettingsPatch, ThinkingLevel } from "../../shared/protocol";
import { api } from "../api";
import { displayModelName } from "../model-display";
import { SaveState, useSaveStatus } from "./settings-feedback";
import { Segmented, SettingRow, SettingsCard, SettingsEmptyLine, SettingsLoading, SettingsPageHead, SettingsSection, SettingsSwitch, StButton } from "./settings-ui";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABELS: Record<ThinkingLevel, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "更高", max: "最高" };

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}\u0000${model.id}`;
}

function modelLabel(model: ConversationModel): string {
  const name = displayModelName(model.name ?? model.id);
  return name === model.provider ? name : `${name} · ${model.provider}`;
}

export function ConversationPage() {
  const saveStatus = useSaveStatus();
  const [settings, setSettings] = useState<ConversationSettings>();
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void api.conversationSettings().then((value) => {
      if (!cancelled) setSettings(value);
    }, () => {
      if (!cancelled) setFailed(true);
    });
    return () => { cancelled = true; };
  }, [reloadKey]);

  const save = (key: string, patch: ConversationSettingsPatch, apply: (current: ConversationSettings) => ConversationSettings) => {
    const previous = settings;
    setSettings((current) => current === undefined ? current : apply(current));
    void saveStatus.run(key, async () => {
      setSettings(await api.updateConversationSettings(patch));
    }, { rollback: () => { if (previous !== undefined) setSettings(previous); } });
  };

  return <>
    <SettingsPageHead title="对话" description="新会话的模型、思考等级和运行方式。" />
    {settings === undefined ? failed
      ? <SettingsCard><SettingsEmptyLine>读取失败<StButton onClick={() => setReloadKey((value) => value + 1)}>重试</StButton></SettingsEmptyLine></SettingsCard>
      : <SettingsLoading />
      : <>
        <SettingsSection id="new-session" title="新会话">
          <SettingsCard className="st-expand">
            <SettingRow id="default-model" title="默认模型" description={settings.models.length === 0 ? "没有可选模型" : "之后新建的会话从这里开始"}
              control={<><SaveState k="default-model" /><ModelSelect settings={settings} onChange={(provider, id) => save("default-model", { defaultModel: { provider, id } }, (current) => ({ ...current, defaultModel: { provider, id } }))} /></>} />
            <SettingRow id="default-thinking" title="默认思考等级" description="模型不支持的等级会收窄"
              control={<><SaveState k="default-thinking" /><select className="st-select" aria-label="默认思考等级" value={settings.defaultThinkingLevel} onChange={(event) => {
                const level = event.target.value as ThinkingLevel;
                save("default-thinking", { defaultThinkingLevel: level }, (current) => ({ ...current, defaultThinkingLevel: level }));
              }}>{THINKING_LEVELS.map((level) => <option key={level} value={level}>{LEVEL_LABELS[level]}</option>)}</select></>} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection id="model-thinking" title="各模型的思考等级" hint="没单独设的用默认">
          <SettingsCard className="st-expand">
            {reasoningModels(settings).length === 0 ? <SettingsEmptyLine>没有带思考的模型</SettingsEmptyLine> : reasoningModels(settings).map((model) => {
              const key = modelKey(model);
              const current = settings.modelThinkingLevels.find((entry) => entry.provider === model.provider && entry.id === model.id)?.level ?? "";
              return <SettingRow key={key} title={modelLabel(model)} control={<><SaveState k={`thinking:${key}`} /><select className="st-select" aria-label={`${modelLabel(model)}的思考等级`} value={current} onChange={(event) => {
                const level = event.target.value === "" ? null : event.target.value as ThinkingLevel;
                save(`thinking:${key}`, { modelThinkingLevel: { provider: model.provider, id: model.id, level } }, (snapshot) => ({
                  ...snapshot,
                  modelThinkingLevels: level === null
                    ? snapshot.modelThinkingLevels.filter((entry) => entry.provider !== model.provider || entry.id !== model.id)
                    : [...snapshot.modelThinkingLevels.filter((entry) => entry.provider !== model.provider || entry.id !== model.id), { provider: model.provider, id: model.id, level }],
                }));
              }}>
                <option value="">跟随默认</option>
                {THINKING_LEVELS.map((level) => <option key={level} value={level}>{LEVEL_LABELS[level]}</option>)}
              </select></>} />;
            })}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection id="while-running" title="运行中发消息">
          <SettingsCard>
            <SettingRow id="queue-mode" title="发送方式" description="插队和后续一起改"
              control={<><SaveState k="queue-mode" /><Segmented label="运行中发消息" value={settings.queueMode} options={[{ value: "one-at-a-time", label: "一次一条" }, { value: "all", label: "全部送出" }]} onChange={(queueMode) => save("queue-mode", { queueMode }, (current) => ({ ...current, queueMode }))} /></>} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection id="context" title="上下文与重试">
          <SettingsCard>
            <SettingRow id="compaction-enabled" title="将满时自动压缩" control={<><SaveState k="compaction" /><SettingsSwitch checked={settings.compactionEnabled} label="将满时自动压缩" onChange={(compactionEnabled) => save("compaction", { compactionEnabled }, (current) => ({ ...current, compactionEnabled }))} /></>} />
            <SettingRow id="retry-enabled" title="失败自动重试" control={<><SaveState k="retry" /><SettingsSwitch checked={settings.retryEnabled} label="失败自动重试" onChange={(retryEnabled) => save("retry", { retryEnabled }, (current) => ({ ...current, retryEnabled }))} /></>} />
          </SettingsCard>
        </SettingsSection>
      </>}
  </>;
}

function reasoningModels(settings: ConversationSettings): ConversationModel[] {
  return settings.models.filter((model) => model.reasoning);
}

function ModelSelect({ settings, onChange }: { settings: ConversationSettings; onChange: (provider: string, id: string) => void }) {
  const selected = settings.defaultModel;
  const selectedKey = selected === undefined ? "" : modelKey(selected);
  const listed = selected !== undefined && settings.models.some((model) => model.provider === selected.provider && model.id === selected.id);
  return <select className="st-select" aria-label="默认模型" value={selectedKey} onChange={(event) => {
    const model = settings.models.find((candidate) => modelKey(candidate) === event.target.value);
    if (model !== undefined) onChange(model.provider, model.id);
  }}>
    {selected === undefined ? <option value="">未设置</option> : listed ? null : <option value={selectedKey}>{selected.id}（不在当前列表）</option>}
    {settings.models.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{modelLabel(model)}</option>)}
  </select>;
}
