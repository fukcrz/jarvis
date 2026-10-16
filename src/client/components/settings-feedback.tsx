import { Check, CircleAlert, Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useHistoryBackTrap } from "../lib/history-back-trap";
import { Dialog, DialogContent } from "./ui/dialog";
import { StButton } from "./settings-ui";

/* ------------------------------------------------------------------ *
 * 即时保存：控件旁的「✓ 已保存 / 保存失败 · 重试」
 * ------------------------------------------------------------------ */

type SavePhase = "saving" | "saved" | "error";
interface SaveEntry { phase: SavePhase; message?: string; retry?: () => void }
interface SaveStatusApi {
  /** 先乐观更新界面，再调用 action；失败时执行 rollback 并在 key 旁显示「保存失败 · 重试」。 */
  run: (key: string, action: () => Promise<unknown>, options?: { rollback?: () => void }) => Promise<boolean>;
  entry: (key: string) => SaveEntry | undefined;
}

const SaveStatusContext = createContext<SaveStatusApi | undefined>(undefined);

export function SaveStatusProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, SaveEntry>>({});
  const timers = useRef(new Map<string, number>());
  const generation = useRef(new Map<string, number>());
  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);
  const clearLater = useCallback((key: string, delay: number) => {
    const existing = timers.current.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    timers.current.set(key, window.setTimeout(() => {
      timers.current.delete(key);
      setEntries((current) => { const next = { ...current }; delete next[key]; return next; });
    }, delay));
  }, []);
  const run = useCallback<SaveStatusApi["run"]>(async (key, action, options) => {
    const id = (generation.current.get(key) ?? 0) + 1;
    generation.current.set(key, id);
    const existing = timers.current.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    setEntries((current) => ({ ...current, [key]: { phase: "saving" } }));
    try {
      await action();
      if (generation.current.get(key) !== id) return true;
      setEntries((current) => ({ ...current, [key]: { phase: "saved" } }));
      clearLater(key, 1800);
      return true;
    } catch (error) {
      options?.rollback?.();
      if (generation.current.get(key) !== id) return false;
      const retry = () => { void run(key, action, options); };
      setEntries((current) => ({ ...current, [key]: { phase: "error", message: error instanceof Error ? error.message : "保存失败", retry } }));
      clearLater(key, 12_000);
      return false;
    }
  }, [clearLater]);
  const api = useMemo<SaveStatusApi>(() => ({ run, entry: (key) => entries[key] }), [entries, run]);
  return <SaveStatusContext.Provider value={api}>{children}</SaveStatusContext.Provider>;
}

export function useSaveStatus(): SaveStatusApi {
  const context = useContext(SaveStatusContext);
  if (context === undefined) throw new Error("useSaveStatus 需要 SaveStatusProvider");
  return context;
}

/** 控件旁的保存状态位，平时不占视觉。 */
export function SaveState({ k }: { k: string }) {
  const entry = useSaveStatus().entry(k);
  if (entry === undefined) return <span className="st-saved" aria-hidden />;
  if (entry.phase === "saving") return <span className="st-saved show" role="status"><Loader2 size={12} className="spin" />保存中</span>;
  if (entry.phase === "saved") return <span className="st-saved show" role="status"><Check size={12} />已保存</span>;
  return <button type="button" className="st-saved show err" title={entry.message} onClick={entry.retry}>保存失败 · 重试</button>;
}

/** 单个文本框：停止输入 0.8 秒或失焦后自动保存。 */
export function useDebouncedSave(value: string, save: (value: string) => void, delay = 800) {
  const latest = useRef({ value, save, committed: value });
  latest.current.value = value;
  latest.current.save = save;
  const timer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    if (latest.current.value === latest.current.committed) return;
    latest.current.committed = latest.current.value;
    latest.current.save(latest.current.value);
  }, []);
  const schedule = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
  }, [delay, flush]);
  /** 外部值变化（服务器推送、保存回写）后，把它当作已提交值。 */
  const reset = useCallback((committed: string) => { latest.current.committed = committed; }, []);
  useEffect(() => () => { if (timer.current !== undefined) { window.clearTimeout(timer.current); flush(); } }, [flush]);
  return useMemo(() => ({ schedule, flush, reset }), [flush, reset, schedule]);
}

