import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { selectTools } from "../prefs/config.ts";
import type { ToolFilteringMode } from "../prefs/settings.ts";
import type { InheritedToolSource } from "./inherited-tools.ts";
import type { AgentType, ThinkingLevel } from "../types.ts";

/** Built-in tool names every subagent session registers. */
export const BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/**
 * Tools no subagent may ever use, whatever its type declares.
 * `ask_user_question` would park an unattended batch on a human answer; subagents
 * report progress with agent_update and hand back a final answer instead.
 */
export const FORBIDDEN_SUBAGENT_TOOLS = new Set(["ask_user_question"]);

/** Delegation verbs, dropped from the pool unless the type opts in with `canSpawn`. */
export const DELEGATION_TOOLS = new Set([
  "agent_spawn",
  "agent_steer",
  "agent_stop",
  "agent_wait",
]);

export function isDelegationAllowed(type: AgentType, canSpawnChildren: boolean): boolean {
  return canSpawnChildren && type.canSpawn === true;
}

export interface SubagentToolPool {
  /** Whether this child may call the delegation verbs at all. */
  canDelegate: boolean;
  /** Whether the type itself opted into delegation (independent of depth). */
  typeCanSpawn: boolean;
  /** SDK registry allowlist after the delegation gate and the type policy. */
  toolNames: string[];
  allowed: Set<string>;
  /** Manager verbs that survived the gates; these become SDK custom tools. */
  permittedTools: ToolDefinition[];
  /** Inherited root tools that survived the gates (extension/MCP tools). */
  externalTools: ToolDefinition[];
  /** Tools declared directly to the model rather than deferred behind codemode/tool_search. */
  activeToolNames: string[];
}

/**
 * Single source of truth for a subagent's tool pool. Three gates apply in order:
 * forbidden tools (never), the delegation gate (type opt-in AND depth), then the
 * configured type policy (`tools.allow`/`tools.block`) via {@link selectTools}.
 */
export function resolveSubagentTools(input: {
  /** Manager verbs for this path (`agent_spawn`, `agent_update`, …). */
  declared: readonly ToolDefinition[];
  type: AgentType;
  /** Depth gate only; the type opt-in is applied here as well. */
  canSpawnChildren: boolean;
  inherited: InheritedToolSource;
  filtering: ToolFilteringMode;
  /** Non-fatal policy diagnostics (for example a silently ignored `tools.allow`). */
  onDiagnostic?: (message: string) => void;
}): SubagentToolPool {
  const typeCanSpawn = input.type.canSpawn === true;
  const canDelegate = isDelegationAllowed(input.type, input.canSpawnChildren);
  const permittedTools = input.declared.filter(
    (tool) =>
      !FORBIDDEN_SUBAGENT_TOOLS.has(tool.name) &&
      (canDelegate || !DELEGATION_TOOLS.has(tool.name)),
  );
  const localNames = new Set([...BUILTINS, ...permittedTools.map((tool) => tool.name)]);
  const externalTools = input.inherited.tools.filter(
    (tool) => !localNames.has(tool.name) && !FORBIDDEN_SUBAGENT_TOOLS.has(tool.name),
  );
  const toolNames = selectTools(
    input.type.tools,
    // Forbidden names stay in the validated universe so a type that mentions them in
    // tools.allow/tools.block does not fail to start, but they are dropped from the
    // result below and never registered.
    [...localNames, ...externalTools.map((tool) => tool.name), ...FORBIDDEN_SUBAGENT_TOOLS],
    input.filtering,
    input.onDiagnostic,
  ).filter((name) => !FORBIDDEN_SUBAGENT_TOOLS.has(name));
  const allowed = new Set(toolNames);
  const rootActive = new Set(input.inherited.activeNames);
  const activeToolNames = toolNames.filter(
    (name) =>
      localNames.has(name) ||
      rootActive.has(name) ||
      (input.type.tools?.allow?.includes(name) && input.filtering === "allowed"),
  );
  return {
    canDelegate,
    typeCanSpawn,
    toolNames,
    allowed,
    permittedTools,
    externalTools,
    activeToolNames,
  };
}

/**
 * Thinking-level precedence for a new or resumed child.
 * Explicit spawn parameter > type configuration > restored session > lexical parent >
 * root session > "off". Type configuration outranks the restored value so that editing a
 * type's thinking level takes effect when the same retained path is resumed.
 */
export function resolveThinkingLevel(
  explicit: ThinkingLevel | undefined,
  type: AgentType,
  restored: ThinkingLevel | undefined,
  parent: ThinkingLevel | undefined,
  root: ThinkingLevel | undefined,
): ThinkingLevel {
  return explicit ?? type.thinkingLevel ?? restored ?? parent ?? root ?? "off";
}
