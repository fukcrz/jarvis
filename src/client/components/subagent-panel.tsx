import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Crosshair } from "lucide-react";
import { formatThreadElapsed, groupSubagentThreads, isActiveThread, threadMeta, threadStateLabel, threadTitle, type SubagentPanelThread } from "../lib/subagent-panel";
import { MarkdownMessage } from "./markdown-message";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const FINISHED_PREVIEW = 5;

interface SubagentPanelProps {
  threads: readonly SubagentPanelThread[];
  onLocate: (path: string) => void;
  workspaceCwd?: string;
}

export function SubagentPanel({ threads, onLocate, workspaceCwd }: SubagentPanelProps) {
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [showAllFinished, setShowAllFinished] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { active, finished } = useMemo(() => groupSubagentThreads(threads), [threads]);
  const ticking = active.some(isActiveThread);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [ticking]);
  const selected = selectedKey === undefined ? undefined : threads.find((thread) => thread.key === selectedKey);
  useEffect(() => {
    if (selectedKey !== undefined && selected === undefined) setSelectedKey(undefined);
  }, [selected, selectedKey]);
  useEffect(() => {
    if (selected === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]') !== null) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedKey(undefined);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); };
  }, [selected === undefined]);

  if (threads.length === 0) return <section className="subagent-panel" aria-label="子代理"><p className="subagent-panel-empty">无子代理</p></section>;
  if (selected !== undefined) return <SubagentDetail thread={selected} now={now} workspaceCwd={workspaceCwd} onBack={() => { setSelectedKey(undefined); }} onLocate={onLocate} />;

  const visibleFinished = showAllFinished ? finished : finished.slice(-FINISHED_PREVIEW);
  return <section className="subagent-panel" aria-label="子代理">
    <div className="subagent-panel-scroll">
      {active.length === 0 ? null : <ul className="subagent-list" aria-label="进行中">
        {active.map((thread) => <SubagentRow key={thread.key} thread={thread} now={now} onOpen={() => { setSelectedKey(thread.key); }} />)}
      </ul>}
      {finished.length === 0 ? null : <>
        <div className="subagent-group-heading"><span>已结束</span><span>{String(finished.length)}</span></div>
        <ul className="subagent-list">
          {visibleFinished.map((thread) => <SubagentRow key={thread.key} thread={thread} now={now} onOpen={() => { setSelectedKey(thread.key); }} />)}
        </ul>
        {finished.length > FINISHED_PREVIEW && !showAllFinished ? <button type="button" className="subagent-show-all" onClick={() => { setShowAllFinished(true); }}>查看全部</button> : null}
      </>}
    </div>
  </section>;
}

function SubagentRow({ thread, now, onOpen }: { thread: SubagentPanelThread; now: number; onOpen: () => void }) {
  const elapsed = formatThreadElapsed(thread, now);
  return <li>
    <button type="button" className="subagent-row" data-state={thread.state} style={{ paddingLeft: 12 + thread.depth * 14 }} onClick={onOpen}>
      <span className="subagent-row-head">
        <span className="subagent-row-dot" data-state={thread.state} aria-hidden="true" />
        <span className="subagent-row-agent">{thread.agent}</span>
        {elapsed === undefined ? null : <span className="subagent-row-elapsed">{elapsed}</span>}
      </span>
      <span className="subagent-row-line" title={thread.line}>{thread.line}</span>
    </button>
  </li>;
}

function SubagentDetail({ thread, now, workspaceCwd, onBack, onLocate }: { thread: SubagentPanelThread; now: number; workspaceCwd?: string; onBack: () => void; onLocate: (path: string) => void }) {
  const elapsed = formatThreadElapsed(thread, now);
  const meta = threadMeta(thread);
  return <section className="subagent-panel subagent-detail" aria-label="子代理详情">
    <header className="subagent-detail-header">
      <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}><ChevronLeft size={16} /></Button>
      <span className="subagent-detail-title" title={threadTitle(thread)}>{threadTitle(thread)}</span>
      {thread.path === undefined ? null : <Tooltip label="在时间线中定位"><Button variant="ghost" size="icon" aria-label="在时间线中定位" onClick={() => { onLocate(thread.path as string); }}><Crosshair size={15} /></Button></Tooltip>}
    </header>
    <div className="subagent-panel-scroll">
      <div className="subagent-detail-status">
        <span className="subagent-row-dot" data-state={thread.state} aria-hidden="true" />
        <span>{thread.agent}</span>
        <span className="subagent-row-elapsed">{threadStateLabel(thread)}</span>
        {elapsed === undefined ? null : <span className="subagent-row-elapsed">{elapsed}</span>}
      </div>
      {meta.length === 0 ? null : <p className="subagent-detail-meta">{meta.join(" · ")}</p>}
      <section className="subagent-detail-block">
        <h3>当前动作</h3>
        <p>{thread.line}</p>
      </section>
      {thread.error === undefined ? null : <section className="subagent-detail-block">
        <h3>错误</h3>
        <pre className="subagent-detail-pre">{thread.error}</pre>
      </section>}
      {thread.steps.length === 0 ? null : <section className="subagent-detail-block">
        <h3>最近步骤</h3>
        <ul className="subagent-detail-steps">
          {thread.steps.slice(-12).map((step, index) => <li key={`${String(index)}:${step.kind}`} data-kind={step.kind}>
            <span className="subagent-step-kind">{step.label ?? (step.kind === "tool" ? "tool" : step.kind === "text" ? "文本" : "思考")}</span>
            {step.text.length === 0 ? null : <span className="subagent-step-text">{step.text}</span>}
          </li>)}
        </ul>
      </section>}
      {thread.output === undefined || thread.output.trim().length === 0 ? null : <section className="subagent-detail-block">
        <h3>输出</h3>
        <div className="subagent-markdown subagent-detail-markdown"><MarkdownMessage text={thread.output.trim()} baseDir={workspaceCwd} /></div>
      </section>}
      <section className="subagent-detail-block">
        <h3>任务</h3>
        <pre className="subagent-detail-pre">{thread.prompt}</pre>
      </section>
    </div>
  </section>;
}
