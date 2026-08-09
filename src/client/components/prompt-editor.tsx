import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { type BasicSetupOptions, type EditorView, type Extension, useCodeMirror } from "@uiw/react-codemirror";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

const basicSetup: BasicSetupOptions = { lineNumbers: false, foldGutter: false, highlightActiveLine: false };
const editorExtensions: Extension[] = [];

interface PromptEditorProps {
  initialValue: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => boolean | Promise<boolean>;
  onStop: () => void;
  controls?: ReactNode;
}

export function PromptEditor({ initialValue, busy, onDraftChange, onSubmit, onStop, controls }: PromptEditorProps) {
  const initialValueRef = useRef(initialValue);
  const valueRef = useRef(initialValue);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const busyRef = useRef(busy);
  const submittingRef = useRef(false);

  useEffect(() => { busyRef.current = busy; }, [busy]);

  const change = useCallback((next: string) => {
    valueRef.current = next;
    onDraftChange(next);
  }, [onDraftChange]);

  const createEditor = useCallback((view: EditorView) => {
    viewRef.current = view;
    const initial = initialValueRef.current;
    if (initial !== "") view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initial } });
  }, []);

  const { setContainer } = useCodeMirror({
    value: undefined,
    onChange: change,
    onCreateEditor: createEditor,
    minHeight: "102px",
    maxHeight: "220px",
    theme: "dark",
    basicSetup,
    extensions: editorExtensions,
    placeholder: "Ask for follow-up changes",
  });

  const attachContainer = useCallback((element: HTMLDivElement | null) => setContainer(element), [setContainer]);

  const submit = useCallback(async () => {
    if (busyRef.current || submittingRef.current || valueRef.current.trim() === "") return;
    submittingRef.current = true;
    try {
      const submitted = await onSubmit(valueRef.current);
      if (!submitted) return;
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
  }, [onDraftChange, onSubmit]);

  return (
    <section className="composer" aria-label="Message composer">
      <div className="composer-editor">
        <div className="composer-code-editor" ref={attachContainer} onKeyDownCapture={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || busyRef.current || submittingRef.current || valueRef.current.trim() === "") return;
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }} />
        <div className="composer-footer">
          <div className="composer-options">{controls}</div>
          {busy ? (
            <Tooltip label="Stop current run"><Button className="composer-stop" size="icon" aria-label="Stop current run" onClick={onStop}><Square size={14} fill="currentColor" /></Button></Tooltip>
          ) : (
            <Tooltip label="Send message"><Button className="composer-send" size="icon" aria-label="Send message" onClick={() => { void submit(); }} disabled={initialValue.trim() === ""}><ArrowUp size={17} /></Button></Tooltip>
          )}
        </div>
      </div>
    </section>
  );
}
