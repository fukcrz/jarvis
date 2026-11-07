import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const HOUSEKEEPING_USAGE_KIND = "subagent-manager";

// ExtensionContext exposes a read-only type; the runtime manager supports appendUsage.
type UsageSession = Pick<SessionManager, "getSessionId"> &
  Partial<Pick<SessionManager, "appendUsage">>;

export interface HousekeepingUsageSession {
  manager: UsageSession;
  sessionId: string;
}

/** Capture before async provider work: old extension-context getters become invalid on replacement. */
export function captureHousekeepingUsageSession(
  ctx: Pick<ExtensionContext, "sessionManager">,
): HousekeepingUsageSession | undefined {
  try {
    const manager = ctx.sessionManager as UsageSession;
    return { manager, sessionId: manager.getSessionId() };
  } catch {
    return undefined;
  }
}

/** Account once even when the answer is failed, aborted, empty or no longer displayable. */
export function reportHousekeepingUsage(
  session: HousekeepingUsageSession | undefined,
  response: AssistantMessage,
): ReturnType<SessionManager["appendUsage"]> | undefined {
  if (!response.usage || !session) return undefined;
  try {
    // SDK callers can mutate a manager in place; never charge its replacement session.
    if (session.manager.getSessionId() !== session.sessionId) return undefined;
    return session.manager.appendUsage?.(
      HOUSEKEEPING_USAGE_KIND,
      response.provider,
      response.responseModel ?? response.model,
      response.usage,
      "housekeeping model call",
    );
  } catch {
    // Accounting failure must not change housekeeping's success/fallback behavior.
    return undefined;
  }
}
