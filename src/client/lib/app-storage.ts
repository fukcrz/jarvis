export const SESSION_FOCUS_STORAGE_KEY = "jarvis.sessions.focus";

export function pathParams(pathname: string): { workspaceId?: string; sessionId?: string; files?: boolean } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "chat" && parts.length >= 3) return { workspaceId: parts[1], sessionId: parts[2] };
  if (parts[0] === "sessions" && parts.length >= 2) return { workspaceId: parts[1] };
  if (parts[0] === "files" && parts.length >= 2) return { workspaceId: parts[1], files: true };
  return {};
}

/** 正在看聊天正文。移动端会话列表不是查看。 */
export function isChatPath(pathname: string): boolean {
  return pathname === "/chat" || pathname.startsWith("/chat/");
}

export function readSessionFocusMode(): boolean {
  try {
    return window.localStorage.getItem(SESSION_FOCUS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function readExpandedWorkspaces(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem("jarvis.projects.expanded");
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function readDrafts(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem("jarvis.drafts");
    const parsed = raw === null ? undefined : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}
