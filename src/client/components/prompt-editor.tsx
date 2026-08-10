import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { type BasicSetupOptions, type EditorView, type Extension, type ViewUpdate, useCodeMirror } from "@uiw/react-codemirror";
import { ArrowUp, Command, FileCode2, Square } from "lucide-react";
import type { ComposerCommand, WorkspaceFile } from "../../shared/protocol";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const basicSetup: BasicSetupOptions = { lineNumbers: false, foldGutter: false, highlightActiveLine: false };
const editorExtensions: Extension[] = [];
const MAX_SUGGESTIONS = 8;

type Completion =
  | { kind: "command"; command: ComposerCommand }
  | { kind: "file"; file: WorkspaceFile };

interface PromptEditorProps {
  initialValue: string;
  busy: boolean;
  commands: ComposerCommand[];
  searchFiles: (query: string) => Promise<WorkspaceFile[]>;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => boolean | Promise<boolean>;
  onStop: () => void;
  controls?: ReactNode;
}

export function PromptEditor({ initialValue, busy, commands, searchFiles, onDraftChange, onSubmit, onStop, controls }: PromptEditorProps) {
  const initialValueRef = useRef(initialValue);
  const valueRef = useRef(initialValue);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const busyRef = useRef(busy);
  const submittingRef = useRef(false);
  const searchRequestRef = useRef(0);
  const completionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [completion, setCompletion] = useState<{ trigger: "/" | "@"; from: number; items: Completion[] } | undefined>();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    completionItemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [completion?.items.length, selectedIndex]);

  const closeCompletion = useCallback(() => {
    searchRequestRef.current += 1;
    setCompletion(undefined);
    setSelectedIndex(0);
  }, []);

  const change = useCallback((next: string, update: ViewUpdate) => {
    valueRef.current = next;
    onDraftChange(next);
    const cursor = update.view.state.selection.main.head;
    const match = /(?:^|\s)([/@])([^\s]*)$/.exec(next.slice(0, cursor));
    if (match === null || match.index === undefined) {
      closeCompletion();
      return;
    }

    const trigger = match[1] as "/" | "@";
    const query = match[2] ?? "";
    const from = cursor - query.length - 1;
    const request = ++searchRequestRef.current;
    if (trigger === "/") {
      const normalized = query.toLocaleLowerCase();
      const items = commands
        .filter((command) => command.name.toLocaleLowerCase().includes(normalized) || command.description?.toLocaleLowerCase().includes(normalized))
        .slice(0, MAX_SUGGESTIONS)
        .map((command) => ({ kind: "command" as const, command }));
      setCompletion(items.length === 0 ? undefined : { trigger, from, items });
      setSelectedIndex(0);
      return;
    }

    void searchFiles(query).then((files) => {
      if (request !== searchRequestRef.current) return;
      const items = files.slice(0, MAX_SUGGESTIONS).map((file) => ({ kind: "file" as const, file }));
      setCompletion(items.length === 0 ? undefined : { trigger, from, items });
      setSelectedIndex(0);
    }).catch(() => {
      if (request === searchRequestRef.current) closeCompletion();
    });
  }, [closeCompletion, commands, onDraftChange, searchFiles]);

  const createEditor = useCallback((view: EditorView) => {
    viewRef.current = view;
    const initial = initialValueRef.current;
    if (initial !== "") view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initial } });
  }, []);

  const { setContainer } = useCodeMirror({
    value: undefined,
    onChange: change,
    onCreateEditor: createEditor,
    minHeight: "76px",
    maxHeight: "220px",
    theme: "dark",
    basicSetup,
    extensions: editorExtensions,
    placeholder: "输入后续需求",
  });

  const attachContainer = useCallback((element: HTMLDivElement | null) => setContainer(element), [setContainer]);

  const submit = useCallback(async () => {
    if (busyRef.current || submittingRef.current || valueRef.current.trim() === "") return;
    submittingRef.current = true;
    try {
      const submitted = await onSubmit(valueRef.current);
      if (!submitted) return;
      closeCompletion();
      const view = viewRef.current;
      if (view === undefined) {
        valueRef.current = "";
        onDraftChange("");
      } else {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
      }
    } finally {
      submittingRef.current = false;
    }
  }, [closeCompletion, onDraftChange, onSubmit]);

  const applyCompletion = useCallback((item: Completion) => {
    const view = viewRef.current;
    const current = completion;
    if (view === undefined || current === undefined) return;
    const insert = item.kind === "command" ? `/${item.command.name} ` : `@${item.file.path} `;
    const cursor = view.state.selection.main.head;
    view.dispatch({ changes: { from: current.from, to: cursor, insert }, selection: { anchor: current.from + insert.length } });
    view.focus();
    closeCompletion();
  }, [closeCompletion, completion]);

  const completionItems = completion?.items ?? [];
  const completionLabel = useMemo(() => completion?.trigger === "/" ? "命令" : "文件", [completion?.trigger]);

  return (
    <section className="composer" aria-label="消息输入框">
      <div className="composer-editor">
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
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || busyRef.current || submittingRef.current || valueRef.current.trim() === "") return;
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
          <div className="composer-options">{controls}</div>
          {busy ? (
            <Tooltip label="停止当前执行"><Button className="composer-stop" size="icon" aria-label="停止当前执行" onClick={onStop}><Square size={14} fill="currentColor" /></Button></Tooltip>
          ) : (
            <Tooltip label="发送消息"><Button className="composer-send" size="icon" aria-label="发送消息" onClick={() => { void submit(); }} disabled={initialValue.trim() === ""}><ArrowUp size={17} /></Button></Tooltip>
          )}
        </div>
      </div>
    </section>
  );
}
