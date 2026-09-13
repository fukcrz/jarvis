export type SettingsRoute =
  | { page: "home" }
  | { page: "assistant-name" }
  | { page: "providers" }
  | { page: "provider"; providerId: string }
  | { page: "provider-new" }
  | { page: "provider-edit"; providerId: string }
  | { page: "provider-override"; providerId: string }
  | { page: "model-scope" }
  | { page: "workspaces" }
  | { page: "tunnel" }
  | { page: "security" };

const SETTINGS_ROOT = "/settings";

export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_ROOT || pathname.startsWith(`${SETTINGS_ROOT}/`);
}

export function settingsPath(route: SettingsRoute): string {
  switch (route.page) {
    case "home": return SETTINGS_ROOT;
    case "assistant-name": return `${SETTINGS_ROOT}/assistant-name`;
    case "providers": return `${SETTINGS_ROOT}/providers`;
    case "provider-new": return `${SETTINGS_ROOT}/providers/new`;
    case "provider": return `${SETTINGS_ROOT}/providers/${encodeURIComponent(route.providerId)}`;
    case "provider-edit": return `${SETTINGS_ROOT}/providers/${encodeURIComponent(route.providerId)}/edit`;
    case "provider-override": return `${SETTINGS_ROOT}/providers/${encodeURIComponent(route.providerId)}/override`;
    case "model-scope": return `${SETTINGS_ROOT}/model-scope`;
    case "workspaces": return `${SETTINGS_ROOT}/workspaces`;
    case "tunnel": return `${SETTINGS_ROOT}/tunnel`;
    case "security": return `${SETTINGS_ROOT}/security`;
  }
}

export function parseSettingsPath(pathname: string): SettingsRoute | undefined {
  if (pathname === SETTINGS_ROOT || pathname === `${SETTINGS_ROOT}/`) return { page: "home" };
  if (!pathname.startsWith(`${SETTINGS_ROOT}/`)) return undefined;
  const segments = pathname.slice(SETTINGS_ROOT.length + 1).split("/").filter(Boolean).map(decodeSegment);
  if (segments.length === 1) {
    switch (segments[0]) {
      case "assistant-name": return { page: "assistant-name" };
      case "providers": return { page: "providers" };
      case "model-scope": return { page: "model-scope" };
      case "workspaces": return { page: "workspaces" };
      case "tunnel": return { page: "tunnel" };
      case "security": return { page: "security" };
      default: return undefined;
    }
  }
  if (segments[0] !== "providers" || segments[1] === undefined) return undefined;
  if (segments.length === 2) return segments[1] === "new" ? { page: "provider-new" } : { page: "provider", providerId: segments[1] };
  if (segments.length === 3 && segments[1] !== "new") {
    if (segments[2] === "edit") return { page: "provider-edit", providerId: segments[1] };
    if (segments[2] === "override") return { page: "provider-override", providerId: segments[1] };
  }
  return undefined;
}

export function parentSettingsRoute(route: SettingsRoute, options?: { hasProvider?: boolean }): SettingsRoute | undefined {
  switch (route.page) {
    case "home": return undefined;
    case "assistant-name":
    case "providers":
    case "workspaces":
    case "tunnel":
    case "security":
      return { page: "home" };
    case "provider":
    case "provider-new":
    case "model-scope":
      return { page: "providers" };
    case "provider-edit":
      return options?.hasProvider === false ? { page: "providers" } : { page: "provider", providerId: route.providerId };
    case "provider-override":
      return { page: "provider", providerId: route.providerId };
  }
}

/** React Router 把当前条目下标记在 history.state.idx；0 表示没有可弹出的应用内历史。 */
export function canPopHistory(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  const idx = (state as { idx?: unknown }).idx;
  return typeof idx === "number" && Number.isInteger(idx) && idx > 0;
}

/** 有上一页就弹出，否则落到 fallback（直接打开、刷新后没有应用内历史）。 */
export function navigateBackOr(navigate: (delta: number) => void, fallback: () => void, state: unknown = typeof window === "undefined" ? null : window.history.state): void {
  if (canPopHistory(state)) navigate(-1);
  else fallback();
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
