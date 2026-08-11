import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type BasicSetupOptions, type EditorView, type Extension, type ViewUpdate, useCodeMirror } from "@uiw/react-codemirror";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { ArrowUp, Command, FileCode2, LoaderCircle, Plus, Puzzle, Square, X, XCircle } from "lucide-react";
import type { ComposerCommand, ImageAttachment, WorkspaceFile } from "../../shared/protocol";
import { completionContextFor, completionReplacement, matchingComposerCommands, MAX_COMPOSER_SUGGESTIONS } from "../composer-completion";
import { imageDataUrl, MAX_ATTACHMENTS, prepareImage } from "../lib/image";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const basicSetup: BasicSetupOptions = { lineNumbers: false, foldGutter: false, highlightActiveLine: false };
// Module-level so the array identity never changes; a new identity per render
// would make useCodeMirror reconfigure (and effectively reset) the editor.
const editorExtensions: Extension[] = [CodeMirrorView.lineWrapping];

type Completion =
  | { kind: "command"; command: ComposerCommand }
  | { kind: "file"; file: WorkspaceFile };

interface PromptEditorProps {
  initialValue: string;
  busy: boolean;
  commands: ComposerCommand[];
  searchFiles: (query: string) => Promise<WorkspaceFile[]>;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string, attachments: ImageAttachment[]) => boolean | Promise<boolean>;
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
  /** Lightweight extension status labels shown inside the composer chrome. */
  extensionStatuses?: Record<string, string>;
  controls?: ReactNode;
}

