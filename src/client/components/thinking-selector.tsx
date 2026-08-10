import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Brain, Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { SessionThinkingSnapshot, ThinkingLevel } from "../../shared/protocol";
import { Button } from "./ui/button";

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

interface ThinkingSelectorProps {
  thinking: SessionThinkingSnapshot;
  disabled: boolean;
  pending: boolean;
  onSelect: (level: ThinkingLevel) => void;
}

export function ThinkingSelector({ thinking, disabled, pending, onSelect }: ThinkingSelectorProps) {
  const currentLabel = thinkingLabels[thinking.current];
  const selectable = thinking.available.length > 1;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="secondary" size="sm" className="thinking-selector-trigger" aria-label="选择思考等级" title={`思考等级：${currentLabel}`} disabled={disabled || pending || !selectable}>
          {pending ? <LoaderCircle className="spin" size={14} /> : <Brain size={14} />}
          <span>{currentLabel}</span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-menu thinking-menu" sideOffset={8} align="start">
          {thinking.available.map((level) => {
            const selected = level === thinking.current;
            return <DropdownMenu.Item key={level} className={`model-menu-item ${selected ? "selected" : ""}`} disabled={selected} onSelect={() => onSelect(level)}>
              <span className="model-menu-check">{selected ? <Check size={14} /> : null}</span>
              <span className="model-menu-label">{thinkingLabels[level]}</span>
            </DropdownMenu.Item>;
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
