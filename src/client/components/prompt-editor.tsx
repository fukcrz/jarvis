import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { CornerDownLeft, Square } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

interface PromptEditorProps {
  sessionId: string;
  initialValue: string;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => boolean | Promise<boolean>;
  onStop: () => void;
}

export function PromptEditor({ sessionId, initialValue, busy, onDraftChange, onSubmit, onStop }: PromptEditorProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => { setValue(initialValue); }, [sessionId, initialValue]);

  const change = (next: string) => {
    setValue(next);
    onDraftChange(next);
  };

  const submit = async () => {
    if (busy || value.trim() === "") return;
    const submitted = await onSubmit(value);
    if (submitted) change("");
  };

  return (
    <section className="composer" aria-label="Message composer">
      <div className="composer-editor" onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
      }}>
        <CodeMirror
          value={value}
          onChange={change}
          minHeight="74px"
          maxHeight="180px"
          basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
          placeholder="Describe the task..."
        />
      </div>
      <div className="composer-actions">
        {busy ? (
          <Tooltip label="Stop current run">
            <Button variant="danger" size="icon" aria-label="Stop current run" onClick={onStop}><Square size={15} fill="currentColor" /></Button>
          </Tooltip>
        ) : (
          <Tooltip label="Send message">
            <Button size="icon" aria-label="Send message" onClick={submit} disabled={value.trim() === ""}><CornerDownLeft size={18} /></Button>
          </Tooltip>
        )}
      </div>
    </section>
  );
}
