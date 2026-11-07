import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Optional Labs integration with pi-checklist >= 3.0.0.
 *
 * pi-checklist publishes no runtime API, events or version query, so this adapter is
 * deliberately source-backed and fails closed:
 *  - identity/version come from the real registration origin of its tools
 *    (`ToolInfo.sourceInfo`) and the nearest owning package.json;
 *  - "task metadata is enabled" mirrors pi-checklist's private closure state using the same
 *    persistence it writes (see {@link ChecklistMetaMirror}).
 */

export const CHECKLIST_PACKAGE = "pi-checklist";
export const CHECKLIST_MIN_MAJOR = 3;
export const CHECKLIST_TOOL_NAMES = [
  "checklist_create",
  "checklist_read",
  "checklist_update",
] as const;
/** Session entry type pi-checklist appends for every snapshot (src/index.ts CUSTOM_TYPE). */
const CHECKLIST_ENTRY_TYPE = "pi-checklist";
const PREFS_FILE = "pi-checklist.json";

export const CHECKLIST_REQUIREMENTS =
  "Requires pi-checklist ≥3.0.0 with its tools loaded and active, and task meta enabled (/checklist settings meta).";

export interface ChecklistStatus {
  eligible: boolean;
  /** Why the integration is unavailable; absent when eligible. */
  reason?: string;
}

/** Strict `x.y.z`: prereleases/build metadata fail closed. */
export function checklistVersionSupported(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version.trim(),
    );
  return match !== null && Number(match[1]) >= CHECKLIST_MIN_MAJOR;
}

function owningPackage(file: string): { name?: unknown; version?: unknown } | undefined {
  let directory = dirname(realpathSync(file));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as { name?: unknown; version?: unknown })
        : undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Identity/version/reachability of the loaded checklist tools; metadata state is separate. */
