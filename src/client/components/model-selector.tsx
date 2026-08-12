import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, LoaderCircle } from "lucide-react";
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
  const currentKey = current === undefined ? undefined : modelKey(current);
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const hasOutOfScope = model.available.some((candidate) => !candidate.inScope);
  // 默认只显示启用范围内的模型；当前模型即使不在范围内也保留可见。
  // 「显示全部模型」开关打开后展示所有可用模型，范围外的置灰标记。
  const visible = showAll || !hasOutOfScope
    ? model.available
    : model.available.filter((candidate) => candidate.inScope || modelKey(candidate) === currentKey);
  const grouped = groupByProvider(visible);
  const triggerLabel = current === undefined ? "选择模型" : displayModelName(current.name);

  const trigger = (
    <Button variant="ghost" size="sm" className="model-selector-trigger" aria-label="选择模型" title={triggerLabel} disabled={disabled || pending || model.available.length === 0} onClick={isMobile ? () => setSheetOpen(true) : undefined}>
      {pending ? <LoaderCircle className="spin" size={14} /> : null}
      <span>{triggerLabel}</span>
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
                return <button type="button" key={modelKey(candidate)} className={`selector-sheet-item ${selected ? "selected" : ""} ${candidate.inScope ? "" : "out-of-scope"}`} disabled={selected} onClick={() => { onSelect(candidate); setSheetOpen(false); }}>
                  <span className="selector-sheet-check">{selected ? <Check size={15} /> : null}</span>
                  <span>{displayModelName(candidate.name)}{candidate.inScope ? null : <span className="selector-sheet-tag">未启用</span>}</span>
                </button>;
              })}
            </div>)}
            {hasOutOfScope ? <button type="button" className={`selector-sheet-item selector-sheet-toggle ${showAll ? "selected" : ""}`} onClick={() => setShowAll((value) => !value)}>
              <span className="selector-sheet-check">{showAll ? <Check size={15} /> : null}</span>
              <span>显示全部模型</span>
            </button> : null}
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
              return <DropdownMenu.Item key={modelKey(candidate)} className={`model-menu-item ${selected ? "selected" : ""} ${candidate.inScope ? "" : "out-of-scope"}`} data-model-provider={candidate.provider} data-model-id={candidate.id} disabled={selected} onSelect={() => onSelect(candidate)}>
                <span className="model-menu-check">{selected ? <Check size={14} /> : null}</span>
                <span className="model-menu-label">{displayModelName(candidate.name)}{candidate.inScope ? null : <span className="model-menu-tag">未启用</span>}</span>
              </DropdownMenu.Item>;
            })}
          </div>)}
          {hasOutOfScope ? <>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.CheckboxItem checked={showAll} onCheckedChange={setShowAll} onSelect={(event) => event.preventDefault()} className="model-menu-item model-show-all">
              <span className="model-menu-check"><DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator></span>
              <span className="model-menu-label">显示全部模型</span>
            </DropdownMenu.CheckboxItem>
          </> : null}
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
