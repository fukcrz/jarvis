import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const SUBAGENT_MODES = ["off", "opportunistic", "orchestration"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

export const WIDGET_MODES = ["full", "minimal"] as const;
export type WidgetMode = (typeof WIDGET_MODES)[number];

export const COST_DISPLAY_MODES = ["pi-footer-event", "pi-footer-status", "pi-status"] as const;
export type CostDisplayMode = (typeof COST_DISPLAY_MODES)[number];

export const COST_VALUES = ["subagents", "total"] as const;
export type CostValue = (typeof COST_VALUES)[number];

export const COST_ICONS = ["money", "coins", "wallet"] as const;
export type CostIcon = (typeof COST_ICONS)[number];

export const LOADER_STYLES = [
  "circle",
  "braille",
  "hourglass",
  "ascii",
  "ascii-star",
  "ascii-pulse",
] as const;
export type LoaderStyle = (typeof LOADER_STYLES)[number];

export const TOOL_FILTERING_MODES = ["allowed", "all-except-blocked", "all"] as const;
export type ToolFilteringMode = (typeof TOOL_FILTERING_MODES)[number];

export const MODEL_SELECTION_MODES = [
  "pick-first-available",
  "pick-first-scoped",
  "use-current",
] as const;
export type ModelSelectionMode = (typeof MODEL_SELECTION_MODES)[number];

/** Legacy booleans mean all/none; arrays pin the selected canonical file paths. */
export type SubagentExtensionSelection = boolean | string[];

export function settingsValueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ManagerSettings {
  subagentMode: SubagentMode;
  toolFiltering: ToolFilteringMode;
  widgetMode: WidgetMode;
  costDisplay: CostDisplayMode;
  costValue: CostValue;
  costIcon: CostIcon;
  nerdFontIcons: boolean;
  loaderStyle: LoaderStyle;
  finalRecap: boolean;
  subagentExtensions: SubagentExtensionSelection;
  checklistIntegration: boolean;
  /** [labs] One-line agent work summaries written by the housekeeping model. */
  housekeepingEnabled: boolean;
  /** `provider/model-id` of the housekeeping model; empty means none selected. */
  housekeepingModel: string;
  maxLevels: number;
  maxConcurrent: number;
  maxThreads: number;
  modelSelection: ModelSelectionMode;
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  maxLevels: 3,
  maxConcurrent: 16,
  maxThreads: 64,
  modelSelection: "pick-first-scoped",
  subagentMode: "opportunistic",
  toolFiltering: "all-except-blocked",
  widgetMode: "full",
  costDisplay: "pi-footer-status",
  costValue: "subagents",
  costIcon: "money",
  nerdFontIcons: false,
  loaderStyle: "circle",
  finalRecap: false,
  subagentExtensions: false,
  checklistIntegration: false,
  housekeepingEnabled: false,
  housekeepingModel: "",
};

/** Same `provider/model-id` shape as agent model preferences. */
const HOUSEKEEPING_MODEL = /^[^\s/]+\/[^\s]+$/;
export const isHousekeepingModel = (value: unknown): value is string =>
  typeof value === "string" && (value === "" || HOUSEKEEPING_MODEL.test(value));

const KEYS = [
  "maxLevels",
  "maxConcurrent",
  "maxThreads",
  "modelSelection",
  "subagentMode",
  "toolFiltering",
  "widgetMode",
  "costDisplay",
  "costValue",
  "costIcon",
  "nerdFontIcons",
  "loaderStyle",
  "finalRecap",
  "subagentExtensions",
  "checklistIntegration",
  "housekeepingEnabled",
  "housekeepingModel",
] as const;
const MAX_LEVELS = 32;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertNotSymlinkPath(path: string): ReturnType<typeof lstatSync> | undefined {
  const stat = lstatIfPresent(path);
  if (stat?.isSymbolicLink()) throw new Error(`Unsafe symlink path: ${path}`);
  return stat;
}

function isSupportedKey(key: string): key is (typeof KEYS)[number] {
  return KEYS.includes(key as (typeof KEYS)[number]);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requirement(key: (typeof KEYS)[number]): string {
  if (key === "subagentExtensions")
    return "subagentExtensions must be a boolean or an array of absolute file paths";
  if (
    key === "nerdFontIcons" ||
    key === "finalRecap" ||
    key === "checklistIntegration" ||
    key === "housekeepingEnabled"
  )
    return `${key} must be a boolean`;
  if (key === "housekeepingModel") return "housekeepingModel must be empty or provider/model-id";
  if (key === "subagentMode") return "subagentMode must be off, opportunistic or orchestration";
  if (key === "widgetMode") return "widgetMode must be full or minimal";
  if (key === "costDisplay")
    return "costDisplay must be pi-footer-event, pi-footer-status or pi-status";
  if (key === "costValue") return "costValue must be subagents or total";
  if (key === "costIcon") return "costIcon must be money, coins or wallet";
  if (key === "loaderStyle") return `loaderStyle must be one of: ${LOADER_STYLES.join(", ")}`;
  if (key === "toolFiltering") return "toolFiltering must be allowed, all-except-blocked or all";
  if (key === "modelSelection")
    return "modelSelection must be pick-first-available, pick-first-scoped or use-current";
  return `${key} must be a positive safe integer`;
}

function parseSettings(content: string): Partial<ManagerSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Settings must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isSupportedKey(key) && key !== "scopedModelFiltering")
      throw new Error(`Unknown settings key: ${key}`);
  }
  const layer: Partial<ManagerSettings> = {};
  if (Object.hasOwn(record, "scopedModelFiltering")) {
    if (typeof record.scopedModelFiltering !== "boolean")
      throw new Error("scopedModelFiltering must be a boolean");
    if (!Object.hasOwn(record, "modelSelection"))
      layer.modelSelection = record.scopedModelFiltering
        ? "pick-first-scoped"
        : "pick-first-available";
  }
  for (const key of KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (
      key === "nerdFontIcons" ||
      key === "finalRecap" ||
      key === "checklistIntegration" ||
      key === "housekeepingEnabled"
    ) {
      if (typeof value !== "boolean") throw new Error(requirement(key));
      layer[key] = value;
      continue;
    }
    if (key === "subagentExtensions") {
      if (
        typeof value !== "boolean" &&
        !(
          Array.isArray(value) &&
          value.every(
            (entry) =>
              typeof entry === "string" &&
              entry.length > 0 &&
              resolve(entry) === entry &&
              !entry.includes("\0"),
          )
        )
      )
        throw new Error(requirement(key));
      layer.subagentExtensions =
        typeof value === "boolean" ? value : [...new Set(value as string[])].sort();
      continue;
    }
    if (key === "housekeepingModel") {
      if (!isHousekeepingModel(value)) throw new Error(requirement(key));
      layer.housekeepingModel = value;
      continue;
    }
    if (key === "subagentMode") {
      if (!SUBAGENT_MODES.includes(value as SubagentMode)) throw new Error(requirement(key));
      layer.subagentMode = value as SubagentMode;
      continue;
    }
    if (key === "toolFiltering") {
      if (!TOOL_FILTERING_MODES.includes(value as ToolFilteringMode))
        throw new Error(requirement(key));
      layer.toolFiltering = value as ToolFilteringMode;
      continue;
    }
    if (key === "widgetMode") {
      if (!WIDGET_MODES.includes(value as WidgetMode)) throw new Error(requirement(key));
      layer.widgetMode = value as WidgetMode;
      continue;
    }
    if (key === "costDisplay") {
      if (!COST_DISPLAY_MODES.includes(value as CostDisplayMode)) throw new Error(requirement(key));
      layer.costDisplay = value as CostDisplayMode;
      continue;
    }
    if (key === "costValue") {
      if (!COST_VALUES.includes(value as CostValue)) throw new Error(requirement(key));
      layer.costValue = value as CostValue;
      continue;
    }
    if (key === "costIcon") {
      if (!COST_ICONS.includes(value as CostIcon)) throw new Error(requirement(key));
      layer.costIcon = value as CostIcon;
      continue;
    }
    if (key === "loaderStyle") {
      if (!LOADER_STYLES.includes(value as LoaderStyle)) throw new Error(requirement(key));
      layer.loaderStyle = value as LoaderStyle;
      continue;
    }
    if (key === "modelSelection") {
      if (!MODEL_SELECTION_MODES.includes(value as ModelSelectionMode))
        throw new Error(requirement(key));
      layer.modelSelection = value as ModelSelectionMode;
      continue;
    }
    if (!positiveSafeInteger(value)) throw new Error(requirement(key));
    if (key === "maxLevels" && value > MAX_LEVELS) throw new Error("maxLevels must be <= 32");
    layer[key] = value;
  }
  return layer;
}

