import { AlertTriangle, ChevronLeft, ChevronRight, Info, Plus, type LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * 设置页 UI 原语（改版后）：页标题 + 「区块标题 + 卡片」+ 统一的行
 * （左边标题和一句说明，右边控件和保存状态）。电脑端与手机端共用，外壳不同。
 */

/** 页顶：可选面包屑 + 大标题 + 一句话概况。 */
export function SettingsPageHead({ title, description, crumb, extra }: { title: ReactNode; description?: ReactNode; crumb?: { label: string; onClick: () => void }; extra?: ReactNode }) {
  return <header className="st-page-head">
    {crumb === undefined ? null : <nav className="st-crumb" aria-label="面包屑"><button type="button" onClick={crumb.onClick}>{crumb.label}</button><span aria-hidden>›</span><span>{title}</span></nav>}
    <div className="st-page-title"><h1>{title}</h1>{extra}</div>
    {description === undefined ? null : <p>{description}</p>}
  </header>;
}

/** 区块：小标题（可带灰色说明）+ 右侧操作 + 内容。 */
export function SettingsSection({ id, title, hint, action, children }: { id?: string; title?: ReactNode; hint?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return <section className="st-section" id={id === undefined ? undefined : settingAnchorId(id)}>
    {title === undefined && action === undefined ? null : <div className="st-sec-head">
      {title === undefined ? null : <h2>{title}{hint === undefined ? null : <small>{hint}</small>}</h2>}
      {action === undefined ? null : <span className="st-sec-action">{action}</span>}
    </div>}
    {children}
  </section>;
}

/** 区块标题右侧的文字按钮，如「＋ 添加供应商」。 */
export function SectionAction({ label, onClick, icon: Icon = Plus, disabled }: { label: string; onClick: () => void; icon?: LucideIcon | null; disabled?: boolean }) {
  return <button type="button" className="st-act" onClick={onClick} disabled={disabled}>{Icon === null ? null : <Icon size={13} />}{label}</button>;
}

export function SettingsCard({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return <div className={`st-card${className === undefined ? "" : ` ${className}`}`} id={id === undefined ? undefined : settingAnchorId(id)}>{children}</div>;
}

/** 统一的设置行：标题 + 一句说明，右侧控件。传 onClick 即整行可点。 */
export function SettingRow({ id, title, description, control, leading, onClick, danger, className, mono }: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  leading?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  className?: string;
  mono?: boolean;
}) {
  const classes = `st-row${onClick === undefined ? "" : " click"}${danger === true ? " danger" : ""}${className === undefined ? "" : ` ${className}`}`;
  const body = <>
    {leading}
    <span className="st-row-text"><b>{title}</b>{description === undefined || description === null || description === "" ? null : <small className={mono === true ? "mono" : undefined}>{description}</small>}</span>
    {control === undefined ? null : <span className="st-ctl" onClick={onClick === undefined ? undefined : (event) => event.stopPropagation()}>{control}</span>}
    {onClick === undefined ? null : <ChevronRight size={16} className="st-chev" aria-hidden />}
  </>;
  if (onClick === undefined) return <div className={classes} id={id === undefined ? undefined : settingAnchorId(id)}>{body}</div>;
  return <div className={classes} id={id === undefined ? undefined : settingAnchorId(id)} role="button" tabIndex={0} onClick={onClick} onKeyDown={(event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); }
  }}>{body}</div>;
}

/** 表单字段：标签 + 控件 + 提示/提醒/错误。 */
export function SettingsField({ id, label, hint, warn, error, children }: { id?: string; label: ReactNode; hint?: ReactNode; warn?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return <div className="st-field" id={id === undefined ? undefined : settingAnchorId(id)}>
    <label>{label}</label>
    {children}
    {error !== undefined && error !== null && error !== false ? <small className="err">{error}</small> : warn !== undefined && warn !== null && warn !== false ? <small className="warn">{warn}</small> : hint === undefined ? null : <small>{hint}</small>}
  </div>;
}

/** iOS 风开关。 */
export function SettingsSwitch({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (next: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} className="settings-switch" disabled={disabled === true}
    onClick={(event) => { event.stopPropagation(); onChange(!checked); }} />;
}

/** 表单里的开关行：左标签（可带说明），右开关。 */
export function SettingsFormSwitch({ label, description, checked, onChange, disabled }: { label: ReactNode; description?: ReactNode; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return <div className="st-form-switch">
    <span><b>{label}</b>{description === undefined ? null : <small>{description}</small>}</span>
    <SettingsSwitch checked={checked} onChange={onChange} disabled={disabled} label={typeof label === "string" ? label : "开关"} />
  </div>;
}

/** 2–4 个互斥项的分段选择。 */
export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (next: T) => void; label: string; disabled?: boolean }) {
  return <div className="st-seg" role="radiogroup" aria-label={label}>
    {options.map((option) => <button type="button" role="radio" aria-checked={option.value === value} key={option.value} className={option.value === value ? "on" : undefined} disabled={disabled} onClick={() => { if (option.value !== value) onChange(option.value); }}>{option.label}</button>)}
  </div>;
}

type StButtonVariant = "default" | "primary" | "ghost" | "danger";
export const StButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: StButtonVariant; icon?: boolean }>(({ variant = "default", icon, className, type = "button", ...props }, ref) => (
  <button ref={ref} type={type} className={`st-btn${variant === "default" ? "" : ` ${variant}`}${icon === true ? " icon" : ""}${className === undefined ? "" : ` ${className}`}`} {...props} />
));
StButton.displayName = "StButton";

export function SettingsTag({ tone, children, title }: { tone?: "ok" | "warn" | "acc" | "danger"; children: ReactNode; title?: string }) {
  return <span className={`st-tag${tone === undefined ? "" : ` ${tone}`}`} title={title}>{children}</span>;
}

export function SettingsBanner({ tone = "warn", children, action, id }: { tone?: "warn" | "info"; children: ReactNode; action?: ReactNode; id?: string }) {
  const Icon = tone === "warn" ? AlertTriangle : Info;
  return <div className={`st-banner ${tone}`} id={id === undefined ? undefined : settingAnchorId(id)} role={tone === "warn" ? "alert" : "status"}><Icon size={16} /><span>{children}</span>{action}</div>;
}

export function SettingsEmptyLine({ children }: { children: ReactNode }) {
  return <div className="st-empty">{children}</div>;
}

export function SettingsLoading({ label = "读取中…" }: { label?: string }) {
  return <div className="st-empty st-loading"><span className="st-spinner" aria-hidden />{label}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="st-kbd">{children}</kbd>;
}

/** 手机端顶栏：返回 + 居中标题。 */
export function SettingsTopBar({ title, backLabel, onBack }: { title: string; backLabel: string; onBack: () => void }) {
  return <header className="st-topbar">
    <button type="button" className="st-topbar-back" onClick={onBack} aria-label={`返回${backLabel}`}><ChevronLeft size={18} /><span>{backLabel}</span></button>
    <b>{title}</b>
  </header>;
}

/** 设置项锚点 id（搜索跳转、旧地址重定向都靠它定位）。 */
export function settingAnchorId(id: string): string {
  return `setting-${id}`;
}
