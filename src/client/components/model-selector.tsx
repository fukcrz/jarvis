import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { ModelDescriptor, SessionModelSnapshot } from "../../shared/protocol";
import { useIsMobile } from "../hooks/use-is-mobile";
import { displayModelName } from "../model-display";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

interface ModelSelectorProps {
  model: SessionModelSnapshot;
  disabled: boolean;
  pending: boolean;
  onSelect: (model: ModelDescriptor) => void;
}

export function ModelSelector({ model, disabled, pending, onSelect }: ModelSelectorProps) {
  const current = model.current;
  const grouped = groupByProvider(model.available);
  const currentKey = current === undefined ? undefined : modelKey(current);
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const triggerLabel = current === undefined ? "选择模型" : displayModelName(current.name);

  const trigger = (
    <Button variant="ghost" size="sm" className="model-selector-trigger" aria-label="选择模型" title={triggerLabel} disabled={disabled || pending || model.available.length === 0} onClick={isMobile ? () => setSheetOpen(true) : undefined}>
      {pending ? <LoaderCircle className="spin" size={14} /> : null}
      <span>{triggerLabel}</span>
      <ChevronDown size={14} />
    </Button>
  );

  if (isMobile) {
    return (
      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        {trigger}
        <DialogContent className="selector-sheet" title="选择模型">
          <div className="selector-sheet-list">
            {grouped.map(([provider, models]) => <div className="selector-sheet-group" key={provider}>
              <div className="selector-sheet-provider">{provider}</div>
              {models.map((candidate) => {
                const selected = modelKey(candidate) === currentKey;
                return <button type="button" key={modelKey(candidate)} className={`selector-sheet-item ${selected ? "selected" : ""}`} disabled={selected} onClick={() => { onSelect(candidate); setSheetOpen(false); }}>
                  <span className="selector-sheet-check">{selected ? <Check size={15} /> : null}</span>
                  <span>{displayModelName(candidate.name)}</span>
                </button>;
              })}
            </div>)}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-menu" sideOffset={8} align="end">
          {grouped.map(([provider, models], groupIndex) => <div className="model-group" key={provider}>
            {groupIndex === 0 ? null : <DropdownMenu.Separator className="menu-separator" />}
            <DropdownMenu.Label className="model-provider">{provider}</DropdownMenu.Label>
            {models.map((candidate) => {
              const selected = modelKey(candidate) === currentKey;
              return <DropdownMenu.Item key={modelKey(candidate)} className={`model-menu-item ${selected ? "selected" : ""}`} data-model-provider={candidate.provider} data-model-id={candidate.id} disabled={selected} onSelect={() => onSelect(candidate)}>
                <span className="model-menu-check">{selected ? <Check size={14} /> : null}</span>
                <span className="model-menu-label">{displayModelName(candidate.name)}</span>
              </DropdownMenu.Item>;
            })}
          </div>)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function groupByProvider(models: ModelDescriptor[]): Array<[string, ModelDescriptor[]]> {
  const groups = new Map<string, ModelDescriptor[]>();
  for (const model of models) {
    const group = groups.get(model.provider) ?? [];
    group.push(model);
    groups.set(model.provider, group);
  }
  return [...groups.entries()];
}

function modelKey(model: Pick<ModelDescriptor, "provider" | "id">): string {
  return `${model.provider}\u0000${model.id}`;
}
