import { ChevronLeft, ChevronRight, Plus, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";

/**
 * 设置页 UI 原语（系统设置风：分组圆角列表 + 逐级子页面）。
 * PC 与移动端共用同一套单列布局，仅宽度不同。
 */

/** 居中窄栏容器。 */
export function SettingsShell({ children }: { children: ReactNode }) {
  return <div className="settings-shell">{children}</div>;
}

/** 顶栏：返回 + 居中标题。首页用 X（返回会话），子页用 ‹ 返回。 */
export function SettingsTopBar({ title, onBack, home, action }: { title: string; onBack: () => void; home?: boolean; action?: ReactNode }) {
  return <header className="settings-topbar">
    <span className="settings-topbar-side">
      <button type="button" className="settings-topbar-back" onClick={onBack} aria-label={home === true ? "返回会话" : "返回"} title={home === true ? "返回会话" : "返回"}>
        {home === true ? <X size={16} /> : <><ChevronLeft size={16} /><span>返回</span></>}
      </button>
    </span>
    <h1 className="settings-topbar-title">{title}</h1>
    <span className="settings-topbar-side settings-topbar-trailing">{action}</span>
  </header>;
}

/** 子页骨架：顶栏 + 居中内容栏。 */
export function SettingsSubpage({ title, onBack, action, children }: { title: string; onBack: () => void; action?: ReactNode; children: ReactNode }) {
  return <><SettingsTopBar title={title} onBack={onBack} action={action} /><SettingsShell>{children}</SettingsShell></>;
}

/** 分组卡片：可选组标题 + 圆角容器，行间自动细分隔线。 */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="settings-block">
    {title === undefined ? null : <h2 className="settings-group-title">{title}</h2>}
    <div className="settings-group">{children}</div>
  </section>;
}

/** 分组内的一行：图标 + 标题 + 右侧值/控件/箭头；传 onClick 即为整行按钮。 */
export function SettingsRow({ icon: Icon, label, value, chevron, danger, accent, control, disabled, onClick }: {
  icon?: LucideIcon;
  label: ReactNode;
  value?: ReactNode;
  chevron?: boolean;
  danger?: boolean;
  accent?: boolean;
  control?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const className = `settings-row${danger === true ? " danger" : ""}${accent === true ? " accent" : ""}`;
  const body = <>
    {Icon === undefined ? null : <span className="settings-row-icon"><Icon size={16} /></span>}
    <span className="settings-row-label">{label}</span>
    {value === undefined ? null : <span className="settings-row-value">{value}</span>}
    {control}
    {chevron === true ? <ChevronRight size={16} className="settings-row-chevron" /> : null}
  </>;
  if (onClick === undefined) return <div className={className}>{body}</div>;
  return <button type="button" className={className} disabled={disabled === true} onClick={onClick}>{body}</button>;
}

/** iOS 风开关。 */
export function SettingsSwitch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} className="settings-switch" disabled={disabled === true}
    onClick={(event) => { event.stopPropagation(); onChange(!checked); }} />;
}

/** 空状态：图标 + 一句话 + 直达按钮。 */
export function SettingsEmpty({ icon: Icon, title, actionLabel, onAction }: { icon: LucideIcon; title: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="settings-empty">
    <span className="settings-empty-icon"><Icon size={16} /></span>
    <strong>{title}</strong>
    {actionLabel === undefined || onAction === undefined ? null : <Button size="sm" onClick={onAction}><Plus size={14} />{actionLabel}</Button>}
  </div>;
}
