import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { discoverSubagentExtensions, extensionDisplayName } from "../orch/extensions.ts";
import type { ConfigStore } from "../prefs/config.ts";
import {
  canOpenDialog,
  dialogInput,
  dialogMenu,
  withDialogSession,
  type DialogRow,
} from "./dialog.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  settingsValueEqual,
  type CostDisplayMode,
  COST_ICONS,
  type CostIcon,
  type CostValue,
  LOADER_STYLES,
  type LoaderStyle,
  deleteManagerSettings,
  loadManagerSettingsLayers,
  managerSettingsPath,
  saveManagerOverrides,
  setManagerProjectSettings,
  type ManagerSettings,
  type ModelSelectionMode,
  type SubagentMode,
  type ToolFilteringMode,
  type WidgetMode,
} from "../prefs/settings.ts";
import { editAgentTypes, type AgentEditorOptions } from "./ui.ts";
import { HOUSEKEEPING_PICKER_CANCEL, pickHousekeepingModel } from "./model-picker.ts";
import type { ToolEditorOptions } from "./tool-picker.ts";
import { AGENT_LOADERS, availableLoaderStyles, effectiveLoaderStyle } from "./agent-loader.ts";
import { costIconGlyph } from "./cost-footer.ts";
import { CHECKLIST_REQUIREMENTS, type ChecklistStatus } from "../orch/checklist-integration.ts";

const LOADER_OPTIONS = LOADER_STYLES.map((id) => {
  const loader = AGENT_LOADERS[id];
  return {
    id,
    label: loader.label,
    value: `${loader.frames.join(" ")} · ${Object.values(loader.states).join(" ")}`,
    help: `Each row: all starting/running frames · completed, paused, failed, stopped.\nStarting/running: ${loader.frames.join(" ")}\nCompleted: ${loader.states.completed} · Paused: ${loader.states.paused}\nFailed: ${loader.states.failed} · Stopped: ${loader.states.stopped}\n${loader.requiresNerdFont ? "Requires [lab] Nerd Font icons On." : id === "braille" ? "Standard Unicode Braille; no Nerd Font needed." : "ASCII only; no special font needed."} The loader appears before the role icon when enabled.`,
  };
});

const FIELDS = [
  {
    id: "maxLevels",
    label: "Maximum levels",
    help: "How deep agents can delegate.\nYour main conversation is level 1; 3 allows an agent and its child.\nPositive integer, at most 32.",
  },
  {
    id: "maxConcurrent",
    label: "Concurrent agents",
    help: "How many agents can be active at once across all levels.\nParents waiting for children also count.\nPositive safe integer.",
  },
  {
    id: "maxThreads",
    label: "Retained threads",
    help: "How many agent sessions can be kept for follow-up work, including completed and paused agents.\nAt the limit, new agents cannot start.\nPositive safe integer.",
  },
] as const;

const MODE_OPTIONS = [
  {
    id: "off",
    label: "Off",
    value: "No subagent tools or prompt guidance",
    help: "Off: hide subagent tools and inject no subagent guidance into the system prompt.\nExisting work and retained sessions are kept.",
  },
  {
    id: "opportunistic",
    label: "Opportunistic",
    value: "Parallelizable or very large tasks only",
    help: "Opportunistic: make subagent tools available.\nDelegate only when tasks can be parallelized or a task is very large; otherwise work directly.",
  },
  {
    id: "orchestration",
    label: "Orchestration",
    value: "/root coordinates; subagents execute",
    help: "Orchestration: tell /root to delegate all task execution to subagents and only coordinate and synthesize results.\nThis rule is not inherited by workers.",
  },
] as const;

const MODE_HELP =
  "Off: no subagent tools or prompt guidance.\nOpportunistic: delegate only parallelizable or very large tasks.\nOrchestration: /root delegates all execution and only coordinates and synthesizes results.";

const TOOL_FILTERING_OPTIONS = [
  {
    id: "allowed",
    label: "Allowed (except blocked)",
    value: "Allow list minus block list",
    help: "Only tools in the agent YAML allow list are available, minus its block list.\nBlocked tools take precedence. A missing or empty allow list means no tools.",
  },
  {
    id: "all-except-blocked",
    label: "All except blocked",
    value: "Ignore allow list",
    help: "All available tools except those in the agent YAML block list.\nThe allow list is completely ignored.",
  },
  {
    id: "all",
    label: "All",
    value: "Ignore both lists",
    help: "All available tools.\nThe agent YAML allow and block lists are completely ignored.",
  },
] as const;

