import { useEffect, useRef, useState } from "react";
import { listenDesktopCheckUpdate, showDesktopWindow } from "../desktop";
import {
  UPDATE_CHECK_INTERVAL_MS,
  canDismissUpdate,
  downloadProgressLabel,
  initialUpdateSession,
  reduceUpdateSession,
  updateCheckDisposition,
  updateErrorMessage,
  updatePhaseLocksCheck,
  updateVersionLabel,
  type UpdateAction,
  type UpdateOffer,
  type UpdatePhase,
} from "../lib/desktop-update";
import { isDesktopShell } from "../lib/desktop-shell";
import { checkDesktopUpdate, desktopSessionsRunning, relaunchDesktop, type AvailableUpdate, type DownloadProgress } from "../lib/desktop-updater";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

const PROGRESS_PAINT_MS = 80;

export function DesktopUpdatePrompt() {
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "closed" });
  const sessionRef = useRef(initialUpdateSession());
  const heldRef = useRef<AvailableUpdate | undefined>(undefined);
  const inFlightRef = useRef(false);
  const queuedManualRef = useRef(false);
  const generationRef = useRef(0);
  const actingRef = useRef(false);
  const runCheckRef = useRef<(manual: boolean) => Promise<void>>(async () => undefined);

  const dispatch = (action: UpdateAction) => {
    sessionRef.current = reduceUpdateSession(sessionRef.current, action);
    setPhase(sessionRef.current.phase);
  };

  const dismiss = () => {
    if (!canDismissUpdate(sessionRef.current.phase)) return;
    generationRef.current += 1;
    dispatch({ type: "dismiss" });
  };

  const runCheck = async (manual: boolean) => {
    if (manual) queuedManualRef.current = true;
    if (inFlightRef.current) return;
    const before = sessionRef.current;
    const requestedManual = manual || queuedManualRef.current;
    queuedManualRef.current = false;
    if (requestedManual && (before.phase.kind === "downloading" || before.phase.kind === "installing")) {
      void showDesktopWindow().catch(() => undefined);
      return;
    }
    if (!requestedManual && updatePhaseLocksCheck(before.phase)) return;
    const id = ++generationRef.current;
    inFlightRef.current = true;
    dispatch({ type: "check-started", manual: requestedManual });
    if (requestedManual) void showDesktopWindow().catch(() => undefined);
    try {
      const update = await checkDesktopUpdate();
      if (id !== generationRef.current) {
        await update?.close();
        return;
      }
      const effectiveManual = requestedManual || queuedManualRef.current;
      queuedManualRef.current = false;
      if (update === null) {
        await clearHeld();
        dispatch({ type: "check-empty", manual: effectiveManual });
        if (effectiveManual) void showDesktopWindow().catch(() => undefined);
        return;
      }
      await applyFound(effectiveManual, update);
    } catch (error) {
      if (id !== generationRef.current) return;
      const effectiveManual = requestedManual || queuedManualRef.current;
      queuedManualRef.current = false;
      dispatch({ type: "check-failed", manual: effectiveManual, error: updateErrorMessage(error) });
      if (effectiveManual) void showDesktopWindow().catch(() => undefined);
    } finally {
      inFlightRef.current = false;
      if (queuedManualRef.current) void runCheckRef.current(true);
    }
  };
  runCheckRef.current = runCheck;

  const download = async () => {
    const held = heldRef.current;
    if (held === undefined || actingRef.current) return;
    actingRef.current = true;
    dispatch({ type: "download-started" });
    let latest: DownloadProgress = { received: 0 };
    let paintedAt = 0;
    try {
      await held.download((progress) => {
        latest = progress;
        const now = Date.now();
        if (now - paintedAt < PROGRESS_PAINT_MS) return;
        paintedAt = now;
        dispatch({ type: "download-progress", received: progress.received, total: progress.total });
      });
      dispatch({ type: "download-progress", received: latest.received, total: latest.total });
      dispatch({ type: "download-finished" });
    } catch (error) {
      dispatch({ type: "download-failed", error: updateErrorMessage(error) });
    } finally {
      actingRef.current = false;
    }
  };

  const install = async () => {
    const held = heldRef.current;
    if (held === undefined || !held.downloaded || actingRef.current) return;
    actingRef.current = true;
    try {
      if (await desktopSessionsRunning()) {
        dispatch({ type: "install-blocked" });
        return;
      }
      dispatch({ type: "install-started" });
      await held.install();
      await relaunchDesktop();
    } catch (error) {
      dispatch({ type: "install-failed", error: updateErrorMessage(error) });
    } finally {
      actingRef.current = false;
    }
  };

  async function applyFound(manual: boolean, update: AvailableUpdate) {
    const held = heldRef.current;
    const disposition = updateCheckDisposition(sessionRef.current, manual, update.version, held?.downloaded ? held.version : undefined);
    if (disposition === "drop") {
      await update.close();
      return;
    }
    const offer: UpdateOffer = { version: update.version, currentVersion: update.currentVersion, notes: update.notes };
    if (disposition === "prompt-ready") await update.close();
    else {
      await held?.close();
      heldRef.current = update;
    }
    void showDesktopWindow().catch(() => undefined);
    dispatch({ type: "check-found", manual, offer, downloaded: disposition === "prompt-ready" });
  }

  async function clearHeld() {
    if (sessionRef.current.phase.kind === "downloading" || sessionRef.current.phase.kind === "installing") return;
    await heldRef.current?.close();
    heldRef.current = undefined;
  }

  useEffect(() => {
    if (!isDesktopShell()) return;
    let disposed = false;
    const listening = listenDesktopCheckUpdate(() => {
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("take_update_check")).catch(() => undefined);
      void runCheckRef.current(true);
    });
    const timer = window.setInterval(() => { void runCheckRef.current(false); }, UPDATE_CHECK_INTERVAL_MS);
    void listening.ready.then(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const pending = await invoke<boolean>("take_update_check");
      if (!disposed) void runCheckRef.current(pending === true);
    }).catch(() => {
      if (!disposed) void runCheckRef.current(false);
    });
    return () => {
      disposed = true;
      listening.stop();
      window.clearInterval(timer);
    };
  }, []);

  if (!isDesktopShell() || phase.kind === "closed") return null;
  const locked = phase.kind === "downloading" || phase.kind === "installing";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) dismiss(); }}>
      <DialogContent title={phaseTitle(phase)} className={locked ? "update-dialog update-dialog-locked" : "update-dialog"} onEscapeKeyDown={(event) => { if (locked) event.preventDefault(); }} onPointerDownOutside={(event) => { if (locked) event.preventDefault(); }}>
        <UpdatePromptBody phase={phase} />
        <UpdatePromptActions phase={phase} onDismiss={dismiss} onDownload={() => { void download(); }} onInstall={() => { void install(); }} onRetryCheck={() => { void runCheck(true); }} />
      </DialogContent>
    </Dialog>
  );
}

