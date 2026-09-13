export type ExtensionToastTone = "info" | "warning" | "error";

export type ExtensionToastInput = {
  id: string;
  workspaceId: string;
  sessionId?: string;
  message: string;
  tone: ExtensionToastTone;
};

export type ExtensionToast = ExtensionToastInput & {
  count: number;
};

const TONE_PRIORITY: Record<ExtensionToastTone, number> = { info: 0, warning: 1, error: 2 };

/** Keep the transient surface quiet while allowing urgent feedback to win. */
export function mergeExtensionToast(current: ExtensionToast | undefined, incoming: ExtensionToastInput): ExtensionToast {
  if (current === undefined) return { ...incoming, count: 1 };
  if (TONE_PRIORITY[incoming.tone] < TONE_PRIORITY[current.tone]) return current;
  if (incoming.tone === "info" && current.tone === "info") {
    return { ...incoming, count: current.count + 1 };
  }
  return { ...incoming, count: 1 };
}

export function extensionToastDuration(tone: ExtensionToastTone): number {
  if (tone === "error") return 10_000;
  if (tone === "warning") return 5_000;
  return 3_000;
}

/** Toast source row only uses a real session name, never preview text. */
export function extensionToastSourceLabel(name: string | null | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