interface SettingsLayer {
  filePath: string;
  directories: string[];
}

function layer(base: string, segments: string[]): SettingsLayer {
  let current = resolve(base);
  const directories = [current];
  for (const segment of segments) {
    current = join(current, segment);
    directories.push(current);
  }
  return { filePath: join(current, "settings.json"), directories };
}

function settingsFileExists(entry: SettingsLayer): boolean {
  for (const directory of entry.directories) {
    const stat = assertNotSymlinkPath(directory);
    if (!stat) return false;
    if (!stat.isDirectory())
      throw new Error(`Settings directory must be a directory: ${directory}`);
  }
  const stat = assertNotSymlinkPath(entry.filePath);
  if (!stat) return false;
  if (!stat.isFile()) throw new Error(`Settings must be a regular file: ${entry.filePath}`);
  return true;
}

export type ManagerSaveScope = "user" | "project";

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ManagerSettingsOptions {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
}

export interface ManagerSettingsLayers {
  settings: ManagerSettings;
  diagnostics: string[];
  global: Partial<ManagerSettings>;
  project: Partial<ManagerSettings>;
  scope: ManagerSaveScope;
}

/** Validated layers retain provenance; save scope belongs to the current project. */
export function loadManagerSettingsLayers(options: ManagerSettingsOptions): ManagerSettingsLayers {
  const result: ManagerSettingsLayers = {
    settings: { ...DEFAULT_MANAGER_SETTINGS },
    diagnostics: [],
    global: {},
    project: {},
    scope: "user",
  };
  const layers: ["global" | "project", SettingsLayer][] = [
    ["global", layer(options.agentDir, ["subagent-manager"])],
  ];
  if (options.includeProject)
    layers.push(["project", layer(options.cwd, [".pi", "agent", "subagent-manager"])]);
  for (const [scope, entry] of layers) {
    try {
      if (!settingsFileExists(entry)) continue;
      // Malformed/unreadable regular project files still represent a save destination.
      if (scope === "project") result.scope = "project";
      const parsed = parseSettings(readFileSync(entry.filePath, "utf8"));
      result[scope] = parsed;
      Object.assign(result.settings, parsed);
    } catch (error) {
      result.diagnostics.push(`${entry.filePath}: ${detail(error)}`);
    }
  }
  return result;
}

