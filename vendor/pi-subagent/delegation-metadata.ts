import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DELEGATION_CUSTOM_TYPE = "pi-subagent:delegation";
export const DELEGATION_ENV = "PI_SUBAGENT_DELEGATION";

/** Versioned cross-repo contract; see README.md, Delegation metadata. */
export interface DelegationMetadata {
  version: 1;
  childSessionId: string;
  parentSessionId: string;
  agent: string;
  handle: string;
}

function parseLaunchMetadata(raw: string | undefined): DelegationMetadata | undefined {
  if (!raw) return undefined;
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1) return undefined;
    for (const key of ["childSessionId", "parentSessionId", "agent", "handle"]) {
      if (typeof data[key] !== "string" || !data[key] || data[key].trim() !== data[key]) {
        return undefined;
      }
    }
    if (data.childSessionId === data.parentSessionId) return undefined;
    return {
      version: 1,
      childSessionId: data.childSessionId,
      parentSessionId: data.parentSessionId,
      agent: data.agent,
      handle: data.handle,
    };
  } catch {
    return undefined;
  }
}

/** Loaded explicitly in children, independently of agent discovery and depth guards. */
export default function (pi: ExtensionAPI) {
  const data = parseLaunchMetadata(process.env[DELEGATION_ENV]);
  if (!data) return;

  pi.on("session_start", (event, ctx) => {
    // A launch payload authorizes only the initial session, not reloads or switches.
    if (event.reason !== "startup") return;
    const manager = ctx.sessionManager;
    if (!manager.getSessionFile() || manager.getSessionId() !== data.childSessionId ||
        manager.getHeader()?.id !== data.childSessionId) return;

    // Origin is session-wide, even after tree navigation. Copied entries belong
    // to their original header ID and cannot suppress this child's own origin.
    const hasOrigin = manager.getEntries().some((entry) =>
      entry.type === "custom" && entry.customType === DELEGATION_CUSTOM_TYPE &&
      (entry.data as Partial<DelegationMetadata> | undefined)?.childSessionId === data.childSessionId,
    );
    if (!hasOrigin) pi.appendEntry(DELEGATION_CUSTOM_TYPE, data);
  });
}
