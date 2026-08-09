import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

interface PromptEditorProps {
  sessionId: string;
  initialValue: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => boolean | Promise<boolean>;
  onStop: () => void;
  controls?: ReactNode;
}

export function PromptEditor({ sessionId, initialValue, busy, onDraftChange, onSubmit, onStop, controls }: PromptEditorProps) {
  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(initialValue);
  const busyRef = useRef(busy);
  const submittingRef = useRef(false);

  useEffect(() => { setValue(initialValue); valueRef.current = initialValue; }, [sessionId, initialValue]);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  const change = useCallback((next: string) => {
    valueRef.current = next;
    setValue(next);
    onDraftChange(next);
  }, [onDraftChange]);

  const submit = useCallback(async () => {
    if (busyRef.current || submittingRef.current || valueRef.current.trim() === "") return;
    submittingRef.current = true;
    try {
      const submitted = await onSubmit(valueRef.current);
      if (submitted) change("");
    } finally {
      submittingRef.current = false;
    }
  }, [change, onSubmit]);

  return (
    <section className="composer" aria-label="Message composer">
      <div className="composer-editor">
        <CodeMirror
          value={value}
          onChange={change}
          minHeight="102px"
          maxHeight="220px"
          theme="dark"
          basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
          placeholder="Ask for follow-up changes"
          onKeyDownCapture={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || busyRef.current || submittingRef.current || valueRef.current.trim() === "") return;
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }}
        />
        <div className="composer-footer">
          <div className="composer-options">{controls}</div>
          {busy ? (
            <Tooltip label="Stop current run"><Button variant="danger" size="icon" aria-label="Stop current run" onClick={onStop}><Square size={14} fill="currentColor" /></Button></Tooltip>
          ) : (
            <Tooltip label="Send message"><Button className="composer-send" size="icon" aria-label="Send message" onClick={() => { void submit(); }} disabled={value.trim() === ""}><ArrowUp size={17} /></Button></Tooltip>
          )}
        </div>
      </div>
    </section>
  );
}