function phaseTitle(phase: UpdatePhase): string {
  switch (phase.kind) {
    case "checking": return "检查更新";
    case "available": return "发现新版本";
    case "downloading": return "正在下载";
    case "download-failed": return "下载失败";
    case "ready": return "可以安装";
    case "installing": return "正在安装";
    case "up-to-date": return "已是最新版本";
    case "check-failed": return "检查失败";
    case "closed": return "";
  }
}

function UpdatePromptBody({ phase }: { phase: UpdatePhase }) {
  const offer = phase.kind === "available" || phase.kind === "downloading" || phase.kind === "download-failed" || phase.kind === "ready" || phase.kind === "installing" ? phase.offer : undefined;
  return (
    <>
      {offer === undefined ? null : <p className="update-version">{updateVersionLabel(offer)}</p>}
      {offer?.notes === undefined ? null : <pre className="update-notes">{offer.notes}</pre>}
      {phase.kind === "checking" || phase.kind === "installing" ? <UpdateProgress name={phase.kind === "checking" ? "检查更新" : "安装进度"} /> : null}
      {phase.kind === "downloading" ? <UpdateProgress name="下载进度" received={phase.received} total={phase.total} label={downloadProgressLabel(phase.received, phase.total)} /> : null}
      {phase.kind === "ready" ? <p className="delete-session-message">安装后会重启。</p> : null}
      {phase.kind === "ready" && phase.busy ? <p className="update-status">有任务正在运行</p> : null}
      {phase.kind === "ready" && phase.error !== undefined ? <p className="update-status error" role="alert">{phase.error}</p> : null}
      {phase.kind === "download-failed" || phase.kind === "check-failed" ? <p className="update-status error" role="alert">{phase.error}</p> : null}
    </>
  );
}

function UpdateProgress({ name, received, total, label }: { name: string; received?: number; total?: number; label?: string }) {
  const known = total !== undefined && total > 0 && received !== undefined;
  const percent = known ? Math.min(100, Math.round((received / total) * 100)) : undefined;
  return (
    <div className="update-progress">
      <div className="update-progress-track" role="progressbar" aria-label={name} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={percent}>
        <span className={known ? "update-progress-fill known" : "update-progress-fill unknown"} style={known ? { width: `${String(percent)}%` } : undefined} />
      </div>
      {label === undefined || label === "" ? null : <p className="update-progress-label">{label}</p>}
    </div>
  );
}

function UpdatePromptActions({ phase, onDismiss, onDownload, onInstall, onRetryCheck }: { phase: UpdatePhase; onDismiss: () => void; onDownload: () => void; onInstall: () => void; onRetryCheck: () => void }) {
  if (phase.kind === "available") return <div className="dialog-actions"><Button variant="secondary" onClick={onDismiss}>稍后</Button><Button onClick={onDownload}>下载</Button></div>;
  if (phase.kind === "download-failed") return <div className="dialog-actions"><Button variant="secondary" onClick={onDismiss}>稍后</Button><Button onClick={onDownload}>重新下载</Button></div>;
  if (phase.kind === "ready") return <div className="dialog-actions"><Button variant="secondary" onClick={onDismiss}>稍后</Button><Button onClick={onInstall}>安装</Button></div>;
  if (phase.kind === "up-to-date") return <div className="dialog-actions"><Button variant="secondary" onClick={onDismiss}>关闭</Button></div>;
  if (phase.kind === "check-failed") return <div className="dialog-actions"><Button variant="secondary" onClick={onDismiss}>关闭</Button><Button onClick={onRetryCheck}>重试</Button></div>;
  return null;
}