export function loadManagerSettings(options: ManagerSettingsOptions): {
  settings: ManagerSettings;
  diagnostics: string[];
} {
  const { settings, diagnostics } = loadManagerSettingsLayers(options);
  return { settings, diagnostics };
}

function serializedSettings(settings: ManagerSettings): string {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Settings must be a JSON object");
  }
  for (const key of Object.keys(settings)) {
    if (!isSupportedKey(key)) throw new Error(`Unknown settings key: ${key}`);
  }
  const parsed = parseSettings(JSON.stringify(settings));
  for (const key of KEYS) {
    if (!Object.hasOwn(parsed, key)) throw new Error(requirement(key));
  }
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  const confirmed = parseSettings(serialized);
  for (const key of KEYS) {
    if (!settingsValueEqual(confirmed[key], parsed[key])) throw new Error(requirement(key));
  }
  return serialized;
}

function assertExistingDirectory(directory: string): void {
  const stat = assertNotSymlinkPath(directory);
  if (!stat?.isDirectory()) throw new Error(`Settings directory must be a directory: ${directory}`);
}

function ensureOwnedDirectory(directory: string): void {
  let stat = assertNotSymlinkPath(directory);
  if (!stat) {
    try {
      mkdirSync(directory);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    stat = assertNotSymlinkPath(directory);
  }
  if (!stat?.isDirectory()) throw new Error(`Settings directory must be a directory: ${directory}`);
}

function ensureScopeDirectories(directories: string[]): void {
  assertExistingDirectory(directories[0]);
  for (let index = 1; index < directories.length; index++) {
    assertExistingDirectory(directories[index - 1]);
    ensureOwnedDirectory(directories[index]);
  }
}

function assertRegularFileOrAbsent(filePath: string): void {
  const stat = assertNotSymlinkPath(filePath);
  if (stat && !stat.isFile()) throw new Error(`Settings must be a regular file: ${filePath}`);
}

function exclusiveCreateFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0);
}

