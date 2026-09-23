import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { type BasicSetupOptions, type EditorView, type Extension, type ViewUpdate, useCodeMirror } from "@uiw/react-codemirror";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { ArrowUp, Command, FileCode2, History, LoaderCircle, Plus, RotateCcw, Square, X, Zap } from "lucide-react";
import type { ComposerCommand, ImageAttachment, QueuedMessage, SessionFileReference, SessionQueue, WorkspaceFile } from "../../shared/protocol";
import { completionContextFor, completionReplacement, matchingComposerCommands, MAX_COMPOSER_SUGGESTIONS } from "../composer-completion";
import { composerDraftSyncAction, isComposerCompositionPending } from "../lib/composer-draft";
import { imageDataUrl, prepareImage } from "../lib/image";
import { lockVisualViewportKeyboardInset, unlockVisualViewportKeyboardInset } from "../lib/visual-viewport";
import { useIsMobile } from "../hooks/use-is-mobile";
import { ImagePreview } from "./image-lightbox";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const COMPLETION_SEARCH_DEBOUNCE_MS = 120;
const basicSetup: BasicSetupOptions = { lineNumbers: false, foldGutter: false, highlightActiveLine: false };
// Module-level so the array identity never changes; a new identity per render
// would make useCodeMirror reconfigure (and effectively reset) the editor.
const editorExtensions: Extension[] = [
  CodeMirrorView.lineWrapping,
  CodeMirrorView.theme({
    ".cm-content": { caretColor: "#fff" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#fff" },
  }),
];

type Completion =
  | { kind: "command"; command: ComposerCommand }
  | { kind: "file"; file: WorkspaceFile }
  | { kind: "session"; session: SessionFileReference };

interface PromptEditorProps {
  initialValue: string;
  /** 外部改草稿（取回排队消息等）时递增；普通打字回环不递增。 */
  draftNonce?: number;
  busy: boolean;
  commands: ComposerCommand[];
  searchFiles: (query: string) => Promise<WorkspaceFile[]>;
  searchSessionFiles: (query: string) => Promise<SessionFileReference[]>;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string, attachments: ImageAttachment[], behavior?: "steer" | "followUp") => boolean | Promise<boolean>;
  onStop: () => void;
  attachments: ImageAttachment[];
  onAttachmentsChange: (attachments: ImageAttachment[]) => void;
  onAttachmentError: (message: string) => void;
  /** Current model cannot see images; disables the attach affordances. */
  attachDisabled: boolean;
  /** 扩展 setEditorText 注入的草稿（nonce 变化时替换编辑器内容）。 */
  injectedText?: { text: string; nonce: number };
  /** 用户编辑历史消息时注入的草稿，优先于扩展草稿。 */
  draftInjection?: { text: string; nonce: number };
  /** Exits a historical-message edit and restores the previous composer draft. */
  onCancelEdit?: () => void;
  /** 排队等待投递的用户消息（忙时发送进入该队列）。 */
  queue: SessionQueue;
  /** 全部取回排队消息到编辑器。 */
  onDequeueAll: () => void;
  /** 移除单条排队消息；restore=true 时把文本合并回编辑器草稿。 */
  onRemoveQueued: (messageId: string, restore: boolean) => void;
  /** 切换单条排队消息的投递方式（后续 ↔ 紧急插队）。 */
  onToggleKind: (messageId: string) => void;
  controls?: ReactNode;
  /** 移动端：其他输入框聚焦时收起输入栏（编辑器保持挂载，草稿不丢）。 */
  collapsed?: boolean;
  /** 暴露"聚焦编辑器"的方法，供外部在需要时调用。 */
  focusRequestRef?: RefObject<(() => void) | undefined>;
  /** 桌面端：挂载后自动聚焦输入框（新建会话场景）。 */
  autoFocus?: boolean;
  /** 已消费 autoFocus（完成聚焦）后通知父组件，用于清除标记。 */
  onAutoFocusConsumed?: () => void;
}

