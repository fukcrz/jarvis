import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { SessionRef, SubagentStreamItem } from "../../shared/protocol";
import { formatThreadElapsed, groupSubagentThreadTree, subagentThreadTree, threadBranchActive, type SubagentPanelThread, type SubagentThreadNode } from "../lib/subagent-panel";
import { SubagentDetail } from "./subagent-detail";

const FINISHED_PREVIEW = 5;

interface SubagentPanelProps {
  threads: readonly SubagentPanelThread[];
  onLocate: (path: string) => void;
  workspaceCwd?: string;
  parentRef?: SessionRef;
  /** 实时输出：按线程路径累积的增量。 */
  streams?: Record<string, SubagentStreamItem[]>;
  onHistory?: (path: string, items: SubagentStreamItem[], prepend?: boolean) => void;
  /** 外部指定要打开的线程（时间线记录点进来）。优先于列表内部选中。 */
  selectedThread?: SubagentPanelThread;
  /** 详情页返回时清掉外部选中。 */
  onSelectedThreadChange?: (thread: SubagentPanelThread | undefined) => void;
}

export function SubagentPanel({ threads, onLocate, workspaceCwd, parentRef, streams, onHistory, selectedThread, onSelectedThreadChange }: SubagentPanelProps) {
  const [localKey, setLocalKey] = useState<string | undefined>();
  const [showAllFinished, setShowAllFinished] = useState(false);
  const [openOverrides, setOpenOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [now, setNow] = useState(() => Date.now());
  const { active, finished } = useMemo(() => groupSubagentThreadTree(subagentThreadTree(threads)), [threads]);
  const ticking = active.some((node) => threadBranchActive(node));
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [ticking]);
  // 外部指定（时间线记录）优先；同一路径有实时线程时用实时那份，只把记录里的完整任务补上。
  const external = selectedThread === undefined ? undefined : (() => {
    const live = threads.find((thread) => thread.path !== undefined && thread.path === selectedThread.path);
    if (live === undefined) return selectedThread;
    return live.fullPrompt === undefined && selectedThread.fullPrompt !== undefined ? { ...live, fullPrompt: selectedThread.fullPrompt } : live;
  })();
  const selected = external ?? (localKey === undefined ? undefined : threads.find((thread) => thread.key === localKey));
  useEffect(() => {
    if (localKey !== undefined && !threads.some((thread) => thread.key === localKey)) setLocalKey(undefined);
  }, [threads, localKey]);
  const openThread = (thread: SubagentPanelThread) => {
    onSelectedThreadChange?.(undefined);
    setLocalKey(thread.key);
  };
  const closeDetail = () => {
    onSelectedThreadChange?.(undefined);
    setLocalKey(undefined);
  };
  useEffect(() => {
    if (selected === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]') !== null) return;
      event.preventDefault();
      event.stopPropagation();
      closeDetail();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => { window.removeEventListener("keydown", onKeyDown, true); };
  }, [selected === undefined, onSelectedThreadChange]);

  if (threads.length === 0) return <section className="subagent-panel" aria-label="子代理"><p className="subagent-panel-empty">无子代理</p></section>;
  if (selected !== undefined) return <SubagentDetail
    thread={selected}
    now={now}
    workspaceCwd={workspaceCwd}
    parentRef={parentRef}
    stream={streams?.[selected.path ?? ""]}
    onHistory={onHistory}
    onLocate={onLocate}
    onBack={closeDetail}
  />;

  const visibleFinished = showAllFinished ? finished : finished.slice(-FINISHED_PREVIEW);
  const isOpen = (node: SubagentThreadNode) => openOverrides[node.thread.key] ?? threadBranchActive(node);
  const onToggle = (node: SubagentThreadNode) => {
    setOpenOverrides((current) => ({ ...current, [node.thread.key]: !isOpen(node) }));
  };
  return <section className="subagent-panel" aria-label="子代理">
    <div className="subagent-panel-scroll">
      {active.length === 0 ? null : <SubagentTree nodes={active} label="进行中" depth={0} now={now} isOpen={isOpen} onToggle={onToggle} onOpen={openThread} />}
      {finished.length === 0 ? null : <>
        <div className="subagent-group-heading"><span>已结束</span><span>{String(finished.length)}</span></div>
        <SubagentTree nodes={visibleFinished} depth={0} now={now} isOpen={isOpen} onToggle={onToggle} onOpen={openThread} />
        {finished.length > FINISHED_PREVIEW && !showAllFinished ? <button type="button" className="subagent-show-all" onClick={() => { setShowAllFinished(true); }}>查看全部</button> : null}
      </>}
    </div>
  </section>;
}

function SubagentTree({ nodes, label, depth, now, isOpen, onToggle, onOpen }: { nodes: readonly SubagentThreadNode[]; label?: string; depth: number; now: number; isOpen: (node: SubagentThreadNode) => boolean; onToggle: (node: SubagentThreadNode) => void; onOpen: (thread: SubagentPanelThread) => void }) {
  return <ul className={depth === 0 ? "subagent-list" : "subagent-list subagent-children"} aria-label={label}>
    {nodes.map((node) => {
      const open = node.children.length > 0 && isOpen(node);
      return <li key={node.thread.key}>
        <div className="subagent-tree-item" style={{ paddingLeft: 8 + depth * 14 }}>
          {node.children.length > 0 ? <button type="button" className="subagent-tree-toggle" aria-expanded={open} aria-label={open ? "收起" : "展开"} onClick={() => { onToggle(node); }}><ChevronRight size={14} /></button> : <span className="subagent-tree-spacer" aria-hidden="true" />}
          <SubagentRow thread={node.thread} now={now} onOpen={() => { onOpen(node.thread); }} />
        </div>
        {open ? <SubagentTree nodes={node.children} depth={depth + 1} now={now} isOpen={isOpen} onToggle={onToggle} onOpen={onOpen} /> : null}
      </li>;
    })}
  </ul>;
}

function SubagentRow({ thread, now, onOpen }: { thread: SubagentPanelThread; now: number; onOpen: () => void }) {
  const elapsed = formatThreadElapsed(thread, now);
  const segment = thread.path?.split("/").at(-1);
  return <button type="button" className="subagent-row" data-state={thread.state} data-depth={thread.depth} onClick={onOpen}>
    <span className="subagent-row-head">
      <span className="subagent-row-dot" data-state={thread.state} aria-hidden="true" />
      <span className="subagent-row-agent">{thread.agent}</span>
      {thread.depth > 0 && segment !== undefined ? <span className="subagent-row-parent">{segment}</span> : null}
      {elapsed === undefined ? null : <span className="subagent-row-elapsed">{elapsed}</span>}
    </span>
    <span className="subagent-row-line" title={thread.line}>{thread.line}</span>
  </button>;
}