function writeAtomically(entry: SettingsLayer, content: string, overwrite = true): void {
  const filePath = entry.filePath;
  const temporary = join(dirname(filePath), `.settings.${randomUUID()}.tmp`);
  let created = false;
  try {
    for (const directory of entry.directories) assertExistingDirectory(directory);
    assertRegularFileOrAbsent(filePath);
    const fd = openSync(temporary, exclusiveCreateFlags(), 0o600);
    created = true;
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    for (const directory of entry.directories) assertExistingDirectory(directory);
    assertRegularFileOrAbsent(filePath);
    const tempStat = assertNotSymlinkPath(temporary);
    if (!tempStat?.isFile()) throw new Error(`Settings must be a regular file: ${temporary}`);
    if (overwrite) renameSync(temporary, filePath);
    else {
      try {
        // Linking a completed temporary file creates the destination without clobbering
        // a settings file that appeared after the initial absence check.
        linkSync(temporary, filePath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        assertRegularFileOrAbsent(filePath);
      }
    }
  } finally {
    if (created) {
      try {
        if (lstatIfPresent(temporary)) unlinkSync(temporary);
      } catch {
        // Keep the original save error if cleanup fails.
      }
    }
  }
}

export function saveManagerSettings(options: {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
  scope: "user" | "project";
  settings: ManagerSettings;
}): string {
  if (options.scope !== "user" && options.scope !== "project") {
    throw new Error("Invalid settings scope");
  }
  if (options.scope === "project" && !options.includeProject) {
    throw new Error("Project settings are not enabled/trusted");
  }
  const content = serializedSettings(options.settings);
  const entry =
    options.scope === "user"
      ? layer(options.agentDir, ["subagent-manager"])
      : layer(options.cwd, [".pi", "agent", "subagent-manager"]);
  ensureScopeDirectories(entry.directories);
  writeAtomically(entry, content);
  return entry.filePath;
}

function assertExpectedLayers(
  current: ManagerSettingsLayers,
  expected: ManagerSettingsLayers,
): void {
  if (
    current.scope !== expected.scope ||
    KEYS.some(
      (key) =>
        !settingsValueEqual(current.global[key], expected.global[key]) ||
        !settingsValueEqual(current.project[key], expected.project[key]),
    ) ||
    current.diagnostics.length !== expected.diagnostics.length ||
    current.diagnostics.some((diagnostic, index) => diagnostic !== expected.diagnostics[index])
  ) {
    throw new Error(
      "Settings changed on disk. Reopen settings before saving or switching scope to avoid stale inherited values.",
    );
  }
}

/** Persist only values that change the selected scope's inherited settings. */
export function saveManagerOverrides(
  options: ManagerSettingsOptions & {
    scope: ManagerSaveScope;
    settings: ManagerSettings;
    expectedLayers?: ManagerSettingsLayers;
  },
): string {
  if (options.scope !== "user" && options.scope !== "project")
    throw new Error("Invalid settings scope");
  if (options.scope === "project" && !options.includeProject)
    throw new Error("Project settings are not enabled/trusted");
  // Validate the complete draft before creating directories or modifying files.
  const parsed = parseSettings(serializedSettings(options.settings));
  const current = loadManagerSettingsLayers(options);
  if (options.expectedLayers) assertExpectedLayers(current, options.expectedLayers);
  if (options.scope === "project") {
    const globalPath = layer(options.agentDir, ["subagent-manager"]).filePath;
    const globalDiagnostics = current.diagnostics.filter((diagnostic) =>
      diagnostic.startsWith(`${globalPath}:`),
    );
    if (globalDiagnostics.length > 0)
      throw new Error(
        `Cannot save project overrides while global settings are invalid. Fix global settings and reopen settings. ${globalDiagnostics.join("; ")}`,
      );
  }
  const inherited =
    options.scope === "user"
      ? DEFAULT_MANAGER_SETTINGS
      : { ...DEFAULT_MANAGER_SETTINGS, ...current.global };
  const overrides = Object.fromEntries(
    KEYS.filter((key) => !settingsValueEqual(parsed[key], inherited[key])).map((key) => [
      key,
      parsed[key],
    ]),
  );
  const entry =
    options.scope === "user"
      ? layer(options.agentDir, ["subagent-manager"])
      : layer(options.cwd, [".pi", "agent", "subagent-manager"]);
  ensureScopeDirectories(entry.directories);
  writeAtomically(entry, `${JSON.stringify(overrides, null, 2)}\n`);
  return entry.filePath;
}

/** Confirmed scope transition: create an empty project layer or remove only its file. */
export function setManagerProjectSettings(
  options: ManagerSettingsOptions & {
    enabled: boolean;
    expectedLayers?: ManagerSettingsLayers;
  },
): string {
  if (!options.includeProject) throw new Error("Project settings are not enabled/trusted");
  if (typeof options.enabled !== "boolean") throw new Error("Invalid project settings state");
  if (options.expectedLayers)
    assertExpectedLayers(loadManagerSettingsLayers(options), options.expectedLayers);
  const entry = layer(options.cwd, [".pi", "agent", "subagent-manager"]);
  const present = settingsFileExists(entry);
  if (options.enabled) {
    if (!present) {
      ensureScopeDirectories(entry.directories);
      writeAtomically(entry, "{}\n", false);
    }
  } else if (present) {
    // Recheck owned paths immediately before deletion; malformed JSON is removable.
    if (settingsFileExists(entry)) unlinkSync(entry.filePath);
  }
  return entry.filePath;
}

/** Resolved settings.json path for a scope; the file may not exist. */
export function managerSettingsPath(
  options: ManagerSettingsOptions,
  scope: ManagerSaveScope,
): string {
  if (scope === "project") {
    if (!options.includeProject) throw new Error("Project settings are not enabled/trusted");
    return layer(options.cwd, [".pi", "agent", "subagent-manager"]).filePath;
  }
  return layer(options.agentDir, ["subagent-manager"]).filePath;
}

/** Restore a scope's defaults by deleting its settings file (nothing is written). A missing file is not an error. */
export function deleteManagerSettings(
  options: ManagerSettingsOptions & { scope: ManagerSaveScope },
): {
  filePath: string;
  deleted: boolean;
} {
  if (options.scope !== "user" && options.scope !== "project")
    throw new Error("Invalid settings scope");
  const filePath = managerSettingsPath(options, options.scope);
  const entry =
    options.scope === "project"
      ? layer(options.cwd, [".pi", "agent", "subagent-manager"])
      : layer(options.agentDir, ["subagent-manager"]);
  // Malformed JSON is removable; symlinks and non-files are refused by settingsFileExists.
  if (!settingsFileExists(entry)) return { filePath, deleted: false };
  unlinkSync(entry.filePath);
  return { filePath, deleted: true };
}
