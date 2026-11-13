import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ListTree, X } from "lucide-react";
import { SIDE_CHAT_MAX_WIDTH, SIDE_CHAT_MIN_WIDTH } from "../hooks/use-side-chat-resize";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

export type RightDockTab = "chat" | "subagent";

const TAB_STORAGE_KEY = "jarvis.right-dock.tab";

export function readDockTab(): RightDockTab {
  try {
    return window.localStorage.getItem(TAB_STORAGE_KEY) === "subagent" ? "subagent" : "chat";
  } catch {
    return "chat";
  }
}

export function persistDockTab(tab: RightDockTab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // 存储不可用时维持默认 tab。
  }
}

const OPEN_STORAGE_KEY = "jarvis.right-dock.open";
const OPEN_STORAGE_LIMIT = 200;

/** 面板开关按会话记忆，刷新后恢复。 */
export function readDockOpenState(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(OPEN_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "boolean") result[key] = value;
    return result;
  } catch {
    return {};
  }
}

export function persistDockOpenState(state: Record<string, boolean>): void {
  try {
    const keys = Object.keys(state).slice(-OPEN_STORAGE_LIMIT);
    window.localStorage.setItem(OPEN_STORAGE_KEY, JSON.stringify(Object.fromEntries(keys.map((key) => [key, state[key] === true]))));
  } catch {
    // 存储不可用时只在当前页面内生效。
  }
}

interface RightDockProps {
  tab: RightDockTab;
  onTabChange: (tab: RightDockTab) => void;
  onClose: () => void;
  runningCount: number;
  width?: number;
  resizing?: boolean;
  onStartResize?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeWithKeyboard?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onResetWidth?: () => void;
  onStopResize?: (pointerId?: number) => void;
  chat: ReactNode;
  subagent: ReactNode;
}

/** 右侧停靠面板：侧聊与子代理共用一条宽度和一个拖拽手柄。 */
export function RightDock({ tab, onTabChange, onClose, runningCount, width, resizing, onStartResize, onResizeWithKeyboard, onResetWidth, onStopResize, chat, subagent }: RightDockProps) {
  return <aside className={`side-chat-drawer right-dock${resizing === true ? " side-chat-drawer-resizing" : ""}`} style={width === undefined ? undefined : { width: `${String(width)}px` }} aria-label="右侧面板">
    <div
      className="side-chat-resizer"
      role="separator"
      aria-label="调整面板宽度"
      aria-orientation="vertical"
      aria-valuemin={SIDE_CHAT_MIN_WIDTH}
      aria-valuemax={SIDE_CHAT_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onDoubleClick={onResetWidth}
      onKeyDown={onResizeWithKeyboard}
      onLostPointerCapture={() => { onStopResize?.(); }}
      onPointerDown={onStartResize}
    />
    <header className="side-chat-header right-dock-header">
      <div className="right-dock-tabs" role="tablist" aria-label="右侧面板">
        <button type="button" role="tab" id="right-dock-tab-chat" aria-selected={tab === "chat"} aria-controls="right-dock-panel" className="right-dock-tab" onClick={() => { onTabChange("chat"); }}>侧聊</button>
        <button type="button" role="tab" id="right-dock-tab-subagent" aria-selected={tab === "subagent"} aria-controls="right-dock-panel" className="right-dock-tab" onClick={() => { onTabChange("subagent"); }}>
          子代理
          {runningCount > 0 ? <span className="right-dock-badge" role="status" aria-label="子代理运行中">{String(runningCount)}</span> : null}
        </button>
      </div>
      <Tooltip label="关闭"><Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}><X size={15} /></Button></Tooltip>
    </header>
    <div className="right-dock-body" role="tabpanel" id="right-dock-panel" aria-labelledby={tab === "chat" ? "right-dock-tab-chat" : "right-dock-tab-subagent"}>{tab === "chat" ? chat : subagent}</div>
  </aside>;
}

export function SubagentToggle({ open, running, disabled, onClick }: { open: boolean; running: number; disabled?: boolean; onClick: () => void }) {
  return <Tooltip label="子代理"><Button variant="ghost" size="icon" className={`side-chat-toggle${open ? " active" : ""}`} aria-label="子代理" aria-pressed={open} disabled={disabled} onClick={onClick}>
    <ListTree size={16} />
    {running > 0 ? <span className="right-dock-toggle-badge" role="status" aria-label="子代理运行中">{String(running)}</span> : null}
  </Button></Tooltip>;
}
