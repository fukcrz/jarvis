import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Crosshair } from "lucide-react";
import { api } from "../api";
import type { SessionRef, SubagentStreamItem } from "../../shared/protocol";
import { formatThreadElapsed, streamItemsFromTimeline, threadMeta, threadStateLabel, threadTitle, type SubagentPanelThread } from "../lib/subagent-panel";
import { MarkdownMessage } from "./markdown-message";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const HISTORY_LIMIT = 200;

export interface SubagentDetailProps {
  thread: SubagentPanelThread;
  workspaceCwd?: string;
  /** 读线程历史要父会话；缺省时只显示实时输出。 */
  parentRef?: SessionRef;
  /** 实时输出：按线程路径累积的增量。 */
  stream?: readonly SubagentStreamItem[];
  onHistory?: (path: string, items: SubagentStreamItem[], prepend?: boolean) => void;
  /** 回到时间线里对应的过程记录。 */
  onLocate?: (path: string) => void;
  /** 给了才显示返回按钮：从列表进详情时用它，独立打开的详情不需要。 */
  onBack?: () => void;
  /** 挂到面板或对话框上时用来取当前时间来源。 */
  now?: number;
}

/**
 * 子代理详情的唯一实现：右侧栏、时间线记录、移动端对话框都渲染这一个组件。
 * 概览只有状态、当前动作、错误、结果和任务；输出页是实时流加历史回填。
 */
export function SubagentDetail({ thread, workspaceCwd, parentRef, stream, onHistory, onLocate, onBack, now }: SubagentDetailProps) {
  const [tab, setTab] = useState<"overview" | "output">("overview");
  const [tick, setTick] = useState(() => Date.now());
  const ticking = now === undefined && thread.durationMs === undefined && (thread.state === "running" || thread.state === "partial");
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => { setTick(Date.now()); }, 1_000);
    return () => { window.clearInterval(timer); };
  }, [ticking]);
  const elapsed = formatThreadElapsed(thread, now ?? tick);
  const meta = threadMeta(thread);
  const items = stream ?? [];
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyBefore, setHistoryBefore] = useState<number | undefined>();
  const requestGeneration = useRef(0);
  const path = thread.path;
  const threadSessionId = thread.threadSessionId;

  const loadHistory = useCallback((before?: number) => {
    if (path === undefined || threadSessionId === undefined || parentRef === undefined) return;
    const generation = ++requestGeneration.current;
    const target = parentRef;
    setHistoryState("loading");
    void api.subagentTimeline(target, threadSessionId, path, before, HISTORY_LIMIT).then((page) => {
      if (generation !== requestGeneration.current) return;
      onHistory?.(path, streamItemsFromTimeline(page.items), true);
      setHistoryBefore(page.start);
      setHistoryHasMore(page.hasMore);
      setHistoryState("done");
    }).catch(() => {
      if (generation === requestGeneration.current) setHistoryState("failed");
    });
  }, [path, threadSessionId, parentRef, onHistory]);

  useEffect(() => {
    if (tab !== "output") return;
    loadHistory();
    return () => { requestGeneration.current++; };
  }, [loadHistory, tab]);

  return <section className="subagent-panel subagent-detail" aria-label="子代理详情">
    <header className="subagent-detail-header">
      {onBack === undefined ? null : <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}><ChevronLeft size={16} /></Button>}
      <span className="subagent-detail-title" title={threadTitle(thread)}>{threadTitle(thread)}</span>
      {thread.path === undefined || onLocate === undefined ? null : <Tooltip label="在时间线中定位"><Button variant="ghost" size="icon" aria-label="在时间线中定位" onClick={() => { onLocate(thread.path as string); }}><Crosshair size={15} /></Button></Tooltip>}
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
        <pre className="subagent-detail-pre">{thread.fullPrompt ?? thread.prompt}</pre>
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
