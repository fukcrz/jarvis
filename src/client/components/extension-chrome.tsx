import { useState } from "react";
import { Bell, CircleAlert, Puzzle, X } from "lucide-react";
import type { SessionSummary } from "../../shared/protocol";
import { extensionToastSourceLabel, type ExtensionToast } from "../extension-notifications";
import type { ExtensionPanelState } from "../hooks/use-session-stream";

export function ExtensionPanels({ panels }: { panels: ExtensionPanelState }) {
  const widgets = Object.entries(panels.widgets);
  const statuses = Object.entries(panels.statuses);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (widgets.length === 0 && statuses.length === 0) return null;
  return <aside className="extension-panels" aria-label="扩展内容">
    <div className="extension-widget-track">
      {statuses.map(([key, text]) => <span className="extension-status" key={`status:${key}`} title={key}><Puzzle size={11} /><span>{text}</span></span>)}
      {widgets.map(([key, widget]) => <section key={`widget:${key}`} className={`extension-widget ${collapsed[key] === true ? "collapsed" : ""}`} title={key}>
        <button type="button" className="extension-widget-heading" onClick={() => setCollapsed((current) => ({ ...current, [key]: !current[key] }))} aria-expanded={collapsed[key] !== true}>
          <span>{key}</span><small>{collapsed[key] === true ? "展开" : "收起"}</small>
        </button>
        {collapsed[key] === true ? null : <pre className="extension-widget-body">{widget.lines.join("\n")}</pre>}
      </section>)}
    </div>
  </aside>;
}

export function ExtensionToasts({ toasts, sessionsByWorkspace, onOpenSession, onDismiss }: { toasts: ExtensionToast[]; sessionsByWorkspace: Record<string, SessionSummary[]>; onOpenSession: (workspaceId: string, sessionId: string) => void; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return <div className="extension-toast-stack" aria-label="扩展通知" aria-live="polite">
    {toasts.map((toast) => {
      const Icon = toast.tone === "info" ? Bell : CircleAlert;
      const session = toast.sessionId === undefined ? undefined : sessionsByWorkspace[toast.workspaceId]?.find((candidate) => candidate.id === toast.sessionId);
      const sourceLabel = extensionToastSourceLabel(session?.name);
      return <div key={toast.id} className={`toast-surface extension-toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
        <Icon size={14} className="toast-surface-icon" /><div className="extension-toast-copy">{toast.count > 1 || toast.sessionId === undefined || sourceLabel === undefined ? null : <button type="button" className="extension-toast-source" onClick={() => onOpenSession(toast.workspaceId, toast.sessionId!)}>{sourceLabel}</button>}{toast.count > 1 ? <strong className="extension-toast-count">收到 {toast.count} 条扩展通知</strong> : <span className="extension-toast-message">{toast.message}</span>}</div><button type="button" aria-label="关闭通知" onClick={() => onDismiss(toast.id)}><X size={14} /></button>
      </div>;
    })}
  </div>;
}
