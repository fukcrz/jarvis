import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, LoaderCircle } from "lucide-react";
import type { SessionThinkingSnapshot, ThinkingLevel } from "../../shared/protocol";
import { useIsMobile } from "../hooks/use-is-mobile";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface ThinkingSelectorProps {
  thinking: SessionThinkingSnapshot;
  disabled: boolean;
  pending: boolean;
  onSelect: (level: ThinkingLevel) => void;
}

export function ThinkingSelector({ thinking, disabled, pending, onSelect }: ThinkingSelectorProps) {
  const selectable = thinking.available.length > 1;
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  const trigger = (
    <Button variant="ghost" size="sm" className="thinking-selector-trigger" aria-label="Thinking level" title={`Thinking: ${thinking.current}`} disabled={disabled || pending || !selectable} onClick={isMobile ? () => setSheetOpen(true) : undefined}>
      {pending ? <LoaderCircle className="spin" size={14} /> : null}
      <span>{thinking.current}</span>
    </Button>
  );

  if (isMobile) {
    return (
      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        {trigger}
        <DialogContent className="selector-sheet" title="思考等级">
          <div className="selector-sheet-list">
            {thinking.available.map((level) => {
              const selected = level === thinking.current;
              return <button type="button" key={level} className={`selector-sheet-item ${selected ? "selected" : ""}`} disabled={selected} onClick={() => { onSelect(level); setSheetOpen(false); }}>
                <span className="selector-sheet-check">{selected ? <Check size={15} /> : null}</span>
                <span>{level}</span>
              </button>;
            })}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
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