export function PromptEditor({ initialValue, busy, commands, searchFiles, onDraftChange, onSubmit, onStop, attachments, onAttachmentsChange, onAttachmentError, attachDisabled, injectedText, draftInjection, onCancelEdit, extensionStatuses = {}, controls }: PromptEditorProps) {
  const initialValueRef = useRef(initialValue);
  const valueRef = useRef(initialValue);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const busyRef = useRef(busy);
  const submittingRef = useRef(false);
  const searchRequestRef = useRef(0);
  const completionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const attachmentsRef = useRef(attachments);
  const injectedTextRef = useRef(injectedText);
  const draftInjectionRef = useRef(draftInjection);
  const commandsRef = useRef(commands);
  const searchFilesRef = useRef(searchFiles);
  const preparingRef = useRef(0);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const [completion, setCompletion] = useState<{ trigger: "/" | "@"; from: number; items: Completion[] } | undefined>();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preparingCount, setPreparingCount] = useState(0);
  const [hasDraft, setHasDraft] = useState(() => initialValue.trim() !== "");
  const [previewIndex, setPreviewIndex] = useState<number>();
  const preview = previewIndex === undefined ? undefined : attachments[previewIndex];

  useEffect(() => { busyRef.current = busy; }, [busy]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

  const applyInjectedText = useCallback((view: EditorView, injection: { text: string; nonce: number } | undefined) => {
    if (injection === undefined) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: injection.text }, selection: { anchor: injection.text.length } });
    view.focus();
  }, []);

  useEffect(() => {
    injectedTextRef.current = injectedText;
    const view = viewRef.current;
    if (view !== undefined) applyInjectedText(view, injectedText);
  }, [applyInjectedText, injectedText]);

  useEffect(() => {
    draftInjectionRef.current = draftInjection;
    const view = viewRef.current;
    if (view !== undefined) applyInjectedText(view, draftInjection);
  }, [applyInjectedText, draftInjection]);

  useEffect(() => {
    completionItemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [completion?.items.length, selectedIndex]);

  const closeCompletion = useCallback(() => {
    searchRequestRef.current += 1;
    setCompletion(undefined);
    setSelectedIndex(0);
  }, []);

  const refreshCompletion = useCallback((view: EditorView) => {
    const context = completionContextFor(view.state.doc.toString(), view.state.selection.main.head);
    if (context === undefined) {
      closeCompletion();
      return;
    }

    const request = ++searchRequestRef.current;
    if (context.trigger === "/") {
      const items = matchingComposerCommands(commandsRef.current, context.query)
        .map((command) => ({ kind: "command" as const, command }));
      setCompletion(items.length === 0 ? undefined : { trigger: context.trigger, from: context.from, items });
      setSelectedIndex(0);
      return;
    }

    void searchFilesRef.current(context.query).then((files) => {
      if (request !== searchRequestRef.current) return;
      const items = files.slice(0, MAX_COMPOSER_SUGGESTIONS).map((file) => ({ kind: "file" as const, file }));
      setCompletion(items.length === 0 ? undefined : { trigger: context.trigger, from: context.from, items });
      setSelectedIndex(0);
    }).catch(() => {
      if (request === searchRequestRef.current) closeCompletion();
    });
  }, [closeCompletion]);

  const change = useCallback((next: string, update: ViewUpdate) => {
    valueRef.current = next;
    setHasDraft(next.trim() !== "");
    onDraftChange(next);
    refreshCompletion(update.view);
  }, [onDraftChange, refreshCompletion]);

  const update = useCallback((viewUpdate: ViewUpdate) => {
    if (!viewUpdate.docChanged && viewUpdate.selectionSet) refreshCompletion(viewUpdate.view);
  }, [refreshCompletion]);

  const createEditor = useCallback((view: EditorView) => {
    viewRef.current = view;
    const initial = initialValueRef.current;
    if (initial !== "") view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initial } });
    applyInjectedText(view, injectedTextRef.current);
    applyInjectedText(view, draftInjectionRef.current);
    refreshCompletion(view);
  }, [applyInjectedText, refreshCompletion]);

  // Command resources arrive asynchronously. Re-run completion against the
  // current document even when the user has not typed another character.
  useEffect(() => {
    commandsRef.current = commands;
    const view = viewRef.current;
    if (view !== undefined) refreshCompletion(view);
  }, [commands, refreshCompletion]);

  useEffect(() => { searchFilesRef.current = searchFiles; }, [searchFiles]);

  const handleFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    const remaining = MAX_ATTACHMENTS - attachmentsRef.current.length - preparingRef.current;
    if (remaining <= 0) {
      onAttachmentError(`一条消息最多附带 ${String(MAX_ATTACHMENTS)} 张图片`);
      return;
    }
    const accepted = files.slice(0, remaining);
    if (accepted.length < files.length) onAttachmentError(`一条消息最多附带 ${String(MAX_ATTACHMENTS)} 张图片`);
    preparingRef.current += accepted.length;
    setPreparingCount(preparingRef.current);
    void Promise.all(accepted.map((file) => prepareImage(file)
      .then((attachment) => ({ ok: true as const, attachment }))
      .catch((error: unknown) => ({ ok: false as const, message: error instanceof Error ? error.message : "图片处理失败" }))))
      .then((results) => {
        preparingRef.current -= accepted.length;
        setPreparingCount(preparingRef.current);
        const prepared = results.filter((result): result is { ok: true; attachment: ImageAttachment } => result.ok).map((result) => result.attachment);
        const failures = results.filter((result): result is { ok: false; message: string } => !result.ok).map((result) => result.message);
        if (prepared.length > 0) onAttachmentsChange([...attachmentsRef.current, ...prepared]);
        if (failures.length > 0) onAttachmentError(failures.join("；"));
      });
  }, [onAttachmentError, onAttachmentsChange]);

  const handleFilesRef = useRef(handleFiles);
  useEffect(() => { handleFilesRef.current = handleFiles; }, [handleFiles]);

  // Created once with an empty dependency list: the handler reads the latest
  // handleFiles through a ref so the paste extension stays referentially
  // stable and useCodeMirror never reconfigures the editor mid-typing.
  const pasteExtension = useMemo(() => CodeMirrorView.domEventHandlers({
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
  }), []);
  const extensions = useMemo(() => [...editorExtensions, pasteExtension], [pasteExtension]);

  const { setContainer } = useCodeMirror({
    value: undefined,
    onChange: change,
    onUpdate: update,
    onCreateEditor: createEditor,
    minHeight: "76px",
    maxHeight: "220px",
    theme: "dark",
    basicSetup,
    extensions,
    placeholder: "输入后续需求",
  });

  const attachContainer = useCallback((element: HTMLDivElement | null) => setContainer(element), [setContainer]);

  const submit = useCallback(async () => {
    if (busyRef.current || submittingRef.current) return;
    if (valueRef.current.trim() === "" && attachmentsRef.current.length === 0) return;
    submittingRef.current = true;
    try {
      const submitted = await onSubmit(valueRef.current, attachmentsRef.current);
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
    const trigger = item.kind === "command" ? "/" : "@";
    if (context === undefined || context.trigger !== trigger) {
      closeCompletion();
      return;
    }
    const replacement = completionReplacement(value, context, item.kind === "command" ? `/${item.command.name}` : `@${item.file.path}`);
    view.dispatch({ changes: { from: replacement.from, to: replacement.to, insert: replacement.insert }, selection: { anchor: replacement.cursor } });
    view.focus();
    closeCompletion();
  }, [closeCompletion]);

  const completionItems = completion?.items ?? [];
  const completionLabel = useMemo(() => completion?.trigger === "/" ? "命令" : "文件", [completion?.trigger]);
  const canSend = hasDraft || attachments.length > 0;
  const openAttach = () => {
    if (attachDisabled) return;
    galleryRef.current?.click();
  };
  const removeAttachment = (index: number) => {
    onAttachmentsChange(attachments.filter((_, current) => current !== index));
  };

  return (
    <section className="composer" aria-label="消息输入框">
      <div className="composer-editor">
        {attachments.length === 0 && preparingCount === 0 ? null : <div className="composer-attachments">
          {attachments.map((attachment, index) => (
            <div className="composer-attachment" key={`${attachment.mimeType}:${index}`}>
              <button type="button" className="composer-attachment-preview" aria-label={`预览图片 ${index + 1}`} onClick={() => { setPreviewIndex(index); }}><img src={imageDataUrl(attachment)} alt={`附件 ${index + 1}`} /></button>
              <button type="button" className="composer-attachment-remove" aria-label="移除图片" onClick={() => { removeAttachment(index); }}><X size={10} /></button>
            </div>
          ))}
          {preparingCount === 0 ? null : <div className="composer-attachment preparing" aria-label="正在处理图片"><LoaderCircle className="spin" size={16} /></div>}
        </div>}
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
            if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              applyCompletion(completionItems[selectedIndex] ?? completionItems[0]!);
              return;
            }
          }
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || busyRef.current || submittingRef.current) return;
          if (valueRef.current.trim() === "" && attachmentsRef.current.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }} />
        {completionItems.length === 0 ? null : <div className="composer-completions" role="listbox" aria-label={completionLabel}>
          {completionItems.map((item, index) => <button ref={(element) => { completionItemRefs.current[index] = element; }} key={item.kind === "command" ? item.command.name : item.file.path} className={`composer-completion ${index === selectedIndex ? "selected" : ""}`} type="button" role="option" aria-selected={index === selectedIndex} onMouseDown={(event) => { event.preventDefault(); applyCompletion(item); }}>
            {item.kind === "command" ? <Command size={15} /> : <FileCode2 size={15} />}
            <span><strong>{item.kind === "command" ? `/${item.command.name}` : item.file.path}</strong>{item.kind === "command" && item.command.description !== undefined ? <small>{item.command.description}</small> : null}</span>
          </button>)}
        </div>}
        <div className="composer-footer">
          <div className="composer-options">
            <Tooltip label={attachDisabled ? "当前模型不支持图片" : "添加图片（支持 Ctrl+V 粘贴）"}>
              <Button variant="ghost" className="composer-attach" size="icon" aria-label="添加图片" disabled={attachDisabled} onClick={openAttach}><Plus size={16} /></Button>
            </Tooltip>
            {controls}
          </div>
          {Object.entries(extensionStatuses).length === 0 ? null : <div className="composer-extension-statuses" aria-label="扩展状态">
            {Object.entries(extensionStatuses).map(([key, text]) => <span className="composer-extension-status" key={key} title={key}><Puzzle size={11} /><span>{text}</span></span>)}
          </div>}
          {onCancelEdit === undefined ? null : <Tooltip label="取消编辑"><Button variant="ghost" className="composer-cancel-edit" size="icon" aria-label="取消编辑" onClick={onCancelEdit}><X size={15} /></Button></Tooltip>}
          {busy ? (
            <Tooltip label="停止当前执行"><Button className="composer-stop" size="icon" aria-label="停止当前执行" onClick={onStop}><Square size={14} fill="currentColor" /></Button></Tooltip>
          ) : (
            <Tooltip label="发送消息"><Button className="composer-send" size="icon" aria-label="发送消息" onClick={() => { void submit(); }} disabled={!canSend}><ArrowUp size={17} /></Button></Tooltip>
          )}
        </div>
      </div>
      <input ref={galleryRef} className="composer-file-input" type="file" accept="image/*" multiple onChange={(event) => { handleFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      {preview === undefined ? null : <div className="image-lightbox" role="dialog" aria-label={`预览图片 ${previewIndex! + 1}`} onClick={() => setPreviewIndex(undefined)}>
        <button type="button" className="image-lightbox-close" aria-label="关闭图片预览" onClick={() => setPreviewIndex(undefined)}><XCircle size={20} /></button>
        <img src={imageDataUrl(preview)} alt={`图片 ${previewIndex! + 1}`} onClick={(event) => event.stopPropagation()} />
      </div>}
    </section>
  );
}