export function detectChecklistPackage(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
): ChecklistStatus {
  try {
    const all = pi.getAllTools();
    const active = new Set(pi.getActiveTools());
    const sources = new Set<string>();
    for (const name of CHECKLIST_TOOL_NAMES) {
      const tool = all.find((candidate) => candidate.name === name);
      if (!tool || tool.exposure === "hidden" || !active.has(name))
        return { eligible: false, reason: `pi-checklist tool ${name} is not loaded and active` };
      const path = tool.sourceInfo?.path;
      if (typeof path !== "string" || !isAbsolute(path))
        return {
          eligible: false,
          reason: `${name} does not come from a pi-checklist package file`,
        };
      sources.add(realpathSync(path));
    }
    if (sources.size !== 1)
      return { eligible: false, reason: "checklist tools come from different extensions" };
    const pkg = owningPackage([...sources][0]!);
    if (pkg?.name !== CHECKLIST_PACKAGE)
      return {
        eligible: false,
        reason: "checklist tools are not provided by the pi-checklist package",
      };
    if (!checklistVersionSupported(pkg.version))
      return {
        eligible: false,
        reason: `pi-checklist ${typeof pkg.version === "string" ? pkg.version : "(unknown version)"} is unsupported; ≥3.0.0 is required`,
      };
    return { eligible: true };
  } catch (error) {
    return {
      eligible: false,
      reason: `could not verify pi-checklist: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface BranchEntry {
  id?: unknown;
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: { role?: unknown; toolName?: unknown; details?: unknown };
}

/** pi-checklist ChecklistSnapshot guard (src/types.ts): `v === 1` with a `checklist` key. */
function snapshotOf(value: unknown): { metaEnabled?: unknown } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return record.v === 1 && "checklist" in record ? record : undefined;
}

/** The snapshot an entry carries, using pi-checklist's loadFromBranch() rules. */
function entrySnapshot(entry: BranchEntry): { metaEnabled?: unknown } | undefined {
  if (entry.type === "custom" && entry.customType === CHECKLIST_ENTRY_TYPE)
    return snapshotOf(entry.data);
  if (
    entry.type === "message" &&
    entry.message?.role === "toolResult" &&
    typeof entry.message.toolName === "string" &&
    (CHECKLIST_TOOL_NAMES as readonly string[]).includes(entry.message.toolName)
  )
    return snapshotOf(entry.message.details);
  return undefined;
}

function globalMetaEnabled(agentDir: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, PREFS_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as { metaEnabled?: unknown }).metaEnabled;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mirror of pi-checklist's live `metaEnabled`. pi-checklist computes it only at
 * session_start/session_tree (global prefs file > latest branch snapshot > false) and then
 * changes it solely through its own snapshots. So: seed identically on those lifecycle events,
 * remember a branch checkpoint, and afterwards follow only snapshots appended to this branch.
 * Later edits to the global prefs file by other sessions never affect the local instance, so
 * they are intentionally ignored. Unknown state is `false`.
 */
export class ChecklistMetaMirror {
  private enabled = false;
  private checkpoint: unknown;
  private ready = false;

  constructor(private readonly agentDir: () => string) {}

  /** Re-seed; call on session_start and session_tree. */
  reset(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.ready = false;
    this.enabled = false;
    this.checkpoint = undefined;
    try {
      const branch = ctx.sessionManager.getBranch() as BranchEntry[];
      let found: { metaEnabled?: unknown } | undefined;
      for (const entry of branch) found = entrySnapshot(entry) ?? found;
      this.enabled = globalMetaEnabled(this.agentDir()) ?? found?.metaEnabled === true;
      this.checkpoint = branch.at(-1)?.id;
      this.ready = true;
    } catch {
      this.enabled = false;
    }
  }

  /** Apply snapshots appended since the checkpoint; fail closed when the branch moved. */
  metaEnabled(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
    try {
      if (!this.ready) this.reset(ctx);
      if (!this.ready) return false;
      const branch = ctx.sessionManager.getBranch() as BranchEntry[];
      let start = 0;
      if (this.checkpoint !== undefined) {
        const index = branch.findIndex((entry) => entry.id === this.checkpoint);
        if (index < 0) {
          this.reset(ctx);
          return this.ready && this.enabled;
        }
        start = index + 1;
      }
      for (const entry of branch.slice(start)) {
        const snapshot = entrySnapshot(entry);
        if (snapshot) this.enabled = snapshot.metaEnabled === true;
      }
      this.checkpoint = branch.at(-1)?.id ?? this.checkpoint;
      return this.enabled;
    } catch {
      return false;
    }
  }
}

/** Full eligibility: genuine reachable pi-checklist ≥3.0.0 AND live task meta enabled. */
export function checklistStatus(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
  mirror: ChecklistMetaMirror,
  ctx: Pick<ExtensionContext, "sessionManager">,
): ChecklistStatus {
  const installed = detectChecklistPackage(pi);
  if (!installed.eligible) return installed;
  if (!mirror.metaEnabled(ctx))
    return {
      eligible: false,
      reason: "pi-checklist task meta is disabled; run /checklist settings meta",
    };
  return { eligible: true };
}

/** Prompt addendum, only when the Labs opt-in AND checklist eligibility both hold. */
export function checklistGuidance(mode: "opportunistic" | "orchestration"): string {
  const tagging =
    'Task meta is enabled in pi-checklist: tag which agent works on each task with a flat meta object, e.g. meta: { agent: "/root/task-slug" } using the agent\'s thread path. Meta values are strings, numbers or booleans (at most 10 keys, keys ≤40 characters, strings ≤200 characters); updates merge keys and null removes a key. Set or update meta.agent when you assign, reassign or finish delegated work.';
  return [
    "## pi-checklist integration",
    mode === "orchestration"
      ? "As /root in orchestration mode you MUST use checklist_create, checklist_read and checklist_update to plan, track and report orchestration work: create a task for every delegated unit and keep statuses current."
      : "When you track work with checklist_create, checklist_read or checklist_update, you may also label delegated tasks by agent. Using the checklist is optional in opportunistic mode.",
    tagging,
  ].join("\n");
}