const TOOL_FILTERING_HELP =
  "Allowed (except blocked): only allow-listed tools, minus blocked tools; a missing or empty allow list means no tools.\nAll except blocked: ignore the allow list; block-listed tools remain blocked.\nAll: ignore both lists.\nSave and apply to affect agents when their sessions start.";

const WIDGET_MODE_OPTIONS = [
  {
    id: "full",
    label: "Full",
    value: "Detailed agent status rows",
    help: "Full: show the existing agent status widget above the input box, with per-agent details.",
  },
  {
    id: "minimal",
    label: "Minimal",
    value: "One-line counts and running-agent tokens",
    help: "Minimal: show status counts in one line above the input box.\nStarting agents count as running. Token totals include only active (starting/running) agents.",
  },
] as const;

const WIDGET_MODE_HELP =
  "Full: detailed agent status rows above the input box.\nMinimal: one-line status counts and cumulative input/output tokens for active (starting/running) agents.\nSave and apply to update the widget immediately.";

const COST_DISPLAY_OPTIONS = [
  {
    id: "off",
    label: "Off",
    help: "Do not show cost in the footer or status area.",
  },
  {
    id: "pi-status",
    label: "Replace Pi status",
    help: "Show the selected cost in Pi’s status area, without replacing the whole footer. Third-party footers may also consume this status.",
  },
  {
    id: "pi-footer-status",
    label: "pi-footer status widget",
    value: "subagent_cost",
    help: "Status key: subagent_cost\nSelect subagent_cost in pi-footer’s Extension Status widget. Does not replace your footer.",
  },
  {
    id: "pi-footer-event",
    label: "pi-footer event",
    value: "subagent_cost",
    help: "Event: pi-footer:update-widget\nWidget ID: subagent_cost\nAdd a Pi Event Value widget and enable Raw value only. Without an external /footer, retain the cost fallback.",
  },
] as const;

const COST_VALUE_OPTIONS = [
  {
    id: "subagents",
    label: "Only subagent cost",
    help: "Settled USD cost of all subagents; excludes the main session.",
  },
  {
    id: "total",
    label: "Total cost",
    help: "Main session USD cost plus all settled subagent costs.",
  },
] as const;

const COST_ICON_LABELS = { money: "Money", coins: "Coins", wallet: "Wallet" } as const;

type SettingsLayers = ReturnType<typeof loadManagerSettingsLayers>;

/** Persisted changes, not unsaved draft values; theme styling is computed on render. */
function withProvenance(
  row: DialogRow,
  keys: (keyof ManagerSettings)[],
  layers: SettingsLayers,
): DialogRow {
  const globalChanged = keys.some(
    (key) =>
      layers.global[key] !== undefined &&
      !settingsValueEqual(layers.global[key], DEFAULT_MANAGER_SETTINGS[key]),
  );
  const projectChanged = keys.some(
    (key) =>
      layers.project[key] !== undefined &&
      !settingsValueEqual(layers.project[key], layers.global[key] ?? DEFAULT_MANAGER_SETTINGS[key]),
  );
  return {
    ...row,
    renderIndicators: (theme) =>
      (globalChanged ? theme.fg("accent", "●") : " ") +
      " " +
      (projectChanged ? theme.fg("warning", "●") : " "),
    help: `${row.label}\n${row.help ?? ""}`,
  };
}

function provenanceLegend(theme: Theme): string {
  const global = theme.fg("accent", "●");
  const project = theme.fg("warning", "●");
  return (
    theme.fg("muted", "Saved: ") +
    `${global} Global · ${project} Current Project · ${global} ${project} Both`
  );
}

