import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { DETAIL_LEVELS, type DetailLevel } from "../lib/detail-level";
import { useIsMobile } from "../hooks/use-is-mobile";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

export function DetailLevelSelector({ value, onChange }: { value: DetailLevel; onChange: (level: DetailLevel) => void }) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const current = DETAIL_LEVELS.find((level) => level.value === value) ?? DETAIL_LEVELS[1]!;
  const trigger = <Button variant="ghost" size="sm" className="thinking-selector-trigger detail-level-trigger" aria-label="过程显示详略" title={`过程显示：${current.label}`} onClick={isMobile ? () => setSheetOpen(true) : undefined}>
    <span>{current.label}</span>
  </Button>;

  if (isMobile) {
    return <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
      {trigger}
      <DialogContent className="selector-sheet" title="过程显示">
        <div className="selector-sheet-list">
          {DETAIL_LEVELS.map((level) => {
            const selected = level.value === value;
            return <button type="button" key={level.value} className={`selector-sheet-item ${selected ? "selected" : ""}`} disabled={selected} onClick={() => { onChange(level.value); setSheetOpen(false); }}>
              <span className="selector-sheet-check">{selected ? <Check size={15} /> : null}</span>
              <span>{level.label}<small className="detail-level-hint">{level.hint}</small></span>
            </button>;
          })}
        </div>
      </DialogContent>
    </Dialog>;
  }

  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="model-menu thinking-menu detail-level-menu" sideOffset={8} align="start">
        {DETAIL_LEVELS.map((level) => {
          const selected = level.value === value;
          return <DropdownMenu.Item key={level.value} className={`model-menu-item thinking-menu-item ${selected ? "selected" : ""}`} disabled={selected} onSelect={() => onChange(level.value)}>
            <span className="model-menu-label">{level.label}</span>
            <small className="detail-level-hint">{level.hint}</small>
          </DropdownMenu.Item>;
        })}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