export function PromptEditor({ initialValue, draftNonce = 0, busy, commands, searchFiles, searchSessionFiles, onDraftChange, onSubmit, onStop, attachments, onAttachmentsChange, onAttachmentError, attachDisabled, injectedText, draftInjection, onCancelEdit, controls, queue, onDequeueAll, onRemoveQueued, onToggleKind, collapsed = false, focusRequestRef, autoFocus = false, onAutoFocusConsumed }: PromptEditorProps) {
  const isMobile = useIsMobile();
  // 挂载时捕获 autoFocus：视图创建可能比挂载晚一个提交（容器 ref 回调触发
  // 的二次渲染），而 App 可能在被动效果里已清除标记；用 ref 保存挂载快照。
  const autoFocusOnMountRef = useRef(autoFocus);
  const initialValueRef = useRef(initialValue);
  const valueRef = useRef(initialValue);
  const composingRef = useRef(false);
  const pendingExternalDraftRef = useRef<string | undefined>(undefined);
  const appliedDraftNonceRef = useRef(draftNonce);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const busyRef = useRef(busy);
  const submittingRef = useRef(false);
  const searchRequestRef = useRef(0);
  const completionTimerRef = useRef<number | undefined>(undefined);
  const completionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const attachmentsRef = useRef(attachments);
  const injectedTextRef = useRef(injectedText);
  /** 已应用的扩展注入编号：重连/重新水合会重建内容相同、对象身份不同的注入，
      重复应用会把用户后来写进编辑器的内容整体覆盖掉。 */
  const appliedInjectionRef = useRef<number | undefined>(undefined);
  const draftInjectionRef = useRef(draftInjection);
  const commandsRef = useRef(commands);
  const searchFilesRef = useRef(searchFiles);
  const searchSessionFilesRef = useRef(searchSessionFiles);
  const preparingRef = useRef(0);
  const lastAttachOpenRef = useRef(0);
  const [completion, setCompletion] = useState<{ trigger: "/" | "@" | "@@"; from: number; items: Completion[] } | undefined>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preparingCount, setPreparingCount] = useState(0);
  const [hasDraft, setHasDraft] = useState(() => initialValue.trim() !== "");

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

  const applyInjectedText = useCallback((view: EditorView, injection: { text: string; nonce: number } | undefined) => {
    if (injection === undefined) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: injection.text }, selection: { anchor: injection.text.length } });
    view.focus();
  }, []);

  /** 每个 nonce 只注入一次；编辑器重挂载（切换会话）时 ref 会重置，注入会重新生效。 */
  const applyExtensionText = useCallback((view: EditorView, injection: { text: string; nonce: number } | undefined) => {
    if (injection === undefined || appliedInjectionRef.current === injection.nonce) return;
    appliedInjectionRef.current = injection.nonce;
    applyInjectedText(view, injection);
  }, [applyInjectedText]);

  useEffect(() => {
    injectedTextRef.current = injectedText;
    const view = viewRef.current;
    if (view !== undefined) applyExtensionText(view, injectedText);
  }, [applyExtensionText, injectedText]);

  useEffect(() => {
    draftInjectionRef.current = draftInjection;
    const view = viewRef.current;
    if (view !== undefined) applyInjectedText(view, draftInjection);
  }, [applyInjectedText, draftInjection]);

  useEffect(() => {
    completionItemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [completion?.items.length, selectedIndex]);

  // 暴露聚焦方法给 App（新建会话等）。延迟读取 viewRef：早于编辑器创建时调用只是空操作。
  useEffect(() => {
    if (focusRequestRef === undefined) return;
    focusRequestRef.current = () => { viewRef.current?.focus(); };
    return () => { focusRequestRef.current = undefined; };
  }, [focusRequestRef]);

  const closeCompletion = useCallback(() => {
    if (completionTimerRef.current !== undefined) {
      window.clearTimeout(completionTimerRef.current);
      completionTimerRef.current = undefined;
    }
    searchRequestRef.current += 1;
    setCompletion(undefined);
    setSelectedIndex(0);
  }, []);
  useEffect(() => () => {
    if (completionTimerRef.current !== undefined) window.clearTimeout(completionTimerRef.current);
  }, []);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;

  const refreshCompletion = useCallback((view: EditorView) => {
    const context = completionContextFor(view.state.doc.toString(), view.state.selection.main.head);
    if (context === undefined) {
      closeCompletion();
      return;
    }

    if (context.trigger === "/") {
      if (completionTimerRef.current !== undefined) {
        window.clearTimeout(completionTimerRef.current);
        completionTimerRef.current = undefined;
      }
      const items = matchingComposerCommands(commandsRef.current, context.query)
        .map((command) => ({ kind: "command" as const, command }));
      setCompletion(items.length === 0 ? undefined : { trigger: context.trigger, from: context.from, items });
      setSelectedIndex(0);
      return;
    }

    if (completionTimerRef.current !== undefined) window.clearTimeout(completionTimerRef.current);
    completionTimerRef.current = window.setTimeout(() => {
      completionTimerRef.current = undefined;
      const latest = completionContextFor(view.state.doc.toString(), view.state.selection.main.head);
      if (latest === undefined || (latest.trigger !== "@" && latest.trigger !== "@@")) {
        closeCompletion();
        return;
      }
      const request = ++searchRequestRef.current;
      const search = latest.trigger === "@@" ? searchSessionFilesRef.current(latest.query) : searchFilesRef.current(latest.query);
      void search.then((results) => {
        if (request !== searchRequestRef.current) return;
        const items = latest.trigger === "@@"
          ? (results as SessionFileReference[]).slice(0, MAX_COMPOSER_SUGGESTIONS).map((session) => ({ kind: "session" as const, session }))
          : (results as WorkspaceFile[]).slice(0, MAX_COMPOSER_SUGGESTIONS).map((file) => ({ kind: "file" as const, file }));
        setCompletion(items.length === 0 ? undefined : { trigger: latest.trigger, from: latest.from, items });
        setSelectedIndex(0);
      }).catch(() => {
        if (request === searchRequestRef.current) closeCompletion();
      });
    }, COMPLETION_SEARCH_DEBOUNCE_MS);
  }, [closeCompletion]);
  const refreshCompletionRef = useRef(refreshCompletion);
  refreshCompletionRef.current = refreshCompletion;

  // 组字期间仍更新发送按钮（微信输入法语音上屏常带着 input.type.compose，
  // 且 Android EditContext 往往不冒泡 DOM compositionend）。
  // 但不要回写 App、也不刷新补全：父组件重渲染会让 useCodeMirror 重配扩展，
  // Firefox + ibus 会把刚确认的词再提交一次。
  const change = useCallback((next: string, update: ViewUpdate) => {
    valueRef.current = next;
    setHasDraft(next.trim() !== "");
    if (isComposerCompositionPending({
      composing: composingRef.current || update.view.composing,
      composeTransaction: update.transactions.some((transaction) => transaction.isUserEvent("input.type.compose")),
    })) return;
    onDraftChangeRef.current(next);
    refreshCompletionRef.current(update.view);
  }, []);

  const update = useCallback((viewUpdate: ViewUpdate) => {
    if (composingRef.current || viewUpdate.view.composing) return;
    if (!viewUpdate.docChanged && viewUpdate.selectionSet) refreshCompletionRef.current(viewUpdate.view);
  }, []);

  const applyExtensionTextRef = useRef(applyExtensionText);
  applyExtensionTextRef.current = applyExtensionText;
  const applyInjectedTextRef = useRef(applyInjectedText);
  applyInjectedTextRef.current = applyInjectedText;
  const onAutoFocusConsumedRef = useRef(onAutoFocusConsumed);
  onAutoFocusConsumedRef.current = onAutoFocusConsumed;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const createEditor = useCallback((view: EditorView) => {
    viewRef.current = view;
    const initial = initialValueRef.current;
    if (initial !== "") view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initial } });
    applyExtensionTextRef.current(view, injectedTextRef.current);
    applyInjectedTextRef.current(view, draftInjectionRef.current);
    refreshCompletionRef.current(view);
    // 新建会话后自动聚焦（移动端聚焦会弹出键盘，忽略）。
    if (autoFocusOnMountRef.current && !isMobileRef.current) {
      view.focus();
      onAutoFocusConsumedRef.current?.();
    }
  }, []);

  // 只有 App 显式改草稿（draftNonce 递增：取回排队、停止恢复）才写回编辑器。
  // 普通打字回环和 IME 组字绝不能写文档：Firefox + ibus 会把刚确认的词再提交一次。
  const applyExternalDraft = useCallback((view: EditorView, incoming: string) => {
    pendingExternalDraftRef.current = undefined;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: incoming }, selection: { anchor: incoming.length } });
    valueRef.current = incoming;
    setHasDraft(incoming.trim() !== "");
    view.focus();
  }, []);

  const syncDraftFromApp = useCallback((view: EditorView, incoming: string, nonceChanged: boolean, force = false) => {
    const action = composerDraftSyncAction({
      nonceChanged,
      current: view.state.doc.toString(),
      incoming,
      composing: !force && (composingRef.current || view.composing),
    });
    if (action === "defer") {
      pendingExternalDraftRef.current = incoming;
      return;
    }
    if (action === "skip") {
      if (force) pendingExternalDraftRef.current = undefined;
      return;
    }
    applyExternalDraft(view, incoming);
  }, [applyExternalDraft]);

  useEffect(() => {
    initialValueRef.current = initialValue;
    const view = viewRef.current;
    if (view === undefined) return;
    const nonceChanged = appliedDraftNonceRef.current !== draftNonce;
    appliedDraftNonceRef.current = draftNonce;
    syncDraftFromApp(view, initialValue, nonceChanged);
  }, [draftNonce, initialValue, syncDraftFromApp]);

  // Command resources arrive asynchronously. Re-run completion against the
  // current document even when the user has not typed another character.
  useEffect(() => {
    commandsRef.current = commands;
    const view = viewRef.current;
    if (view === undefined || composingRef.current || view.composing) return;
    refreshCompletion(view);
  }, [commands, refreshCompletion]);

  useEffect(() => { searchFilesRef.current = searchFiles; }, [searchFiles]);
  useEffect(() => { searchSessionFilesRef.current = searchSessionFiles; }, [searchSessionFiles]);

  const handleFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    preparingRef.current += files.length;
    setPreparingCount(preparingRef.current);
    void Promise.all(files.map((file) => prepareImage(file)
      .then((attachment) => ({ ok: true as const, attachment }))
      .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "图片处理失败" }))))
      .then((results) => {
        preparingRef.current -= files.length;
        setPreparingCount(preparingRef.current);
        const prepared = results.filter((result): result is { ok: true; attachment: ImageAttachment } => result.ok).map((result) => result.attachment);
        const failures = results.filter((result): result is { ok: false; message: string } => !result.ok).map((result) => result.message);
        if (prepared.length > 0) onAttachmentsChange([...attachmentsRef.current, ...prepared]);
        if (failures.length > 0) onAttachmentError(failures.join("；"));
      });
  }, [onAttachmentError, onAttachmentsChange]);

  const handleFilesRef = useRef(handleFiles);
  useEffect(() => { handleFilesRef.current = handleFiles; }, [handleFiles]);
  const syncDraftFromAppRef = useRef(syncDraftFromApp);
  useEffect(() => { syncDraftFromAppRef.current = syncDraftFromApp; }, [syncDraftFromApp]);
  const flushComposerDraftFromView = useCallback((syncApp: boolean) => {
    const view = viewRef.current;
    if (view === undefined) return;
    const next = view.state.doc.toString();
    valueRef.current = next;
    setHasDraft(next.trim() !== "");
    if (syncApp) onDraftChangeRef.current(next);
  }, []);
  const flushComposerDraftFromViewRef = useRef(flushComposerDraftFromView);
  flushComposerDraftFromViewRef.current = flushComposerDraftFromView;

  // Created once with an empty dependency list: handlers read the latest
  // callbacks through refs so the extensions array stays referentially
  // stable and useCodeMirror never reconfigures the editor mid-typing.
  const pasteExtension = useMemo(() => CodeMirrorView.domEventHandlers({
    pointerdown: () => {
      unlockVisualViewportKeyboardInset();
      return false;
    },
    paste: (event) => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return false;
      event.preventDefault();
      handleFilesRef.current(files);
      return true;
    },
    compositionstart: () => {
      composingRef.current = true;
      return false;
    },
    compositionupdate: () => {
      composingRef.current = true;
      return false;
    },
    compositionend: () => {
      composingRef.current = false;
      const view = viewRef.current;
      if (view === undefined) return false;
      const pending = pendingExternalDraftRef.current;
      // compositionend 时 view.composing 可能还没清掉；只刷真正的外部草稿。
      if (pending !== undefined) {
        syncDraftFromAppRef.current(view, pending, true, true);
        return false;
      }
      // Android Chrome 会把上屏推迟到下一帧 flush；立即读文档可能仍是组字前的内容。
      requestAnimationFrame(() => {
        if (composingRef.current) return;
        const current = viewRef.current;
        if (current === undefined) return;
        flushComposerDraftFromViewRef.current(!current.composing);
      });
      return false;
    },
    // 语音上屏有时只打 input、不走 onChange。只允许点亮发送，避免读到尚未 flush 的空文档把按钮又关掉。
    input: () => {
      requestAnimationFrame(() => {
        const current = viewRef.current;
        if (current === undefined) return;
        if (current.state.doc.toString().trim() !== "") setHasDraft(true);
      });
      return false;
    },
  }), []);
  const extensions = useMemo(() => [...editorExtensions, pasteExtension], [pasteExtension]);

  const { setContainer } = useCodeMirror({
    value: undefined,
    onChange: change,
    onUpdate: update,
    onCreateEditor: createEditor,
    minHeight: "76px",
    maxHeight: "220px",
    theme: "none",
    basicSetup,
    extensions,
  });

  const attachContainer = useCallback((element: HTMLDivElement | null) => setContainer(element), [setContainer]);

  const submit = useCallback(async (behavior?: "steer" | "followUp") => {
    if (submittingRef.current) return;
    const text = viewRef.current?.state.doc.toString() ?? valueRef.current;
    if (text.trim() === "" && attachmentsRef.current.length === 0) return;
    submittingRef.current = true;
    try {
      const submitted = await onSubmit(text, attachmentsRef.current, behavior);
      if (!submitted) return;
      closeCompletion();
      const view = viewRef.current;
      if (view === undefined) {
        valueRef.current = "";
        onDraftChange("");
      } else {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
      }
      setHasDraft(false);
      onAttachmentsChange([]);
    } finally {
      submittingRef.current = false;
    }
  }, [closeCompletion, onAttachmentsChange, onDraftChange, onSubmit]);

  const applyCompletion = useCallback((item: Completion) => {
    const view = viewRef.current;
    if (view === undefined) return;
    const value = view.state.doc.toString();
    const context = completionContextFor(value, view.state.selection.main.head);
    const trigger = item.kind === "command" ? "/" : item.kind === "session" ? "@@" : "@";
    if (context === undefined || context.trigger !== trigger) {
      closeCompletion();
      return;
    }
    const replacement = completionReplacement(value, context, item.kind === "command" ? `/${item.command.name}` : item.kind === "session" ? `@${quoteFileReference(item.session.path)}` : `@${item.file.path}`);
    view.dispatch({ changes: { from: replacement.from, to: replacement.to, insert: replacement.insert }, selection: { anchor: replacement.cursor } });
    view.focus();
    closeCompletion();
  }, [closeCompletion]);

  const completionItems = completion?.items ?? [];
  const completionLabel = useMemo(() => completion?.trigger === "/" ? "命令" : completion?.trigger === "@@" ? "会话" : "文件", [completion?.trigger]);
  const canSend = hasDraft || attachments.length > 0;
  const removeAttachment = (index: number) => {
    onAttachmentsChange(attachments.filter((_, current) => current !== index));
  };

  return (
    <section className={`composer${collapsed ? " composer-collapsed" : ""}`} aria-label="消息输入框">
      <div className="composer-editor">
        {attachments.length === 0 && preparingCount === 0 ? null : <div className="composer-attachments">
          {attachments.map((attachment, index) => (
            <div className="composer-attachment" key={`${attachment.mimeType}:${index}`}>
              <ImagePreview key={`${attachment.mimeType}:${index}`} src={imageDataUrl(attachment)} alt={`图片 ${String(index + 1)}`}><button type="button" className="composer-attachment-preview" aria-label={`预览图片 ${String(index + 1)}`}><img src={imageDataUrl(attachment)} alt={`附件 ${String(index + 1)}`} /></button></ImagePreview>
              <button type="button" className="composer-attachment-remove" aria-label="移除图片" onClick={() => { removeAttachment(index); }}><X size={10} /></button>
            </div>
          ))}
          {preparingCount === 0 ? null : <div className="composer-attachment preparing" aria-label="正在处理图片"><LoaderCircle className="spin" size={16} /></div>}
        </div>}
        <QueueBar queue={queue} onDequeueAll={onDequeueAll} onRemoveQueued={onRemoveQueued} onToggleKind={onToggleKind} />
        <div className="composer-code-editor" ref={attachContainer} onKeyDownCapture={(event) => {
          if (completionItems.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedIndex((current) => (current + 1) % completionItems.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedIndex((current) => (current - 1 + completionItems.length) % completionItems.length);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              closeCompletion();
              return;
            }
            if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              applyCompletion(completionItems[selectedIndex] ?? completionItems[0]!);
              return;
            }
          }
          // Phone keyboards use Enter to insert a newline. On mobile, only an
          // explicit Ctrl/Cmd+Enter shortcut submits; the send button is primary.
          // Busy 时 Enter 排队为后续消息（默认行为，可到排队条改插队）。
          const explicitSubmit = (event.ctrlKey || event.metaKey) && event.key === "Enter";
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || submittingRef.current || (isMobile && !explicitSubmit)) return;
          if ((viewRef.current?.state.doc.toString() ?? valueRef.current).trim() === "" && attachmentsRef.current.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }} />
        {completionItems.length === 0 ? null : <div className="composer-completions" role="listbox" aria-label={completionLabel}>
          {completionItems.map((item, index) => <button ref={(element) => { completionItemRefs.current[index] = element; }} key={item.kind === "command" ? item.command.name : item.kind === "file" ? item.file.path : item.session.id} className={`composer-completion ${index === selectedIndex ? "selected" : ""}`} type="button" role="option" aria-selected={index === selectedIndex} onMouseDown={(event) => { event.preventDefault(); applyCompletion(item); }}>
            {item.kind === "command" ? <Command size={15} /> : item.kind === "session" ? <History size={15} /> : <FileCode2 size={15} />}
            <span><strong>{item.kind === "command" ? `/${item.command.name}` : item.kind === "session" ? item.session.name ?? item.session.preview ?? "新会话" : item.file.path}</strong>{item.kind === "command" && item.command.description !== undefined ? <small>{item.command.description}</small> : item.kind === "session" && item.session.preview !== null && item.session.preview !== item.session.name ? <small>{item.session.preview}</small> : null}</span>
          </button>)}
        </div>}
        <div className="composer-footer">
          <div className="composer-options">
            <div className={`button button-ghost button-icon composer-attach${attachDisabled ? " composer-attach-disabled" : ""}`}>
              <input className="composer-file-input" type="file" accept="image/*" multiple disabled={attachDisabled} aria-label={attachDisabled ? "当前模型不支持图片" : "添加图片"} onClick={(event) => {
                const now = Date.now();
                if (now - lastAttachOpenRef.current < 800) {
                  event.preventDefault();
                  return;
                }
                lastAttachOpenRef.current = now;
                lockVisualViewportKeyboardInset();
                viewRef.current?.contentDOM.blur();
              }} onChange={(event) => {
                lastAttachOpenRef.current = Date.now();
                const input = event.currentTarget;
                const files = Array.from(input.files ?? []);
                handleFiles(files);
                lockVisualViewportKeyboardInset();
                blurAfterAttach(input, viewRef.current);
                window.setTimeout(() => {
                  input.value = "";
                  blurAfterAttach(input, viewRef.current);
                }, 0);
              }} />
              <Plus size={16} />
            </div>
            {controls}
          </div>
          <div className="composer-actions">
            {onCancelEdit === undefined ? null : <Tooltip label="取消编辑"><Button variant="ghost" className="composer-cancel-edit" size="icon" aria-label="取消编辑" onClick={onCancelEdit}><X size={15} /></Button></Tooltip>}
            {canSend ? (
              <Tooltip label={busy ? "排队为后续消息" : "发送消息"}>
                <Button className="composer-send" size="icon" aria-label={busy ? "排队为后续消息" : "发送消息"} onClick={() => { void submit(); }}><ArrowUp size={17} /></Button>
              </Tooltip>
            ) : busy ? (
              <Tooltip label="停止当前执行"><Button className="composer-stop" size="icon" aria-label="停止当前执行" onClick={onStop}><Square size={14} fill="currentColor" /></Button></Tooltip>
            ) : (
              <Tooltip label="发送消息"><Button className="composer-send" size="icon" aria-label="发送消息" disabled><ArrowUp size={17} /></Button></Tooltip>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function blurAfterAttach(input: HTMLInputElement, view: EditorView | undefined) {
  input.blur();
  view?.contentDOM.blur();
}

function quoteFileReference(path: string): string {
  return /\s/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path;
}

function QueueBar({ queue, onDequeueAll, onRemoveQueued, onToggleKind }: { queue: SessionQueue; onDequeueAll: () => void; onRemoveQueued: (messageId: string, restore: boolean) => void; onToggleKind: (messageId: string) => void }) {
  const messages = [...queue.steering, ...queue.followUp];
  if (messages.length === 0) return null;
  const preview = (message: QueuedMessage) => {
    const singleLine = message.text.replace(/\s+/g, " ").trim();
    return singleLine.length > 64 ? `${singleLine.slice(0, 64)}…` : singleLine;
  };
  return (
    <div className="composer-queue" aria-label="排队消息">
      {messages.map((message) => <div className={`composer-queue-item ${message.kind === "followUp" ? "followup" : "steer"}`} key={message.id}>
        <span className="composer-queue-kind">{message.kind === "followUp" ? "后续" : "插队"}</span>
        <span className="composer-queue-text" title={message.text}>{preview(message)}</span>
        <span className="composer-queue-actions">
          <Tooltip label="撤回编辑"><button type="button" className="composer-queue-action" aria-label="撤回编辑" onClick={() => { onRemoveQueued(message.id, true); }}><RotateCcw size={12} /></button></Tooltip>
          <Tooltip label={message.kind === "followUp" ? "设为紧急" : "取消紧急"}>
            <button type="button" className={`composer-queue-action${message.kind === "steer" ? " urgent" : ""}`} aria-label={message.kind === "followUp" ? "设为紧急" : "取消紧急"} onClick={() => { onToggleKind(message.id); }}><Zap size={12} /></button>
          </Tooltip>
          <Tooltip label="删除此排队消息"><button type="button" className="composer-queue-action" aria-label="删除此消息" onClick={() => { onRemoveQueued(message.id, false); }}><X size={12} /></button></Tooltip>
        </span>
      </div>)}
      <Tooltip label="全部取回到编辑器"><button type="button" className="composer-queue-restore" aria-label="全部取回" onClick={onDequeueAll}><RotateCcw size={13} />全部取回</button></Tooltip>
    </div>
  );
}