/** Selection edits stay in the outer draft until Save and apply. */
async function configureSubagentExtensions(
  ctx: ExtensionCommandContext,
  draft: ManagerSettings,
  agentDir: string,
): Promise<void> {
  const available = await discoverSubagentExtensions({
    cwd: ctx.cwd,
    agentDir,
    projectTrusted: ctx.isProjectTrusted(),
  });
  const selected = new Set(
    draft.subagentExtensions === true ? available : draft.subagentExtensions || [],
  );
  // Keep stale selections visible and removable; runtime still intersects with discovery.
  const files = [...new Set([...available, ...selected])].sort();
  let selectedId: string | undefined;
  while (true) {
    const action = await dialogMenu(
      ctx,
      "[lab] Subagent extensions",
      [
        ...files.map((file) => ({
          id: file,
          label: `${selected.has(file) ? "[x]" : "[ ]"} ${extensionDisplayName(file)}`,
          value: available.includes(file) ? (selected.has(file) ? "On" : "Off") : "Unavailable",
          help: `${file}\n${available.includes(file) ? "Reload this extension in newly opened subagent sessions." : "Not currently discoverable/trusted; will not load. Toggle Off to remove the saved selection."}\nSpace/Enter toggles. Changes are saved only with outer Save and apply.`,
        })),
        {
          id: "back",
          label: "Back",
          help: files.length
            ? "Return to settings; selection is not saved yet."
            : "No extensions available (configured or auto-discovered). CLI-only, inline, built-in extensions and this manager are excluded.",
        },
      ],
      { selectedId, spaceSelect: true, footer: "↑↓/Tab navigate · Space/Enter toggle · Esc back" },
    );
    if (!action || action === "back") {
      draft.subagentExtensions = [...selected].sort();
      return;
    }
    selectedId = action;
    if (selected.has(action)) selected.delete(action);
    else selected.add(action);
  }
}

/** Edits the shared draft; only the outer settings screen saves or applies it. */
async function configureFooterDisplay(
  ctx: ExtensionCommandContext,
  draft: ManagerSettings,
  layers: SettingsLayers,
): Promise<void> {
  let selectedId: string | undefined;
  while (true) {
    const action = await dialogMenu(
      ctx,
      "[lab] Footer display",
      (
        [
          {
            id: "location",
            label: "Location",
            value: COST_DISPLAY_OPTIONS.find((option) => option.id === draft.costDisplay)!.label,
            help: "Choose Pi status, a pi-footer status widget, or a pi-footer event. Integration IDs are shown in the location picker.",
          },
          {
            id: "value",
            label: "Display value",
            value: COST_VALUE_OPTIONS.find((option) => option.id === draft.costValue)!.label,
            help: "Show only settled subagent cost, or main session plus settled subagents. Applies to every location.",
          },
          {
            id: "icon",
            label: "Icon",
            value: `${costIconGlyph(draft.costIcon, draft.nerdFontIcons)} ${COST_ICON_LABELS[draft.costIcon]}`,
            help: `Choose a money-related ${draft.nerdFontIcons ? "Nerd Font" : "emoji"} icon. The family follows [lab] Nerd Font icons.`,
          },
          {
            id: "back",
            label: "Back",
            help: "Return to settings. Save and apply there to commit these changes.",
          },
        ] as DialogRow[]
      ).map((row) => {
        const key = (
          { location: "costDisplay", value: "costValue", icon: "costIcon" } as Record<
            string,
            keyof ManagerSettings
          >
        )[row.id];
        return key ? withProvenance(row, [key], layers) : row;
      }),
      {
        selectedId,
        renderLegend: provenanceLegend,
        footer: "↑↓/Tab navigate · Enter edit · Esc back",
      },
    );
    if (!action || action === "back") return;
    selectedId = action;
    if (action === "location") {
      const mode = await dialogMenu(ctx, "Footer location", [...COST_DISPLAY_OPTIONS], {
        selectedId: draft.costDisplay,
      });
      if (COST_DISPLAY_OPTIONS.some((option) => option.id === mode))
        draft.costDisplay = mode as CostDisplayMode;
    } else if (action === "value") {
      const value = await dialogMenu(ctx, "Footer display value", [...COST_VALUE_OPTIONS], {
        selectedId: draft.costValue,
      });
      if (COST_VALUE_OPTIONS.some((option) => option.id === value))
        draft.costValue = value as CostValue;
    } else if (action === "icon") {
      const icon = await dialogMenu(
        ctx,
        `Footer icon · ${draft.nerdFontIcons ? "Nerd Font" : "Emoji"}`,
        COST_ICONS.map((id) => ({
          id,
          label: COST_ICON_LABELS[id],
          value: costIconGlyph(id, draft.nerdFontIcons),
          help: `${costIconGlyph(id, draft.nerdFontIcons)} ${COST_ICON_LABELS[id]} · ${draft.nerdFontIcons ? "Requires a Nerd Font in your terminal." : "Emoji icon."}`,
        })),
        { selectedId: draft.costIcon },
      );
      if (COST_ICONS.includes(icon as CostIcon)) draft.costIcon = icon as CostIcon;
    }
  }
}

