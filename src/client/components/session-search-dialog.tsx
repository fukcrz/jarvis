import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Loader2, Search, Star, X } from "lucide-react";
import type { SessionSummary, Workspace } from "../../shared/protocol";
import { formatRelativeTime, sessionLabel, sortSessionSummaries } from "../lib/utils";
import { Dialog, DialogContent } from "./ui/dialog";

interface SessionSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: Workspace[];
  searchSessions: (query: string) => Promise<Record<string, SessionSummary[]>>;
  onSelectSession: (workspaceId: string, sessionId: string) => void;
}

interface SearchEntry {
  workspace: Workspace;
  session: SessionSummary;
}

/** 跨项目全文搜索弹窗：PC 侧边栏与移动端共用入口。 */
export function SessionSearchDialog(props: SessionSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, SessionSummary[]> | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开重置搜索状态。
  useEffect(() => {
    if (props.open) {
      setQuery("");
      setResults(undefined);
      setPending(false);
    }
  }, [props.open]);

  // debounce 300ms + 竞态保护：仅最新查询的结果生效。
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResults(undefined);
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    const timer = window.setTimeout(() => {
      props.searchSessions(trimmed).then((found) => {
        if (cancelled) return;
        setResults(found);
        setPending(false);
      }).catch(() => {
        if (cancelled) return;
        setResults({});
        setPending(false);
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, props.searchSessions]);

  const entries = useMemo<SearchEntry[]>(() => {
    const flat = props.workspaces.flatMap((workspace) => (results?.[workspace.id] ?? []).map((session) => ({ workspace, session })));
    const byId = new Map(flat.map((entry) => [entry.session.id, entry]));
    return sortSessionSummaries(flat.map((entry) => entry.session)).flatMap((session) => {
      const entry = byId.get(session.id);
      return entry === undefined ? [] : [entry];
    });
  }, [props.workspaces, results]);

  const select = (workspaceId: string, sessionId: string) => {
    props.onOpenChange(false);
    props.onSelectSession(workspaceId, sessionId);
  };

  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent title="搜索会话" className="session-search-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}>
      <label className="session-search-input">
        <Search size={16} aria-hidden="true" />
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索消息内容…" aria-label="搜索消息内容" />
        {pending ? <Loader2 size={15} className="mobile-search-spin" aria-hidden="true" /> : query === "" ? null : <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={15} /></button>}
      </label>
      <div className="session-search-results">
        {query.trim() === "" ? null
          : entries.length === 0 ? <div className="session-search-placeholder">{pending ? "搜索中…" : "没有匹配的会话"}</div>
            : entries.map(({ workspace, session }) =>
              <button type="button" key={`${workspace.id}:${session.id}`} className="session-search-row" onClick={() => select(workspace.id, session.id)}>
                <span className="session-search-head">
                  <span className="session-search-workspace"><Folder size={12} aria-hidden="true" />{workspace.label}</span>
                  <strong>{session.starred === true ? <Star className="session-star" size={11} fill="currentColor" aria-hidden="true" /> : null}<span>{sessionLabel(session.name, session.preview)}</span></strong>
                  <time>{formatRelativeTime(session.updatedAt)}</time>
                </span>
                {session.matchSnippet === undefined ? null : <small className="session-search-snippet">{session.matchSnippet}</small>}
              </button>)}
      </div>
    </DialogContent>
  </Dialog>;
}
