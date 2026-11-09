import { useEffect, useState } from "react";
import type { SubagentThreadRow } from "../../shared/protocol";
import { revealSubagentThread, subagentElapsed, subagentStatusLabel } from "../lib/subagents";
import { Dialog, DialogContent } from "./ui/dialog";

interface SubagentStatusProps {
  /** 未结束的子代理线程；空或缺失时整行不出现。 */
  threads?: SubagentThreadRow[];
}

/**
 * 输入框上方的一行状态：还有几个子代理在跑。点开看是哪些线程。
 * 只表达当前会话；别的会话靠侧栏的状态点。
 */
export function SubagentStatus({ threads }: SubagentStatusProps) {
  const [open, setOpen] = useState(false);
  const label = subagentStatusLabel(threads);
  if (label === undefined || threads === undefined) return null;
  return (
    <div className="subagent-status-bar">
      <Dialog open={open} onOpenChange={setOpen}>
        <button type="button" className="subagent-status" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <span className="subagent-status-dot" aria-hidden="true" />
          <span className="subagent-status-text">{label}</span>
        </button>
        <DialogContent className="selector-sheet subagent-status-sheet" title="子代理">
          <SubagentStatusList threads={threads} onReveal={(path) => { setOpen(false); revealSubagentThread(path); }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SubagentStatusList({ threads, onReveal }: { threads: SubagentThreadRow[]; onReveal: (path: string) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <ul className="subagent-status-list">
    {threads.map((thread) => {
      const elapsed = subagentElapsed(thread, now);
      return <li key={thread.path}>
        <button type="button" className="subagent-status-row" onClick={() => onReveal(thread.path)}>
          <span className="subagent-status-kind">
            <span className="subagent-status-type">{thread.type}</span>
            {thread.state === "paused" ? <span className="subagent-status-state">已暂停</span> : null}
          </span>
          <span className="subagent-status-line">{thread.line}</span>
          {elapsed === undefined ? null : <span className="subagent-status-elapsed">{elapsed}</span>}
        </button>
      </li>;
    })}
  </ul>;
}