function housekeepingValue(draft: ManagerSettings): string {
  if (!draft.housekeepingEnabled) return "Off";
  return draft.housekeepingModel ? `On · ${draft.housekeepingModel}` : "On · no model selected";
}

const HOUSEKEEPING_HELP =
  "Experimental: a model you choose writes a one-line summary of each running agent's current work, shown in the tree and widget instead of raw tool-call status.\nSends the agent's task and recent tool names/arguments/text to the selected model, uses extra tokens, and is not included in subagent cost totals.\nOff by default. Any failure keeps the original status. Choose from available and scoped models.";

/** Edits the shared draft; only the outer settings screen saves or applies it. */
async function configureHousekeeping(
  ctx: ExtensionCommandContext,
  draft: ManagerSettings,
  layers: SettingsLayers,
): Promise<void> {
  let selectedId: string | undefined;
  while (true) {
    const action = await dialogMenu(
      ctx,
      "[lab] Housekeeping model",
      (
        [
          {
            id: "enabled",
            label: "Summaries",
            value: draft.housekeepingEnabled ? "On" : "Off",
            help: "Name each running agent's work in one line using the housekeeping model, replacing raw tool-call status in the tree and widget.\nInactive until a model is selected. Off by default.",
          },
          {
            id: "model",
            label: "Model",
            value: draft.housekeepingModel || "Not selected",
            valueColor: draft.housekeepingModel ? undefined : ("muted" as const),
            help: "Pick any available model; scoped models are listed first. A small, fast, inexpensive model is usually enough.\nIf the model later becomes unavailable (no credentials, removed), summaries stay inactive and normal status shows.",
          },
          {
            id: "back",
            label: "Back",
            help: "Return to settings. Save and apply there to commit these changes.",
          },
        ] as DialogRow[]
      ).map((row) => {
        const key = (
          { enabled: "housekeepingEnabled", model: "housekeepingModel" } as Record<
            string,
            keyof ManagerSettings
          >
        )[row.id];
        return key ? withProvenance(row, [key], layers) : row;
      }),
      {
        selectedId,
        renderLegend: provenanceLegend,
        footer: "↑↓/Tab navigate · Enter edit · Esc back",
      },
    );
    if (!action || action === "back") return;
    selectedId = action;
    if (action === "enabled") draft.housekeepingEnabled = !draft.housekeepingEnabled;
    else if (action === "model") {
      const picked = await pickHousekeepingModel(ctx, draft.housekeepingModel);
      if (picked !== HOUSEKEEPING_PICKER_CANCEL) draft.housekeepingModel = picked;
    }
  }
}

const MODEL_SELECTION_OPTIONS = [
  {
    id: "pick-first-available",
    label: "Pick First (available)",
    value: "First available model in the agent's list",
    help: "Pick First (available):\nPick the first model in the agent's models list available in Pi with an enabled, authenticated provider.\nSkip missing models and providers without credentials; try the next preference.",
  },
  {
    id: "pick-first-scoped",
    label: "Pick First (scoped)",
    value: "First available preference in the session scope",
    help: "Pick First (scoped):\nPick the first available model in the agent's models list that is also selected in the current session's /scoped-models.\nSkip unavailable models and providers without credentials.",
  },
  {
    id: "use-current",
    label: "Use Current",
    value: "Use the main session's current model",
    help: "Use Current:\nIgnore the agent's models list and use the main session's current model.\nKeep each agent's configured thinking level, not the main session's thinking level.",
  },
] as const;

const MODEL_SELECTION_HELP =
  "Pick First (available): first preference with an enabled, authenticated provider in Pi.\nPick First (scoped): same, limited to the current session's /scoped-models.\nUse Current: ignore models and use the main session's current model; keep the agent's thinking level.\nOnly the models list affects runtime picking; modelSuggestions are search hints.\nSave and apply to affect agents when their sessions start.";

