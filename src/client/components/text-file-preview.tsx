import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { WorkspaceFileContent } from "../../shared/protocol";
import { api, workspaceFileUrl } from "../api";
import { CodePreview } from "./code-preview";
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

/** 预览入口的下载/新标签回退地址，与消息里其它本地文件链接一致。 */
export function localTextFilePreviewHref(path: string, cwd?: string): string {
  return workspaceFileUrl(cwd ?? "", path);
}

/**
 * 普通左键打开预览；划选文字、修饰键和新标签手势仍走链接默认行为。
 * Chromium 不能划选 button 文本，所以可预览态必须是 a。
 */
export function shouldOpenLocalTextFilePreview(
  event: Pick<MouseEvent<HTMLAnchorElement>, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">,
  selection?: Pick<Selection, "isCollapsed"> | null,
): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const current = selection === undefined
    ? (typeof window === "undefined" ? null : window.getSelection())
    : selection;
  return current === null || current.isCollapsed;
}

interface LocalTextFilePreviewAnchorProps {
  path: string;
  cwd?: string;
  className?: string;
  loading?: boolean;
  children: ReactNode;
  onOpen: () => void;
}

/** 可预览的本地文本入口：用 a 保证划选，单击仍打开预览。 */
export function LocalTextFilePreviewAnchor({ path, cwd, className, loading = false, children, onOpen }: LocalTextFilePreviewAnchorProps) {
  return <a
    href={localTextFilePreviewHref(path, cwd)}
    className={className === undefined ? "local-file-preview-trigger" : `local-file-preview-trigger ${className}`}
    target="_blank"
    rel="noreferrer"
    aria-busy={loading || undefined}
    aria-disabled={loading || undefined}
    onClick={(event) => {
      if (!shouldOpenLocalTextFilePreview(event)) return;
      event.preventDefault();
      if (!loading) onOpen();
    }}
  >{children}</a>;
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
    <LocalTextFilePreviewAnchor path={path} cwd={cwd} className={className} loading={loading} onOpen={openPreview}>{children}</LocalTextFilePreviewAnchor>
    {file === undefined ? null : <TextFilePreviewDialog file={file} line={line} column={column} open={open} onClose={() => setOpen(false)} />}
  </>;
}

export function TextFilePreviewDialog({ file, line, column, open = true, onClose }: { file: WorkspaceFileContent; line?: number; column?: number; open?: boolean; onClose: () => void }) {
  const codeRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!open || line === undefined || codeRef.current === null) return;
    const target = codeRef.current.querySelector<HTMLElement>(`[data-line="${String(line)}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [file, line, open]);
  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <DialogContent className="text-file-preview-dialog" title={file.name}>
      <div className="text-file-preview-shell">
        {file.truncated ? <div className="text-file-preview-notice" role="status">文件较大，仅显示前 512 KB。</div> : null}
        <CodePreview ref={codeRef} text={file.content} path={file.path} line={line} column={column} columnClassName="text-file-preview-column" className="text-file-preview-code" lineClassName="text-file-preview-line" />
      </div>
    </DialogContent>
  </Dialog>;
}
