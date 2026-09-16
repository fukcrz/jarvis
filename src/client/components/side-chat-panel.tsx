import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRight, Puzzle, RotateCcw, X } from "lucide-react";
import type { ComposerCommand, ImageAttachment, ModelDescriptor, RunState, SessionFileReference, SessionRef, SessionSummary, ThinkingLevel, WorkspaceFile } from "../../shared/protocol";
import { emptySessionQueue } from "../../shared/protocol";
import { api, isSessionConflict } from "../api";
import { useSessionStream, type ExtensionPanelState } from "../hooks/use-session-stream";
import { useHistoryBackTrap } from "../lib/history-back-trap";
import { parseBashCommand, randomUUID } from "../lib/utils";
import { ContextButton } from "./context-button";
import { ModelSelector } from "./model-selector";
import { PromptEditor } from "./prompt-editor";
import { ThinkingSelector } from "./thinking-selector";
import { Timeline } from "./timeline";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import { Tooltip } from "./ui/tooltip";

const EMPTY_COMMANDS: ComposerCommand[] = [];
const COMMAND_RETRY_BASE_DELAY_MS = 750;
const COMMAND_RETRY_MAX_DELAY_MS = 10_000;

interface SideChatPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentRef?: SessionRef;
  assistantName: string;
  workspaceCwd?: string;
  isMobile: boolean;
  onRunStateChange?: (runState: RunState | undefined) => void;
}

