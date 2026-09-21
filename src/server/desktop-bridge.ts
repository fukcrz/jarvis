export type DesktopEvent =
  | { type: "ready"; port: number }
  | { type: "restart" }
  | {
      type: "run-finished";
      workspaceId: string;
      sessionId: string;
      runId: string;
      failed: boolean;
      sessionName?: string;
      text?: string;
      errorMessage?: string;
    };

export function desktopEnabled(): boolean {
  return process.env["JARVIS_DESKTOP"] === "1";
}

export function formatDesktopEvent(event: DesktopEvent): string {
  return `JARVIS_DESKTOP:${JSON.stringify(event)}\n`;
}

export function emitDesktopEvent(event: DesktopEvent): void {
  if (!desktopEnabled()) return;
  process.stdout.write(formatDesktopEvent(event));
}
