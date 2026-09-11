import { forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WorkspaceFileContent } from "../../shared/protocol";
import { api } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface TextFileCheckEntry {
  promise: Promise<boolean>;
  expiresAt: number;
}

const textFileCheckCache = new Map<string, TextFileCheckEntry>();
const TEXT_FILE_CHECK_TTL_MS = 10_000;
const MAX_TEXT_FILE_CHECKS = 6;
let activeTextFileChecks = 0;
const pendingTextFileChecks: Array<() => void> = [];

function runTextFileCheck<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      activeTextFileChecks += 1;
      void task().then(resolve, reject).finally(() => {
        activeTextFileChecks -= 1;
        const next = pendingTextFileChecks.shift();
        if (next !== undefined) next();
      });
    };
    if (activeTextFileChecks < MAX_TEXT_FILE_CHECKS) run();
    else pendingTextFileChecks.push(run);
  });
}

/** 只缓存短时间内的文本资格探测；源码在用户点击后重新读取。 */
function canLoadTextFile(path: string, cwd: string | undefined): Promise<boolean> {
  const key = `${cwd ?? ""}\u0000${path}`;
  const now = Date.now();
  const cached = textFileCheckCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) return cached.promise;
  const promise = runTextFileCheck(() => api.textFile(path, cwd, true)).then(() => true).catch(() => false);
  const entry = { promise, expiresAt: now + TEXT_FILE_CHECK_TTL_MS };
  textFileCheckCache.set(key, entry);
  void promise.then((result) => {
    if (!result && textFileCheckCache.get(key) === entry) textFileCheckCache.delete(key);
  });
  return promise;
}

interface LocalTextFileLinkProps {
  path: string;
  cwd?: string;
  children: ReactNode;
  line?: number;
  column?: number;
  className?: string;
}

/** 只有服务端确认是可读取文本文件后，才把普通文本显示成可点击入口。 */
export function LocalTextFileLink({ path, cwd, line, column, children, className }: LocalTextFileLinkProps) {
  const [available, setAvailable] = useState<boolean>();
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<WorkspaceFileContent>();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setAvailable(undefined);
    setLoading(false);
    setFile(undefined);
    setOpen(false);
    void canLoadTextFile(path, cwd).then((result) => {
      if (active) setAvailable(result);
    });
    return () => { active = false; };
  }, [cwd, path]);

  const openPreview = () => {
    if (available !== true || loading) return;
    setLoading(true);
    void api.textFile(path, cwd)
      .then((result) => {
        setFile(result);
        setOpen(true);
      })
      .catch(() => { setAvailable(false); })
      .finally(() => { setLoading(false); });
  };

  if (available !== true) return <span className="local-file-reference">{children}</span>;
  return <>
    <button type="button" className={`local-file-preview-trigger${className === undefined ? "" : ` ${className}`}`} onClick={openPreview} disabled={loading} aria-busy={loading}>{children}</button>
    {open && file !== undefined ? <TextFilePreviewDialog file={file} line={line} column={column} onClose={() => setOpen(false)} /> : null}
  </>;
}

export function TextFilePreviewDialog({ file, line, column, onClose }: { file: WorkspaceFileContent; line?: number; column?: number; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLPreElement>(null);
  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) return;
    try {
      void clipboard.writeText(file.content).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_600);
      }).catch(() => {});
    } catch {
      // Clipboard access can throw synchronously outside a secure browser context.
    }
  };
  useEffect(() => {
    if (line === undefined || codeRef.current === null) return;
    const target = codeRef.current.querySelector<HTMLElement>(`[data-line="${String(line)}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [file, line]);
  return <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <DialogContent className="text-file-preview-dialog" title={file.name} description={`${file.path}${line === undefined ? "" : `:${String(line)}${column === undefined ? "" : `:${String(column)}`}`}`}>
      <div className="text-file-preview-shell">
        <div className="text-file-preview-actions">
          <Button variant="ghost" size="sm" onClick={copy} disabled={file.content === ""}>{copied ? "已复制" : "复制"}</Button>
        </div>
        {file.truncated ? <div className="text-file-preview-notice" role="status">文件较大，仅显示前 512 KB。</div> : null}
        <TextFileCode ref={codeRef} text={file.content} line={line} column={column} />
      </div>
    </DialogContent>
  </Dialog>;
}

const TextFileCode = forwardRef<HTMLPreElement, { text: string; line?: number; column?: number }>(function TextFileCode({ text, line, column }, ref) {
  const lines = text.split("\n");
  return <pre ref={ref} className="text-file-preview-code" aria-label="文件内容"><code>{lines.map((value, index) => {
    const lineNumber = index + 1;
    const highlighted = line === lineNumber;
    return <span className={`text-file-preview-line${highlighted ? " highlighted" : ""}`} data-line={lineNumber} key={lineNumber}><span className="text-file-preview-line-number">{lineNumber}</span><span className="text-file-preview-line-content">{value || " "}{highlighted && column !== undefined ? <span className="text-file-preview-column" style={{ "--text-file-column": Math.max(0, column - 1) } as CSSProperties} /> : null}</span>{index === lines.length - 1 ? null : "\n"}</span>;
  })}</code></pre>;
});
