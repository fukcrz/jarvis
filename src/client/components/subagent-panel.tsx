import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Crosshair } from "lucide-react";
import { api } from "../api";
import type { SessionRef, SubagentStreamItem } from "../../shared/protocol";
import { formatThreadElapsed, groupSubagentThreads, isActiveThread, streamItemsFromTimeline, threadMeta, threadStateLabel, threadTitle, type SubagentPanelThread } from "../lib/subagent-panel";
import { MarkdownMessage } from "./markdown-message";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const FINISHED_PREVIEW = 5;
const HISTORY_LIMIT = 200;

interface SubagentPanelProps {
  threads: readonly SubagentPanelThread[];
  onLocate: (path: string) => void;
  workspaceCwd?: string;
  parentRef?: SessionRef;
  /** 实时输出：按线程路径累积的增量。 */
  streams?: Record<string, SubagentStreamItem[]>;
  onHistory?: (path: string, items: SubagentStreamItem[], prepend?: boolean) => void;
}

export function SubagentPanel({ threads, onLocate, workspaceCwd, parentRef, streams, onHistory }: SubagentPanelProps) {
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
  if (selected !== undefined) return <SubagentDetail thread={selected} now={now} workspaceCwd={workspaceCwd} parentRef={parentRef} stream={streams?.[selected.path ?? ""]} onHistory={onHistory} onBack={() => { setSelectedKey(undefined); }} onLocate={onLocate} />;

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

function SubagentDetail({ thread, now, workspaceCwd, parentRef, stream, onHistory, onBack, onLocate }: { thread: SubagentPanelThread; now: number; workspaceCwd?: string; parentRef?: SessionRef; stream?: SubagentStreamItem[]; onHistory?: (path: string, items: SubagentStreamItem[], prepend?: boolean) => void; onBack: () => void; onLocate: (path: string) => void }) {
  const [tab, setTab] = useState<"overview" | "output">("overview");
  const elapsed = formatThreadElapsed(thread, now);
  const meta = threadMeta(thread);
  const items = stream ?? [];
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyBefore, setHistoryBefore] = useState<number | undefined>();
  const requestGeneration = useRef(0);
  const path = thread.path;

  const loadHistory = useCallback((before?: number) => {
    if (path === undefined || thread.threadSessionId === undefined || parentRef === undefined) return;
    const generation = ++requestGeneration.current;
    const target = parentRef;
    setHistoryState("loading");
    void api.subagentTimeline(target, thread.threadSessionId, path, before, HISTORY_LIMIT).then((page) => {
      if (generation !== requestGeneration.current) return;
      onHistory?.(path, streamItemsFromTimeline(page.items), true);
      setHistoryBefore(page.start);
      setHistoryHasMore(page.hasMore);
      setHistoryState("done");
    }).catch(() => {
      if (generation === requestGeneration.current) setHistoryState("failed");
    });
  }, [path, thread.threadSessionId, parentRef, onHistory]);

  useEffect(() => {
    if (tab !== "output") return;
    loadHistory();
    return () => { requestGeneration.current++; };
  }, [loadHistory, tab]);

  return <section className="subagent-panel subagent-detail" aria-label="子代理详情">
    <header className="subagent-detail-header">
      <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}><ChevronLeft size={16} /></Button>
      <span className="subagent-detail-title" title={threadTitle(thread)}>{threadTitle(thread)}</span>
      {thread.path === undefined ? null : <Tooltip label="在时间线中定位"><Button variant="ghost" size="icon" aria-label="在时间线中定位" onClick={() => { onLocate(thread.path as string); }}><Crosshair size={15} /></Button></Tooltip>}
    </header>
    <div className="subagent-detail-tabs" role="tablist" aria-label="子代理详情">
      <button type="button" role="tab" aria-selected={tab === "overview"} className="right-dock-tab" onClick={() => { setTab("overview"); }}>概览</button>
      <button type="button" role="tab" aria-selected={tab === "output"} className="right-dock-tab" onClick={() => { setTab("output"); }}>输出</button>
    </div>
    {tab === "overview" ? <div className="subagent-panel-scroll">
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
      {thread.output === undefined || thread.output.trim().length === 0 ? null : <section className="subagent-detail-block">
        <h3>结果</h3>
        <div className="subagent-markdown subagent-detail-markdown"><MarkdownMessage text={thread.output.trim()} baseDir={workspaceCwd} /></div>
      </section>}
      <section className="subagent-detail-block">
        <h3>任务</h3>
        <pre className="subagent-detail-pre">{thread.prompt}</pre>
      </section>
    </div> : <SubagentOutputStream items={items} state={historyState} hasMore={historyHasMore} onLoadEarlier={() => { if (historyHasMore) loadHistory(historyBefore); }} onRetry={() => { loadHistory(); }} cwd={workspaceCwd} />}
  </section>;
}

function SubagentOutputStream({ items, state, hasMore, onLoadEarlier, onRetry, cwd }: { items: readonly SubagentStreamItem[]; state: "idle" | "loading" | "done" | "failed"; hasMore: boolean; onLoadEarlier: () => void; onRetry: () => void; cwd?: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (!follow) return;
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [follow, items]);
  if (items.length === 0) {
    return <div className="subagent-panel-scroll">
      <p className="subagent-panel-empty">{state === "loading" ? "加载中…" : state === "failed" ? <button type="button" className="subagent-show-all" onClick={onRetry}>读取失败，重试</button> : "暂无输出"}</p>
    </div>;
  }
  return <div
    className="subagent-panel-scroll subagent-output"
    ref={scrollRef}
    onScroll={(event) => {
      const element = event.currentTarget;
      setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
    }}
  >
    {items.map((item) => <SubagentStreamRow key={item.id} item={item} cwd={cwd} />)}
    {hasMore ? <button type="button" className="subagent-show-all" disabled={state === "loading"} onClick={onLoadEarlier}>{state === "loading" ? "加载中…" : "加载更早输出"}</button> : null}
    {state === "failed" ? <button type="button" className="subagent-show-all" onClick={onRetry}>读取失败，重试</button> : null}
  </div>;
}

function SubagentStreamRow({ item, cwd }: { item: SubagentStreamItem; cwd?: string }) {
  if (item.kind === "text") {
    return <div className="subagent-output-text">
      <MarkdownMessage text={item.text ?? ""} streaming={item.streaming} baseDir={cwd} />
      {item.streaming === true ? <span className="subagent-output-caret" aria-label="输出中" /> : null}
    </div>;
  }
  if (item.kind === "thinking") {
    return <details className="subagent-output-thinking">
      <summary>{item.streaming === true ? "思考中" : "思考"}</summary>
      <pre>{item.text ?? ""}</pre>
    </details>;
  }
  const body = item.output ?? item.error;
  const head = <span className="subagent-output-tool-line">
    <span className="subagent-output-tool-name">{item.name ?? "tool"}</span>
    <span className="subagent-output-tool-text" title={item.text}>{item.text ?? ""}</span>
    <span className="subagent-output-tool-state" data-state={item.state ?? "running"}>{item.state === "failed" ? "失败" : item.state === "running" ? "执行中" : "完成"}</span>
  </span>;
  if (body === undefined || body.trim() === "") return <div className="subagent-output-tool">{head}</div>;
  return <details className="subagent-output-tool">
    <summary>{head}</summary>
    <pre className="subagent-output-pre">{body}</pre>
  </details>;
}
