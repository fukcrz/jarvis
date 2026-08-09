import { memo, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Check, ChevronDown, Clipboard, Clock3, LoaderCircle, RotateCcw, XCircle } from "lucide-react";
import type { TimelineItem, ToolTimelineItem } from "../../shared/protocol";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

interface TimelineProps {
  items: TimelineItem[];
  streamingMessageId?: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<void>;
  error?: string;
}

export function Timeline({ items, streamingMessageId, hasMore, loadingMore, onLoadMore, error }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || !following) return;
    element.scrollTop = element.scrollHeight;
  }, [items, streamingMessageId, following]);

  const loadEarlier = async () => {
    const element = scrollRef.current;
    const offset = element === null ? 0 : element.scrollHeight - element.scrollTop;
    await onLoadMore();
    requestAnimationFrame(() => {
      if (element !== null) element.scrollTop = element.scrollHeight - offset;
    });
  };

  return (
    <section className="timeline-shell">
      <div className="timeline" ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 72);
      }}>
        <div className="timeline-inner">
          {hasMore ? <Button variant="secondary" size="sm" className="history-button" disabled={loadingMore} onClick={() => { void loadEarlier(); }}>{loadingMore ? "Loading history" : "Load earlier"}</Button> : null}
          {items.map((item) => item.kind === "message"
            ? <MessageItem key={item.id} item={item} streaming={item.id === streamingMessageId} />
            : <ToolItem key={item.id} item={item} />)}
          {error === undefined ? null : <div className="session-error" role="alert">{error}</div>}
        </div>
      </div>
      {!following ? <Button size="sm" className="jump-latest" onClick={() => { const element = scrollRef.current; if (element !== null) element.scrollTop = element.scrollHeight; setFollowing(true); }}>Jump to latest</Button> : null}
    </section>
  );
}

const MessageItem = memo(function MessageItem({ item, streaming }: { item: Extract<TimelineItem, { kind: "message" }>; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1100);
    } catch {
      setCopied(false);
    }
  };
  return (
    <article className={`message-row ${item.role} ${streaming ? "streaming" : ""}`}>
      <div className="message-content">
        {streaming ? <p className="streaming-text">{item.text}<span className="streaming-cursor" aria-hidden="true" /></p> : <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{item.text}</ReactMarkdown>}
      </div>
      <Tooltip label={copied ? "Copied" : "Copy message"}>
        <button type="button" className="message-copy" aria-label="Copy message" onClick={() => { void copy(); }}><Clipboard size={14} /></button>
      </Tooltip>
    </article>
  );
});

function ToolItem({ item }: { item: ToolTimelineItem }) {
  const [open, setOpen] = useState(item.state === "running" || item.state === "failed");
  const output = item.error ?? item.output;
  const copy = async () => { if (output !== undefined) await navigator.clipboard.writeText(output); };
  return (
    <article className={`tool-item ${item.state}`}>
      <button className="tool-summary" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-state-icon">{toolIcon(item.state)}</span>
        <span className="tool-title">{item.title}</span>
        {item.target === undefined ? null : <span className="tool-target">{item.target}</span>}
        <span className="tool-state-label">{toolLabel(item.state)}</span>
        <ChevronDown className={open ? "chevron-open" : ""} size={16} />
      </button>
      {open ? <div className="tool-details">
        {item.inputPreview === undefined ? null : <div><span className="detail-label">Input</span><pre>{item.inputPreview}</pre></div>}
        {output === undefined ? null : <div><div className="detail-heading"><span className="detail-label">{item.error === undefined ? "Output" : "Error"}</span><Tooltip label="Copy output"><button className="copy-output" type="button" aria-label="Copy output" onClick={() => { void copy(); }}><Clipboard size={13} /></button></Tooltip></div><pre className={item.error === undefined ? "" : "tool-error-output"}>{output}</pre></div>}
      </div> : null}
    </article>
  );
}

function toolIcon(state: ToolTimelineItem["state"]) {
  if (state === "running") return <LoaderCircle size={15} className="spin" />;
  if (state === "completed") return <Check size={15} />;
  if (state === "failed") return <XCircle size={15} />;
  if (state === "cancelled") return <RotateCcw size={15} />;
  return <Clock3 size={15} />;
}

function toolLabel(state: ToolTimelineItem["state"]): string {
  if (state === "running") return "Running";
  if (state === "completed") return "Done";
  if (state === "failed") return "Failed";
  if (state === "cancelled") return "Stopped";
  return "Queued";
}
