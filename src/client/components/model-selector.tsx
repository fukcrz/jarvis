import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { ModelDescriptor, SessionModelSnapshot } from "../../shared/protocol";
import { Button } from "./ui/button";

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

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="secondary" size="sm" className="model-selector-trigger" aria-label="Choose model" title={current?.name ?? "Choose model"} disabled={disabled || pending || model.available.length === 0}>
          {pending ? <LoaderCircle className="spin" size={14} /> : null}
          <span>{current?.name ?? "Choose model"}</span>
          <ChevronDown size={14} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="model-menu" sideOffset={8} align="end">
          {grouped.map(([provider, models], groupIndex) => <div className="model-group" key={provider}>
            {groupIndex === 0 ? null : <DropdownMenu.Separator className="menu-separator" />}
            <DropdownMenu.Label className="model-provider">{provider}</DropdownMenu.Label>
            {models.map((candidate) => {
              const selected = modelKey(candidate) === currentKey;
              return <DropdownMenu.Item key={modelKey(candidate)} className={`model-menu-item ${selected ? "selected" : ""}`} data-model-provider={candidate.provider} data-model-id={candidate.id} disabled={selected} onSelect={() => onSelect(candidate)}>
                <span className="model-menu-check">{selected ? <Check size={14} /> : null}</span>
                <span className="model-menu-label"><strong>{candidate.name}</strong><small>{candidate.id}</small></span>
                {candidate.reasoning ? <span className="model-capability">Reasoning</span> : null}
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
