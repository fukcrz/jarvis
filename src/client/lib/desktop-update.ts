export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface UpdateOffer {
  version: string;
  currentVersion: string;
  notes?: string;
}

export type UpdatePhase =
  | { kind: "closed" }
  | { kind: "checking" }
  | { kind: "available"; offer: UpdateOffer }
  | { kind: "downloading"; offer: UpdateOffer; received: number; total?: number }
  | { kind: "download-failed"; offer: UpdateOffer; error: string }
  | { kind: "ready"; offer: UpdateOffer; error?: string }
  | { kind: "confirm-install"; offer: UpdateOffer; running: number }
  | { kind: "installing"; offer: UpdateOffer }
  | { kind: "up-to-date" }
  | { kind: "check-failed"; error: string };

export interface HeldUpdate {
  version: string;
  downloaded: boolean;
}

export interface UpdateSession {
  phase: UpdatePhase;
  dismissed: string[];
  held?: HeldUpdate;
}

export type UpdateAction =
  | { type: "check-started"; manual: boolean }
  | { type: "check-empty"; manual: boolean }
  | { type: "check-found"; manual: boolean; offer: UpdateOffer; downloaded: boolean }
  | { type: "check-failed"; manual: boolean; error: string }
  | { type: "dismiss" }
  | { type: "download-started" }
  | { type: "download-progress"; received: number; total?: number }
  | { type: "download-finished" }
  | { type: "download-failed"; error: string }
  | { type: "install-confirm"; running: number }
  | { type: "install-cancel" }
  | { type: "install-failed"; error: string }
  | { type: "install-started" };

export type UpdateCheckDisposition = "drop" | "prompt-new" | "prompt-ready";

export function initialUpdateSession(): UpdateSession {
  return { phase: { kind: "closed" }, dismissed: [] };
}

export function updatePhaseLocksCheck(phase: UpdatePhase): boolean {
  return phase.kind === "checking"
    || phase.kind === "available"
    || phase.kind === "downloading"
    || phase.kind === "download-failed"
    || phase.kind === "ready"
    || phase.kind === "confirm-install"
    || phase.kind === "installing";
}

export function canDismissUpdate(phase: UpdatePhase): boolean {
  return phase.kind !== "closed" && phase.kind !== "downloading" && phase.kind !== "installing" && phase.kind !== "confirm-install";
}

export function updateCheckDisposition(session: UpdateSession, manual: boolean, version: string, downloadedVersion?: string): UpdateCheckDisposition {
  if (session.phase.kind === "downloading" || session.phase.kind === "installing") return "drop";
  if (!manual && (session.dismissed.includes(version) || updatePhaseLocksCheck(session.phase))) return "drop";
  return downloadedVersion === version ? "prompt-ready" : "prompt-new";
}

export function reduceUpdateSession(session: UpdateSession, action: UpdateAction): UpdateSession {
  switch (action.type) {
    case "check-started":
      if (!action.manual || session.phase.kind === "downloading" || session.phase.kind === "installing") return session;
      return { ...session, phase: { kind: "checking" } };
    case "check-empty":
      if (session.phase.kind === "downloading" || session.phase.kind === "installing") return session;
      if (!action.manual) return { ...session, held: undefined };
      return { ...session, phase: { kind: "up-to-date" }, held: undefined };
    case "check-found": {
      if (updateCheckDisposition(session, action.manual, action.offer.version, action.downloaded ? action.offer.version : undefined) === "drop") return session;
      const held = { version: action.offer.version, downloaded: action.downloaded };
      if (action.downloaded) return { ...session, phase: { kind: "ready", offer: action.offer }, held };
      return { ...session, phase: { kind: "available", offer: action.offer }, held };
    }
    case "check-failed":
      if (!action.manual || session.phase.kind === "downloading" || session.phase.kind === "installing") return session;
      return { ...session, phase: { kind: "check-failed", error: action.error } };
    case "dismiss":
      if (!canDismissUpdate(session.phase)) return session;
      return { ...session, phase: { kind: "closed" }, dismissed: rememberDismissed(session, offerOf(session.phase)?.version) };
    case "download-started": {
      const offer = session.phase.kind === "available" || session.phase.kind === "download-failed" ? session.phase.offer : undefined;
      if (offer === undefined) return session;
      return { ...session, phase: { kind: "downloading", offer, received: 0 }, held: { version: offer.version, downloaded: false } };
    }
    case "download-progress":
      if (session.phase.kind !== "downloading") return session;
      return { ...session, phase: { ...session.phase, received: action.received, total: action.total } };
    case "download-finished":
      if (session.phase.kind !== "downloading") return session;
      return { ...session, phase: { kind: "ready", offer: session.phase.offer }, held: { version: session.phase.offer.version, downloaded: true } };
    case "download-failed":
      if (session.phase.kind !== "downloading") return session;
      return { ...session, phase: { kind: "download-failed", offer: session.phase.offer, error: action.error }, held: { version: session.phase.offer.version, downloaded: false } };
    case "install-confirm": {
      if (session.phase.kind !== "ready" || action.running <= 0) return session;
      return { ...session, phase: { kind: "confirm-install", offer: session.phase.offer, running: action.running }, held: { version: session.phase.offer.version, downloaded: true } };
    }
    case "install-cancel": {
      if (session.phase.kind !== "confirm-install") return session;
      return { ...session, phase: { kind: "ready", offer: session.phase.offer }, held: { version: session.phase.offer.version, downloaded: true } };
    }
    case "install-failed":
    case "install-started": {
      const offer = session.phase.kind === "ready" || session.phase.kind === "confirm-install" || session.phase.kind === "installing" ? session.phase.offer : undefined;
      if (offer === undefined) return session;
      if (action.type === "install-started") {
        if (session.phase.kind === "installing") return session;
        return { ...session, phase: { kind: "installing", offer }, held: { version: offer.version, downloaded: true } };
      }
      return { ...session, phase: { kind: "ready", offer, error: action.error }, held: { version: offer.version, downloaded: true } };
    }
    default:
      return session;
  }
}

export function updateNotes(body: string | null | undefined): string | undefined {
  const notes = body?.trim();
  return notes === undefined || notes === "" ? undefined : notes;
}

export function updateVersionLabel(offer: UpdateOffer): string {
  const current = offer.currentVersion.trim();
  if (current === "" || current === offer.version) return offer.version;
  return `${current} → ${offer.version}`;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function downloadProgressLabel(received: number, total?: number): string {
  if (total !== undefined && total > 0) {
    const percent = Math.min(100, Math.round((received / total) * 100));
    return `${String(percent)}% · ${formatByteSize(received)} / ${formatByteSize(total)}`;
  }
  return received > 0 ? formatByteSize(received) : "";
}

export function runningSessionLabel(count: number): string {
  return `当前有 ${String(count)} 个正在运行的会话`;
}

export function updateErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  return "失败";
}

function offerOf(phase: UpdatePhase): UpdateOffer | undefined {
  if (phase.kind === "available" || phase.kind === "downloading" || phase.kind === "download-failed" || phase.kind === "ready" || phase.kind === "installing") return phase.offer;
  return undefined;
}

function rememberDismissed(session: UpdateSession, version: string | undefined): string[] {
  if (version === undefined || session.dismissed.includes(version)) return session.dismissed;
  return [...session.dismissed, version];
}