export function SideChatPanel({ open, onOpenChange, parentRef, assistantName, workspaceCwd, isMobile, onRunStateChange }: SideChatPanelProps) {
  const [sideRef, setSideRef] = useState<SessionRef | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [draftNonce, setDraftNonce] = useState(0);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [commands, setCommands] = useState<ComposerCommand[]>([]);
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const [thinkingLevelPending, setThinkingLevelPending] = useState(false);
  const [compactionPending, setCompactionPending] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const parentKey = parentRef === undefined ? undefined : `${parentRef.workspaceId}:${parentRef.sessionId}`;
  const parentKeyRef = useRef(parentKey);
  parentKeyRef.current = parentKey;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const composerFocusRef = useRef<(() => void) | undefined>(undefined);

  const stream = useSessionStream(open ? sideRef : undefined, assistantName, "侧聊", { manageDocumentTitle: false });

  useEffect(() => {
    if (!open || sideRef === undefined) return;
    onRunStateChange?.(stream.transcript.status.runState);
  }, [open, onRunStateChange, sideRef, stream.transcript.status.runState]);

  useEffect(() => {
    setSideRef(undefined);
    setError(undefined);
    setDraft("");
    setDraftNonce((nonce) => nonce + 1);
    setAttachments([]);
    setCommands([]);
    setModelSwitchPending(false);
    setThinkingLevelPending(false);
    setCompactionPending(false);
    setResetOpen(false);
    if (parentRef === undefined || parentKey === undefined) {
      onRunStateChange?.(undefined);
      return;
    }
    const selectedKey = parentKey;
    let disposed = false;
    void api.peekSideChat(parentRef).then((session) => {
      if (disposed || parentKeyRef.current !== selectedKey) return;
      onRunStateChange?.(session?.runState);
    }).catch((caught: unknown) => {
      if (!disposed && parentKeyRef.current === selectedKey) setError(caught instanceof Error ? caught.message : "无法加载侧聊");
    });
    return () => { disposed = true; };
  }, [parentKey]);

  useEffect(() => {
    if (!open || parentRef === undefined) {
      setSideRef(undefined);
      return;
    }
    const selectedKey = parentKey;
    let disposed = false;
    void api.ensureSideChat(parentRef).then((session) => {
      if (disposed || parentKeyRef.current !== selectedKey) return;
      setSideRef({ workspaceId: parentRef.workspaceId, sessionId: session.id });
      onRunStateChange?.(session.runState);
      setError(undefined);
    }).catch((caught: unknown) => {
      if (!disposed && parentKeyRef.current === selectedKey) setError(caught instanceof Error ? caught.message : "无法打开侧聊");
    });
    return () => { disposed = true; };
  }, [open, parentKey]);

  function bindSession(parent: SessionRef, session: SessionSummary): void {
    setSideRef({ workspaceId: parent.workspaceId, sessionId: session.id });
    onRunStateChange?.(session.runState);
  }

  useEffect(() => {
    if (sideRef === undefined || stream.connection !== "live") return;
    const ref = sideRef;
    let disposed = false;
    let retryTimer: number | undefined;
    let attempt = 0;
    const loadCommands = async () => {
      try {
        const items = await api.commands(ref);
        if (disposed) return;
        attempt = 0;
        setCommands(items);
      } catch {
        if (disposed) return;
        const delay = Math.min(COMMAND_RETRY_BASE_DELAY_MS * 2 ** attempt, COMMAND_RETRY_MAX_DELAY_MS);
        attempt += 1;
        retryTimer = window.setTimeout(() => { void loadCommands(); }, delay);
      }
    };
    void loadCommands();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [sideRef?.workspaceId, sideRef?.sessionId, stream.connection]);

  useHistoryBackTrap(isMobile && open, () => onOpenChange(false));

  const recoverConflict = useCallback(async (caught: unknown): Promise<boolean> => {
    if (!isSessionConflict(caught)) return false;
    await stream.refresh().catch(() => undefined);
    return true;
  }, [stream.refresh]);

  const searchFiles = useCallback(async (query: string): Promise<WorkspaceFile[]> => {
    if (parentRef === undefined) return [];
    return api.searchFiles(parentRef.workspaceId, query);
  }, [parentRef?.workspaceId]);

  const searchSessionFiles = useCallback(async (query: string): Promise<SessionFileReference[]> => {
    if (parentRef === undefined) return [];
    return (await api.searchSessionFiles(parentRef.workspaceId, query)).filter((session) => session.id !== parentRef.sessionId && session.id !== sideRef?.sessionId);
  }, [parentRef?.workspaceId, parentRef?.sessionId, sideRef?.sessionId]);

  const updateDraft = useCallback((value: string, external = false) => {
    setDraft(value);
    if (external) setDraftNonce((nonce) => nonce + 1);
  }, []);

  const submitPrompt = async (text: string, images: ImageAttachment[], behavior?: "steer" | "followUp"): Promise<boolean> => {
    if (sideRef === undefined) return false;
    if (images.length === 0 && parseBashCommand(text) !== undefined) {
      setError("侧聊为只读");
      return false;
    }
    const clientRequestId = randomUUID();
    stream.addOptimisticUser(clientRequestId, text, images);
    try {
      const result = await api.prompt(sideRef, text, clientRequestId, images, behavior);
      if (result.queued === true) stream.discardOptimisticUser(clientRequestId);
      setError(undefined);
      return true;
    } catch (caught) {
      stream.discardOptimisticUser(clientRequestId);
      if (await recoverConflict(caught)) return false;
      setError(caught instanceof Error ? caught.message : "无法发送消息");
      return false;
    }
  };

  const abort = async () => {
    if (sideRef === undefined) return;
    try {
      const result = await api.abort(sideRef, stream.transcript.status.activeRun?.id);
      const dequeued = result.dequeued;
      if (dequeued !== undefined && (dequeued.steering.length > 0 || dequeued.followUp.length > 0)) {
        const texts = [...dequeued.steering, ...dequeued.followUp].map((message) => message.text);
        updateDraft([...texts, draftRef.current].filter((value) => value.trim() !== "").join("\n\n"), true);
      }
    } catch (caught) {
      if (await recoverConflict(caught)) return;
      setError(caught instanceof Error ? caught.message : "无法停止执行");
    }
  };

  const compact = async () => {
    if (sideRef === undefined || compactionPending) return;
    setCompactionPending(true);
    try {
      await api.compact(sideRef, undefined, randomUUID());
      setError(undefined);
    } catch (caught) {
      setCompactionPending(false);
      if (await recoverConflict(caught)) return;
      setError(caught instanceof Error ? caught.message : "无法压缩上下文");
    }
  };

  useEffect(() => {
    if (!compactionPending) return;
    if (stream.transcript.status.runState === "idle" && stream.transcript.status.activeRun === undefined && stream.transcript.status.compacting === undefined) {
      setCompactionPending(false);
    }
  }, [compactionPending, stream.transcript.status]);

  const selectModel = async (model: ModelDescriptor) => {
    if (sideRef === undefined || modelSwitchPending) return;
    setModelSwitchPending(true);
    try {
      await stream.selectModel(model);
      setError(undefined);
    } catch (caught) {
      if (!(await recoverConflict(caught))) setError(caught instanceof Error ? caught.message : "无法切换模型");
    } finally {
      setModelSwitchPending(false);
    }
  };

  const selectThinkingLevel = async (level: ThinkingLevel) => {
    if (sideRef === undefined || thinkingLevelPending) return;
    setThinkingLevelPending(true);
    try {
      await stream.setThinkingLevel(level);
      setError(undefined);
    } catch (caught) {
      if (!(await recoverConflict(caught))) setError(caught instanceof Error ? caught.message : "无法切换思考等级");
    } finally {
      setThinkingLevelPending(false);
    }
  };

  const dequeueAll = async () => {
    if (sideRef === undefined) return;
    try {
      const { steering, followUp } = await api.dequeueQueue(sideRef);
      const texts = [...steering, ...followUp].map((message) => message.text);
      if (texts.length === 0) return;
      updateDraft([texts.join("\n\n"), draftRef.current].filter((value) => value.trim() !== "").join("\n\n"), true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法取回排队消息");
    }
  };

  const removeQueued = async (messageId: string, restore: boolean) => {
    if (sideRef === undefined) return;
    try {
      const { removed } = await api.removeQueued(sideRef, messageId);
      if (restore && removed !== undefined) {
        updateDraft([removed.text, draftRef.current].filter((value) => value.trim() !== "").join("\n\n"), true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法移除该排队消息");
    }
  };

  const toggleQueuedKind = async (messageId: string) => {
    if (sideRef === undefined) return;
    const message = [...stream.transcript.queue.steering, ...stream.transcript.queue.followUp].find((item) => item.id === messageId);
    if (message === undefined) return;
    try {
      await api.setQueuedKind(sideRef, messageId, message.kind === "steer" ? "followUp" : "steer");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法切换排队方式");
    }
  };

  const editUserMessage = async (message: Extract<import("../../shared/protocol").TimelineItem, { kind: "message" }>, text: string): Promise<boolean> => {
    if (sideRef === undefined || stream.transcript.status.runState !== "idle") return false;
    const clientRequestId = randomUUID();
    const images = message.images ?? [];
    stream.replaceUserMessage(message.id, clientRequestId, text, images);
    try {
      await api.editAndResend(sideRef, message.id, text, clientRequestId, images);
      setError(undefined);
      return true;
    } catch (caught) {
      stream.discardOptimisticUser(clientRequestId);
      await stream.refresh().catch(() => undefined);
      if (await recoverConflict(caught)) return false;
      setError(caught instanceof Error ? caught.message : "无法重新生成消息");
      return false;
    }
  };

  const abortRef = useRef(abort);
  const statusRef = useRef(stream.transcript.status);
  useEffect(() => { abortRef.current = abort; });
  useEffect(() => { statusRef.current = stream.transcript.status; });
  useEffect(() => {
    if (!open || sideRef === undefined) return;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"], [role="menu"], .extension-operation.pending, .composer-completions, .cm-tooltip-autocomplete, [data-radix-popper-content-wrapper]') !== null) return;
      event.preventDefault();
      event.stopPropagation();
      if (statusRef.current.runState !== "idle") {
        void abortRef.current();
        return;
      }
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [open, onOpenChange, sideRef?.sessionId]);

  const reset = async () => {
    if (parentRef === undefined || resetPending) return;
    setResetPending(true);
    try {
      const session = await api.resetSideChat(parentRef);
      bindSession(parentRef, session);
      setDraft("");
      setDraftNonce((nonce) => nonce + 1);
      setAttachments([]);
      setResetOpen(false);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法重置侧聊");
    } finally {
      setResetPending(false);
    }
  };

  const busy = stream.transcript.status.runState !== "idle" || compactionPending;
  const controls = sideRef === undefined ? undefined : <>
    <ModelSelector model={stream.transcript.model} disabled={stream.connection !== "live" || thinkingLevelPending || compactionPending} pending={modelSwitchPending} onSelect={(model) => { void selectModel(model); }} />
    <ThinkingSelector thinking={stream.transcript.thinking} disabled={stream.connection !== "live" || modelSwitchPending || compactionPending} pending={thinkingLevelPending} onSelect={(level) => { void selectThinkingLevel(level); }} />
    <ContextButton contextUsage={stream.transcript.contextUsage} disabled={stream.connection !== "live"} busy={busy} onCompact={() => { void compact(); }} />
  </>;

  const body = sideRef === undefined
    ? <section className="side-chat-empty">{error}</section>
    : <div className="chat-stage">
      <Timeline key={`${sideRef.workspaceId}:${sideRef.sessionId}`} items={stream.transcript.items} streamingMessageId={stream.transcript.streamingMessageId} hasMore={stream.transcript.hasMore} loadingMore={stream.loadingEarlier} onLoadMore={stream.loadEarlier} error={stream.error ?? error} onDismissNotice={() => setError(undefined)} status={stream.transcript.status} onRetryCompaction={() => { void compact(); }} onEditUserMessage={stream.transcript.status.runState !== "idle" ? undefined : editUserMessage} onExtensionUiRespond={stream.respondExtensionUi} workspaceCwd={workspaceCwd} />
      <div className="chat-dock">
        <SideChatExtensionPanels panels={stream.extensionPanels} />
        <PromptEditor key={sideRef.sessionId} initialValue={draft} draftNonce={draftNonce} busy={busy} commands={commands.length === 0 ? EMPTY_COMMANDS : commands} searchFiles={searchFiles} searchSessionFiles={searchSessionFiles} onDraftChange={updateDraft} onSubmit={submitPrompt} onStop={() => { void abort(); }} attachments={attachments} onAttachmentsChange={setAttachments} onAttachmentError={setError} attachDisabled={stream.transcript.model.current?.vision === false} injectedText={stream.extensionPanels.editorText} queue={stream.transcript.queue ?? emptySessionQueue} onDequeueAll={() => { void dequeueAll(); }} onRemoveQueued={removeQueued} onToggleKind={toggleQueuedKind} focusRequestRef={composerFocusRef} autoFocus={open && !isMobile} controls={controls} />
      </div>
    </div>;

  const header = <header className="side-chat-header">
    <strong>侧聊</strong>
    <div className="side-chat-header-actions">
      <Tooltip label="重置"><Button variant="ghost" size="icon" aria-label="重置" disabled={parentRef === undefined || resetPending} onClick={() => setResetOpen(true)}><RotateCcw size={15} /></Button></Tooltip>
      <Tooltip label="关闭"><Button variant="ghost" size="icon" aria-label="关闭" onClick={() => onOpenChange(false)}><X size={15} /></Button></Tooltip>
    </div>
  </header>;

  const dialog = <Dialog open={resetOpen} onOpenChange={(next) => { if (!next && !resetPending) setResetOpen(false); }}>
    <DialogContent title="重置侧聊">
      <p className="delete-session-message">清空侧聊记录，不可恢复。</p>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={() => setResetOpen(false)} disabled={resetPending}>取消</Button>
        <Button variant="danger" onClick={() => { void reset(); }} disabled={resetPending}>{resetPending ? "正在重置…" : "重置"}</Button>
      </div>
    </DialogContent>
  </Dialog>;

  if (parentRef === undefined) return null;
  if (isMobile) {
    if (!open) return dialog;
    return <>
      <div className="side-chat-sheet-overlay" onClick={() => onOpenChange(false)} />
      <aside className="side-chat-sheet" role="dialog" aria-label="侧聊">
        {header}
        {body}
      </aside>
      {dialog}
    </>;
  }
  if (!open) return dialog;
  return <><aside className="side-chat-drawer" aria-label="侧聊">{header}{body}</aside>{dialog}</>;
}

function SideChatExtensionPanels({ panels }: { panels: ExtensionPanelState }) {
  const widgets = Object.entries(panels.widgets);
  const statuses = Object.entries(panels.statuses);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (widgets.length === 0 && statuses.length === 0) return null;
  return <aside className="extension-panels" aria-label="扩展内容">
    <div className="extension-widget-track">
      {statuses.map(([key, text]) => <span className="extension-status" key={`status:${key}`} title={key}><Puzzle size={11} /><span>{text}</span></span>)}
      {widgets.map(([key, widget]) => <section key={`widget:${key}`} className={`extension-widget ${collapsed[key] === true ? "collapsed" : ""}`} title={key}>
        <button type="button" className="extension-widget-heading" onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))} aria-expanded={collapsed[key] !== true}>
          <span>{key}</span><small>{collapsed[key] === true ? "展开" : "收起"}</small>
        </button>
        {collapsed[key] === true ? null : <pre className="extension-widget-body">{widget.lines.join("\n")}</pre>}
      </section>)}
    </div>
  </aside>;
}

export function SideChatToggle({ open, running, disabled, onClick }: { open: boolean; running: boolean; disabled?: boolean; onClick: () => void }) {
  return <Tooltip label="侧边聊天"><Button variant="ghost" size="icon" className={`side-chat-toggle${open ? " active" : ""}`} aria-label="侧边聊天" aria-pressed={open} disabled={disabled} onClick={onClick}>
    <PanelRight size={16} />
    {running ? <span className="side-chat-running" role="status" aria-label="侧聊运行中" /> : null}
  </Button></Tooltip>;
}