export async function configureAgents(
  ctx: ExtensionCommandContext,
  options: {
    store: ConfigStore;
    settings: ManagerSettings;
    agentDir: string;
    getAllTools?: ToolEditorOptions["getAllTools"];
    resolveAgentSettings?: AgentEditorOptions["resolveAgentSettings"];
    /** Live pi-checklist eligibility; absent means unavailable (fail closed). */
    checklistStatus?: () => ChecklistStatus;
    apply(): void;
  },
): Promise<void> {
  if (!canOpenDialog(ctx)) return;
  await withDialogSession(ctx, (scoped) => configureAgentsDialog(scoped, options));
}

/** Always shown; "disabled" (muted, guarded) unless pi-checklist prerequisites currently hold. */
function checklistRow(enabled: boolean, status: ChecklistStatus): DialogRow {
  const requirements = `${CHECKLIST_REQUIREMENTS}\nWhen On and eligible, adds prompt guidance to tag which agent works on each checklist task via meta.agent; in Orchestration mode /root must use the checklist. Off by default.`;
  if (status.eligible)
    return {
      id: "checklistIntegration",
      label: "[lab] Checklist integration",
      value: enabled ? "On" : "Off",
      help: `Experimental: integrate with pi-checklist.\n${requirements}\nAvailable now: pi-checklist ≥3.0.0 is loaded with task meta enabled.`,
    };
  return {
    id: "checklistIntegration",
    label: "[lab] Checklist integration",
    value: enabled ? "On · inactive (unavailable)" : "Off · unavailable",
    valueColor: "muted",
    help: `Experimental: integrate with pi-checklist.\nUnavailable: ${status.reason ?? "requirements not met"}.\n${requirements}\n${enabled ? "Saved On but inactive until requirements are met; Enter turns it Off." : "Cannot be turned On until requirements are met."}`,
  };
}