/* ------------------------------------------------------------------ *
 * 底部提示条：删除后 8 秒内可撤销；普通提示 / 错误提示
 * ------------------------------------------------------------------ */

interface UndoOptions {
  message: string;
  /** 撤销：恢复界面（和必要时的数据）。 */
  undo: () => void | Promise<void>;
  /** 延迟提交：8 秒后（或被下一条撤销条替换、离开设置页时）才真正执行。 */
  commit?: () => Promise<void>;
  /** 延迟提交失败时的处理（一般是恢复界面并报错）。 */
  onCommitError?: (error: unknown) => void;
}
interface ToastState { id: number; message: string; tone: "info" | "error" | "undo" }
interface ToastApi {
  showUndo: (options: UndoOptions) => void;
  notify: (message: string, tone?: "info" | "error") => void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);
const UNDO_MS = 8_000;

export function SettingsToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>();
  const pending = useRef<{ id: number; options: UndoOptions } | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const nextId = useRef(1);

  const commitPending = useCallback(() => {
    const current = pending.current;
    pending.current = undefined;
    if (current?.options.commit === undefined) return;
    void current.options.commit().catch((error: unknown) => current.options.onCommitError?.(error));
  }, []);
  const hide = useCallback((id: number) => { setToast((current) => current?.id === id ? undefined : current); }, []);
  const schedule = useCallback((id: number, delay: number, onElapsed?: () => void) => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { onElapsed?.(); hide(id); }, delay);
  }, [hide]);

  const showUndo = useCallback((options: UndoOptions) => {
    commitPending();
    const id = nextId.current++;
    pending.current = { id, options };
    setToast({ id, message: options.message, tone: "undo" });
    schedule(id, UNDO_MS, () => { if (pending.current?.id === id) commitPending(); });
  }, [commitPending, schedule]);
  const notify = useCallback((message: string, tone: "info" | "error" = "info") => {
    commitPending();
    const id = nextId.current++;
    setToast({ id, message, tone });
    schedule(id, tone === "error" ? 6_000 : 2_400);
  }, [commitPending, schedule]);
  const undo = () => {
    const current = pending.current;
    pending.current = undefined;
    if (toast !== undefined) hide(toast.id);
    if (current !== undefined) void Promise.resolve(current.options.undo()).catch(() => undefined);
  };
  // 离开设置页：还没到 8 秒的删除照常提交。
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    commitPending();
  }, [commitPending]);

  const api = useMemo<ToastApi>(() => ({ showUndo, notify }), [notify, showUndo]);
  return <ToastContext.Provider value={api}>
    {children}
    {toast === undefined ? null : <div key={toast.id} className={`st-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
      {toast.tone === "error" ? <CircleAlert size={15} /> : null}
      <span>{toast.message}</span>
      {toast.tone === "undo" ? <StButton variant="ghost" className="st-toast-undo" onClick={undo}>撤销</StButton> : <button type="button" className="st-toast-close" aria-label="关闭提示" onClick={() => hide(toast.id)}><X size={14} /></button>}
      {toast.tone === "undo" ? <span className="st-toast-bar" style={{ animationDuration: `${String(UNDO_MS)}ms` }} /> : null}
    </div>}
  </ToastContext.Provider>;
}

export function useSettingsToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context === undefined) throw new Error("useSettingsToast 需要 SettingsToastProvider");
  return context;
}

/* ------------------------------------------------------------------ *
 * 多字段表单：底部保存条 + 离开提醒
 * ------------------------------------------------------------------ */

const LEAVE_MESSAGE = "有未保存的修改，确定离开吗？";

interface LeaveGuardApi {
  setDirty: (key: string, dirty: boolean) => void;
  /** 设置页内部跳转前调用；有未保存的修改时询问，返回是否可以离开。 */
  confirmLeave: () => boolean;
  /** 有未保存修改时先问；放弃后等拦截器收起占位历史再执行 fn，避免和返回键抢同一条历史。 */
  guard: (fn: () => void) => void;
}
const LeaveGuardContext = createContext<LeaveGuardApi | undefined>(undefined);

export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const dirtyKeys = useRef(new Set<string>());
  const [anyDirty, setAnyDirty] = useState(false);
  const api = useMemo<LeaveGuardApi>(() => ({
    setDirty: (key, dirty) => {
      if (dirty) dirtyKeys.current.add(key); else dirtyKeys.current.delete(key);
      setAnyDirty(dirtyKeys.current.size > 0);
    },
    confirmLeave: () => {
      if (dirtyKeys.current.size === 0) return true;
      if (!window.confirm(LEAVE_MESSAGE)) return false;
      dirtyKeys.current.clear();
      setAnyDirty(false);
      return true;
    },
    guard: (fn) => {
      if (dirtyKeys.current.size === 0) { fn(); return; }
      if (!window.confirm(LEAVE_MESSAGE)) return;
      dirtyKeys.current.clear();
      setAnyDirty(false);
      window.setTimeout(fn, 120);
    },
  }), []);
  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);
  // 浏览器/手机的返回键：有未保存修改时先拦下来问一句。
  const pendingBack = useRef(false);
  useHistoryBackTrap(anyDirty, () => {
    if (window.confirm(LEAVE_MESSAGE)) {
      dirtyKeys.current.clear();
      pendingBack.current = true;
      setAnyDirty(false);
    }
  });
  // 拦截器先吃掉自己的占位历史，再真正后退一步。
  useEffect(() => {
    if (anyDirty || !pendingBack.current) return;
    pendingBack.current = false;
    const timer = window.setTimeout(() => window.history.back(), 60);
    return () => window.clearTimeout(timer);
  }, [anyDirty]);
  return <LeaveGuardContext.Provider value={api}>{children}</LeaveGuardContext.Provider>;
}

export function useLeaveGuard(): LeaveGuardApi {
  const context = useContext(LeaveGuardContext);
  if (context === undefined) throw new Error("useLeaveGuard 需要 LeaveGuardProvider");
  return context;
}

/** 把一个表单的脏状态登记到离开提醒里（卸载时自动注销）。 */
export function useDirtyRegistration(key: string, dirty: boolean) {
  const { setDirty } = useLeaveGuard();
  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [dirty, key, setDirty]);
}

/** 底部「● 有未保存的修改  放弃 / 保存」条。手机端固定在底部，单手可按。 */
export function DirtyBar({ show, saving, message = "有未保存的修改", onDiscard, onSave, extra, saveDisabled }: { show: boolean; saving?: boolean; message?: string; onDiscard: () => void; onSave: () => void; extra?: ReactNode; saveDisabled?: boolean }) {
  return <div className={`st-dirty${show ? " show" : ""}`} aria-hidden={!show}>
    <div className="st-dirty-inner" role={show ? "region" : undefined} aria-label="未保存的修改">
      <span className="st-dirty-msg"><i />{message}</span>
      <span className="st-dirty-sp" />
      <StButton variant="ghost" onClick={onDiscard} disabled={saving === true || !show} tabIndex={show ? 0 : -1}>放弃</StButton>
      {extra}
      <StButton variant="primary" onClick={onSave} disabled={saving === true || saveDisabled === true || !show} tabIndex={show ? 0 : -1}>{saving === true ? "保存中…" : "保存"}</StButton>
    </div>
  </div>;
}

/** 只留给不可撤销的操作（重启服务、覆盖自带插件/技能、关闭访问密码等）的确认框。 */
export function SettingsConfirm({ open, title, children, confirmLabel = "确认", danger, busy, onCancel, onConfirm }: { open: boolean; title: string; children: ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next && busy !== true) onCancel(); }}>
    <DialogContent title={title} className="st-confirm">
      <div className="st-confirm-body">{children}</div>
      <div className="dialog-actions">
        <StButton onClick={onCancel} disabled={busy === true}>取消</StButton>
        <StButton variant={danger === true ? "danger" : "primary"} onClick={onConfirm} disabled={busy === true}>{busy === true ? "处理中…" : confirmLabel}</StButton>
      </div>
    </DialogContent>
  </Dialog>;
}
