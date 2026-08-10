import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { SessionThinkingSnapshot, ThinkingLevel } from "../../shared/protocol";
import { Button } from "./ui/button";

interface ThinkingSelectorProps {
  thinking: SessionThinkingSnapshot;
  disabled: boolean;
  pending: boolean;
  onSelect: (level: ThinkingLevel) => void;
}

export function ThinkingSelector({ thinking, disabled, pending, onSelect }: ThinkingSelectorProps) {
  const selectable = thinking.available.length > 1;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" className="thinking-selector-trigger" aria-label="Thinking level" title={`Thinking: ${thinking.current}`} disabled={disabled || pending || !selectable}>
          <span>{thinking.current}</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-menu thinking-menu" sideOffset={8} align="start">
          {thinking.available.map((level) => {
            const selected = level === thinking.current;
            return <DropdownMenu.Item key={level} className={`model-menu-item thinking-menu-item ${selected ? "selected" : ""}`} disabled={selected} onSelect={() => onSelect(level)}>
              <span className="model-menu-label">{level}</span>
            </DropdownMenu.Item>;
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