async function configureAgentsDialog(
  ctx: ExtensionCommandContext,
  options: {
    store: ConfigStore;
    settings: ManagerSettings;
    agentDir: string;
    getAllTools?: ToolEditorOptions["getAllTools"];
    resolveAgentSettings?: AgentEditorOptions["resolveAgentSettings"];
    /** Live pi-checklist eligibility; absent means unavailable (fail closed). */
    checklistStatus?: () => ChecklistStatus;
    apply(): void;
  },
): Promise<void> {
  const checklistStatus = (): ChecklistStatus => {
    try {
      return (
        options.checklistStatus?.() ?? {
          eligible: false,
          reason: "pi-checklist status is unavailable",
        }
      );
    } catch (error) {
      return {
        eligible: false,
        reason: `could not verify pi-checklist: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
  const readLayers = () =>
    loadManagerSettingsLayers({
      cwd: ctx.cwd,
      agentDir: options.agentDir,
      includeProject: ctx.isProjectTrusted(),
    });
  let layers = readLayers();
  const reportDiagnostics = () => {
    for (const diagnostic of layers.diagnostics) ctx.ui.notify(diagnostic, "warning");
  };
  reportDiagnostics();
  let baseline = { ...layers.settings };
  let draft = { ...baseline };
  let scope = layers.scope;
  let selectedId: string | undefined;
  while (true) {
    const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
    const action = await dialogMenu(
      ctx,
      `Agents settings${dirty ? " · unsaved" : ""}`,
      (
        [
          {
            id: "subagentMode",
            label: "Subagent Mode",
            value: MODE_OPTIONS.find((mode) => mode.id === draft.subagentMode)!.label,
            help: MODE_HELP,
          },
          {
            id: "toolFiltering",
            label: "Tool Filtering",
            value: TOOL_FILTERING_OPTIONS.find((mode) => mode.id === draft.toolFiltering)!.label,
            help: TOOL_FILTERING_HELP,
          },
          ...FIELDS.map((field) => ({
            ...field,
            value: String(draft[field.id]),
          })),
          {
            id: "modelSelection",
            label: "Model Picking",
            value: MODEL_SELECTION_OPTIONS.find((mode) => mode.id === draft.modelSelection)!.label,
            help: MODEL_SELECTION_HELP,
          },
          {
            id: "widgetMode",
            label: "Status Widget",
            value: WIDGET_MODE_OPTIONS.find((mode) => mode.id === draft.widgetMode)!.label,
            help: WIDGET_MODE_HELP,
          },
          {
            id: "costDisplay",
            label: "[lab] Footer display",
            value: COST_DISPLAY_OPTIONS.find((mode) => mode.id === draft.costDisplay)!.label,
            help: "Configure footer location, displayed cost, and money icon in a submenu. Save and apply to update immediately.",
          },
          {
            id: "housekeeping",
            label: "[lab] Housekeeping model",
            value: housekeepingValue(draft),
            valueColor:
              draft.housekeepingEnabled && !draft.housekeepingModel
                ? ("warning" as const)
                : undefined,
            help: HOUSEKEEPING_HELP,
          },
          {
            id: "nerdFontIcons",
            label: "[lab] Nerd Font icons",
            value: draft.nerdFontIcons ? "On" : "Off",
            help: "Experimental: display each agent type’s optional Nerd Font icon and unlock Nerd Font loader palettes.\nRequires a Nerd Font configured in your terminal; otherwise glyphs may appear as boxes.\nOff by default. Braille and ASCII loaders work with this Off. Save and apply to update immediately.",
          },
          {
            id: "loaderStyle",
            label: "[lab] Loader style",
            value:
              AGENT_LOADERS[effectiveLoaderStyle(draft.loaderStyle, draft.nerdFontIcons)].label,
            help: "Preview every animation frame and settled state.\nNerd Fonts Off: Braille (standard Unicode), ASCII, ASCII Star and ASCII Pulse. On: all palettes, including Circle and Hourglass.\nNerd-only saved styles fall back to ASCII while Nerd Fonts are off. Save and apply to update immediately.",
          },
          {
            id: "subagentExtensions",
            label: "[lab] Subagent extensions",
            value: Array.isArray(draft.subagentExtensions)
              ? `${draft.subagentExtensions.length} selected`
              : draft.subagentExtensions
                ? "All (legacy)"
                : "None",
            help: "Experimental: reload selected user/trusted-project extension hooks, including auto-discovered .ts/.js files and subdirectory entry points, in separate subagent sessions (not CLI-only or inline extensions). Bugs and unintended consequences may occur if hooks assume main-session state.\nRead limitations: https://github.com/championswimmer/pi-subagent-manager/blob/main/docs/subagent-extension-limitations.md\nSelect individual extensions in the submenu. None by default. Save and apply affects newly opened sessions, not already-open agents.",
          },
          checklistRow(draft.checklistIntegration, checklistStatus()),
          {
            id: "finalRecap",
            label: "[lab] Final Recap",
            value: draft.finalRecap ? "On" : "Off",
            help: "Experimental: when detached agents finish or fail and the main agent is idle, automatically ask the main agent to summarize their results.\nEnabling this may cause extra model turns and uses more tokens and context.\nOff by default. Subagent Mode Off suppresses automatic summaries.",
          },
          {
            id: "scope",
            label: "Save scope",
            value: scope === "user" ? "Global" : "Current Project",
            help: "Global: save overrides of built-in defaults for all projects.\nCurrent Project: save overrides of global settings for this trusted project.\nSwitching requires confirmation: enabling Project creates its settings file; switching to Global deletes it and discards unsaved edits. Confirmed scope changes happen immediately, even if you later cancel.",
          },
          {
            id: "types",
            label: "Agent definitions",
            value: `${options.store.list().length} types`,
            help: "Create or edit agent definitions.\nConfigure model preferences and tool policy for each agent type.",
          },
          {
            id: "defaults",
            label: "Restore defaults",
            help: "Pick Global or Project, then delete that scope's settings.json so its defaults apply again.\nThe file is removed, not rewritten; unsaved edits are discarded. This cannot be undone.",
          },
          {
            id: "save",
            label: "Save and apply",
            value: dirty ? "(changes)" : undefined,
            valueColor: dirty ? ("warning" as const) : undefined,
            help: "Save only overrides to the selected scope and reload settings now.\nUnchanged values inherit from the lower layer.\nRunning agents and retained sessions are kept.",
          },
          {
            id: "cancel",
            label: "Cancel",
            help: "Close without saving manager settings.",
          },
        ] as DialogRow[]
      ).map((row) => {
        const keys =
          row.id === "costDisplay"
            ? (["costDisplay", "costValue", "costIcon"] as (keyof ManagerSettings)[])
            : row.id === "housekeeping"
              ? (["housekeepingEnabled", "housekeepingModel"] as (keyof ManagerSettings)[])
              : row.id in DEFAULT_MANAGER_SETTINGS
                ? [row.id as keyof ManagerSettings]
                : [];
        return keys.length ? withProvenance(row, keys, layers) : row;
      }),
      {
        selectedId,
        saveId: "save",
        renderLegend: provenanceLegend,
        footer: "↑↓/Tab navigate · Enter edit · Ctrl+S save · Esc cancel",
      },
    );
    if (!action || action === "cancel") return;
    selectedId = action;
    try {
      const field = FIELDS.find((field) => field.id === action);
      if (field) {
        const value = await dialogInput(ctx, field.label, String(draft[field.id]), field.help);
        if (value === undefined) continue;
        const number = Number(value.trim());
        if (
          !/^\d+$/.test(value.trim()) ||
          !Number.isSafeInteger(number) ||
          number < 1 ||
          (field.id === "maxLevels" && number > 32)
        )
          throw new Error(field.help);
        draft[field.id] = number;
      } else if (action === "subagentMode") {
        const mode = await dialogMenu(ctx, "Subagent Mode", [...MODE_OPTIONS], {
          selectedId: draft.subagentMode,
        });
        if (MODE_OPTIONS.some((option) => option.id === mode))
          draft.subagentMode = mode as SubagentMode;
      } else if (action === "toolFiltering") {
        const mode = await dialogMenu(ctx, "Tool Filtering", [...TOOL_FILTERING_OPTIONS], {
          selectedId: draft.toolFiltering,
        });
        if (TOOL_FILTERING_OPTIONS.some((option) => option.id === mode))
          draft.toolFiltering = mode as ToolFilteringMode;
      } else if (action === "modelSelection") {
        const mode = await dialogMenu(ctx, "Model Picking", [...MODEL_SELECTION_OPTIONS], {
          selectedId: draft.modelSelection,
        });
        if (MODEL_SELECTION_OPTIONS.some((option) => option.id === mode))
          draft.modelSelection = mode as ModelSelectionMode;
      } else if (action === "widgetMode") {
        const mode = await dialogMenu(ctx, "Status Widget", [...WIDGET_MODE_OPTIONS], {
          selectedId: draft.widgetMode,
        });
        if (WIDGET_MODE_OPTIONS.some((option) => option.id === mode))
          draft.widgetMode = mode as WidgetMode;
      } else if (action === "costDisplay") {
        await configureFooterDisplay(ctx, draft, layers);
      } else if (action === "housekeeping") {
        await configureHousekeeping(ctx, draft, layers);
      } else if (action === "nerdFontIcons") {
        draft.nerdFontIcons = !draft.nerdFontIcons;
      } else if (action === "loaderStyle") {
        const styles = availableLoaderStyles(draft.nerdFontIcons);
        const style = await dialogMenu(
          ctx,
          "[lab] Loader style",
          LOADER_OPTIONS.filter((option) => styles.includes(option.id)),
          { selectedId: effectiveLoaderStyle(draft.loaderStyle, draft.nerdFontIcons) },
        );
        if (styles.includes(style as LoaderStyle)) draft.loaderStyle = style as LoaderStyle;
      } else if (action === "subagentExtensions") {
        await configureSubagentExtensions(ctx, draft, options.agentDir);
      } else if (action === "checklistIntegration") {
        const status = checklistStatus();
        // Turning Off is always allowed; turning On requires current eligibility.
        if (!draft.checklistIntegration && !status.eligible)
          ctx.ui.notify(
            `Checklist integration cannot be enabled: ${status.reason ?? "requirements not met"}. ${CHECKLIST_REQUIREMENTS}`,
            "warning",
          );
        else draft.checklistIntegration = !draft.checklistIntegration;
      } else if (action === "finalRecap") {
        draft.finalRecap = !draft.finalRecap;
      } else if (action === "scope") {
        if (!ctx.isProjectTrusted())
          ctx.ui.notify("Project settings require a trusted project; saving globally.", "warning");
        else {
          const nextScope = scope === "user" ? "project" : "user";
          const message =
            nextScope === "project"
              ? "Create project file now; outer Cancel cannot undo.\nThis will create this project's settings.json. Further changes will be saved there. Unsaved edits are kept until Save and apply."
              : "Delete project file now. Discard edits. No undo.\nUnsaved edits will be discarded. Outer Cancel cannot undo. We reload global settings; further changes are saved globally.";
          const confirmation = await dialogMenu(
            ctx,
            nextScope === "project"
              ? "Enable project settings?"
              : "Clear project settings and use Global?",
            [
              { id: "confirm", label: "Confirm", help: message },
              {
                id: "cancel",
                label: "Cancel",
                help: message + "\nCancel leaves files, scope and unsaved edits unchanged.",
              },
            ],
            { selectedId: "cancel", footer: "↑↓/Tab choose · Enter select · Esc cancel" },
          );
          if (confirmation !== "confirm") continue;
          setManagerProjectSettings({
            cwd: ctx.cwd,
            agentDir: options.agentDir,
            includeProject: ctx.isProjectTrusted(),
            enabled: nextScope === "project",
            expectedLayers: layers,
          });
          layers = readLayers();
          reportDiagnostics();
          scope = nextScope;
          if (scope === "user") {
            baseline = { ...layers.settings };
            draft = { ...baseline };
            options.apply();
          }
        }
      } else if (action === "defaults") {
        const target = {
          cwd: ctx.cwd,
          agentDir: options.agentDir,
          includeProject: ctx.isProjectTrusted(),
        };
        const globalPath = managerSettingsPath(target, "user");
        const projectPath = target.includeProject
          ? managerSettingsPath(target, "project")
          : undefined;
        const explain = (path: string) =>
          `Deletes this file now (nothing is written):\n${path}\nIf it does not exist, nothing happens. Unsaved edits are discarded. No undo.`;
        const rows: DialogRow[] = [
          {
            id: "user",
            label: "Global",
            value: "Restore global defaults",
            help: explain(globalPath),
          },
          ...(projectPath
            ? [
                {
                  id: "project",
                  label: "Project",
                  value: "Restore project defaults",
                  help: explain(projectPath),
                },
              ]
            : []),
          { id: "cancel", label: "Cancel", help: "Delete nothing." },
        ];
        const choice = await dialogMenu(
          ctx,
          "Restore defaults: delete which settings file?",
          rows,
          {
            selectedId: "cancel",
            footer: "↑↓/Tab choose · Enter delete file · Esc cancel",
          },
        );
        if (choice === "user" || choice === "project") {
          const { filePath, deleted } = deleteManagerSettings({ ...target, scope: choice });
          layers = readLayers();
          reportDiagnostics();
          baseline = { ...layers.settings };
          draft = { ...baseline };
          scope = layers.scope;
          options.apply();
          ctx.ui.notify(
            deleted
              ? `Deleted ${filePath}. Defaults restored.`
              : `No settings file at ${filePath}; nothing to delete.`,
            "info",
          );
        }
      } else if (action === "types") {
        await editAgentTypes(ctx, options.store, draft.nerdFontIcons, {
          getAllTools: options.getAllTools ?? (() => []),
          toolFiltering: draft.toolFiltering,
          resolveAgentSettings: options.resolveAgentSettings,
        });
        options.store.reload();
      } else if (action === "save") {
        if (draft.checklistIntegration && !baseline.checklistIntegration) {
          const status = checklistStatus();
          if (!status.eligible)
            throw new Error(
              `Checklist integration cannot be enabled: ${status.reason ?? "requirements not met"}. Turn it Off or satisfy: ${CHECKLIST_REQUIREMENTS}`,
            );
        }
        const file = saveManagerOverrides({
          cwd: ctx.cwd,
          agentDir: options.agentDir,
          includeProject: ctx.isProjectTrusted(),
          scope,
          settings: draft,
          expectedLayers: layers,
        });
        options.apply();
        ctx.ui.notify(
          `Saved ${file}. Settings reloaded; unchanged values inherit from the lower layer.`,
          "info",
        );
        return;
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}
