const MODEL_IDENTITY = /^[^\s/]+\/[^\s]+$/;
const ALIAS_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateModelPreference(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODEL_IDENTITY.test(value))
    throw new Error(`${label} must be provider/model-id`);
  return value;
}

/**
 * Named model references exposed to callers (`agent_spawn({ model: "strong" })`).
 * Aliases are suggestions, not a whitelist: any available model stays selectable.
 */
export function getModelAliases(type: { modelAliases?: unknown }): Record<string, string> {
  const raw = type.modelAliases;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("modelAliases must be a mapping of alias name to provider/model-id");
  const aliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALIAS_NAME.test(name))
      throw new Error(
        `modelAliases key ${JSON.stringify(name)} must be a safe identifier using letters, numbers, underscores or hyphens`,
      );
    aliases[name] = validateModelPreference(value, `modelAliases.${name}`);
  }
  return aliases;
}

/** Alias to concrete reference; anything else passes through so plain model ids keep working. */
export function resolveModelReference(type: { modelAliases?: unknown }, reference: string): string {
  return getModelAliases(type)[reference] ?? reference;
}

/** `strong=model-groups/sol, cheap=...` for display; undefined when no aliases are declared. */
export function formatModelAliases(type: { modelAliases?: unknown }): string | undefined {
  const entries = Object.entries(getModelAliases(type));
  return entries.length === 0 ? undefined : entries.map(([name, value]) => `${name}=${value}`).join(", ");
}

export function getModelPreferences(type: {
  models?: unknown;
  model?: unknown;
}): string[] | undefined {
  const hasModels = type.models !== undefined;
  const hasModel = type.model !== undefined;
  if (hasModels && hasModel) throw new Error("Specify either models or model, not both");
  if (hasModels) {
    if (!Array.isArray(type.models))
      throw new Error("models must be an array of provider/model-id strings");
    if (type.models.length === 0)
      throw new Error("models must not be empty; omit models to inherit the parent/default model");
    const models = type.models.map((value, index) =>
      validateModelPreference(value, `models[${index}]`),
    );
    if (new Set(models).size !== models.length)
      throw new Error("models contains duplicate entries");
    return [...models];
  }
  if (hasModel) return [validateModelPreference(type.model, "model")];
  return undefined;
}

export function modelIdentity(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

export class ModelPreferenceError extends Error {
  constructor(
    message: string,
    readonly scopedModelFiltering: boolean,
  ) {
    super(message);
  }

  get summary(): string {
    return this.scopedModelFiltering
      ? "No preferred model is available in /scoped-models; update the scope or this type's models."
      : "No preferred model is available; check provider credentials or this type's models.";
  }
}

export function selectPreferredModel(
  type: { name: string; models?: unknown; model?: unknown; modelAliases?: unknown },
  eligibleModels: readonly { model: { provider: string; id: string } }[],
  scopedModelFiltering = true,
): string | undefined {
  // An alias table doubles as the default preference chain, in declaration order.
  const declared = getModelPreferences(type);
  const aliasValues = Object.values(getModelAliases(type));
  const preferences =
    declared ?? (aliasValues.length === 0 ? undefined : aliasValues);
  if (preferences === undefined) return undefined;
  const available = eligibleModels.map(({ model }) => modelIdentity(model));
  for (const preference of preferences) {
    if (available.includes(preference)) return preference;
  }
  const preferenceList = `[${preferences.join(", ")}]`;
  const availableList = available.length === 0 ? "(none)" : `[${available.join(", ")}]`;
  if (!scopedModelFiltering) {
    throw new ModelPreferenceError(
      `Agent type ${JSON.stringify(type.name)} prefers models ${preferenceList}, but none are available. Available models: ${availableList}. Update this agent type's models list.`,
      false,
    );
  }
  throw new ModelPreferenceError(
    `Agent type ${JSON.stringify(type.name)} prefers scoped models ${preferenceList}, but none are available in /scoped-models. Available scoped models: ${availableList}. Update /scoped-models or this agent type's models list.`,
    true,
  );
}
