import type { ModelDescriptor, SessionModelSnapshot } from "../shared/protocol.js";

/** Project Pi model objects into the stable browser-facing protocol. */
export function projectModelSnapshot(current: unknown, available: readonly unknown[]): SessionModelSnapshot {
  const projected = new Map<string, ModelDescriptor>();
  for (const model of available) {
    const descriptor = projectModel(model);
    if (descriptor !== undefined && !projected.has(modelKey(descriptor))) projected.set(modelKey(descriptor), descriptor);
  }

  const selected = projectModel(current);
  return {
    ...(selected === undefined ? {} : { current: selected }),
    available: [...projected.values()].sort(compareModels),
  };
}

function projectModel(value: unknown): ModelDescriptor | undefined {
  if (!isRecord(value)) return undefined;
  const provider = stringValue(value["provider"]);
  const id = stringValue(value["id"]);
  if (provider === "" || id === "") return undefined;
  return {
    provider,
    id,
    name: stringValue(value["name"]) || id,
    reasoning: value["reasoning"] === true,
  };
}

function compareModels(left: ModelDescriptor, right: ModelDescriptor): number {
  return left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function modelKey(model: ModelDescriptor): string {
  return `${model.provider}\u0000${model.id}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
