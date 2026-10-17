/** 设置页一级分类；电脑端左侧导航、手机端首页列表、搜索结果共用。 */
export type SettingsCategoryId =
  | "general"
  | "notifications"
  | "models"
  | "model-groups"
  | "extensions"
  | "workspaces"
  | "remote"
  | "about";

export type SettingsRoute =
  | { page: "home" }
  | { page: "general" }
  | { page: "notifications" }
  | { page: "models" }
  | { page: "provider-new" }
  | { page: "provider"; providerId: string }
  | { page: "model-groups" }
  | { page: "plugins" }
  | { page: "skills" }
  | { page: "skill-files"; skillId: string }
  | { page: "workspaces" }
  | { page: "remote" }
  | { page: "about" };

/** 旧地址跳到新页面时附带的定位信息：跳过去后滚动并高亮对应项。 */
export interface SettingsRedirect {
  route: SettingsRoute;
  focus?: string;
  /** 旧「浏览插件」页并进了安装对话框。 */
  openInstall?: boolean;
}

const SETTINGS_ROOT = "/settings";

export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_ROOT || pathname.startsWith(`${SETTINGS_ROOT}/`);
}

export function settingsPath(route: SettingsRoute): string {
  switch (route.page) {
    case "home": return SETTINGS_ROOT;
    case "general": return `${SETTINGS_ROOT}/general`;
    case "notifications": return `${SETTINGS_ROOT}/notifications`;
    case "models": return `${SETTINGS_ROOT}/models`;
    case "provider-new": return `${SETTINGS_ROOT}/models/new`;
    case "provider": return `${SETTINGS_ROOT}/models/${encodeURIComponent(route.providerId)}`;
    case "model-groups": return `${SETTINGS_ROOT}/model-groups`;
    case "plugins": return `${SETTINGS_ROOT}/extensions`;
    case "skills": return `${SETTINGS_ROOT}/extensions/skills`;
    case "skill-files": return `${SETTINGS_ROOT}/extensions/skills/${encodeURIComponent(route.skillId)}`;
    case "workspaces": return `${SETTINGS_ROOT}/workspaces`;
    case "remote": return `${SETTINGS_ROOT}/remote`;
    case "about": return `${SETTINGS_ROOT}/about`;
  }
}

const SIMPLE_PAGES: Record<string, SettingsRoute> = {
  general: { page: "general" },
  notifications: { page: "notifications" },
  models: { page: "models" },
  "model-groups": { page: "model-groups" },
  extensions: { page: "plugins" },
  workspaces: { page: "workspaces" },
  remote: { page: "remote" },
  about: { page: "about" },
};

export function parseSettingsPath(pathname: string): SettingsRoute | undefined {
  if (pathname === SETTINGS_ROOT || pathname === `${SETTINGS_ROOT}/`) return { page: "home" };
  if (!pathname.startsWith(`${SETTINGS_ROOT}/`)) return undefined;
  const segments = splitSegments(pathname);
  const [first, second, third] = segments;
  if (segments.length === 1 && first !== undefined) return SIMPLE_PAGES[first];
  if (first === "models" && segments.length === 2 && second !== undefined) return second === "new" ? { page: "provider-new" } : { page: "provider", providerId: second };
  if (first === "extensions" && second === "skills") {
    if (segments.length === 2) return { page: "skills" };
    if (segments.length === 3 && third !== undefined) return { page: "skill-files", skillId: third };
  }
  return undefined;
}

/** 改版前的设置地址（书签、旧版本里的链接）映射到新页面。 */
export function legacySettingsRedirect(pathname: string): SettingsRedirect | undefined {
  if (!pathname.startsWith(`${SETTINGS_ROOT}/`) || parseSettingsPath(pathname) !== undefined) return undefined;
  const segments = splitSegments(pathname);
  const [first, second, third] = segments;
  switch (first) {
    case "data": return segments.length === 1 ? { route: { page: "about" }, focus: "diagnostics" } : undefined;
    case "assistant-name": return segments.length === 1 ? { route: { page: "general" }, focus: "assistant-name" } : undefined;
    case "appearance": return segments.length === 1 ? { route: { page: "general" } } : undefined;
    case "model-scope": return segments.length === 1 ? { route: { page: "models" }, focus: "enabled-models" } : undefined;
    case "tunnel": return segments.length === 1 ? { route: { page: "remote" }, focus: "tunnels" } : undefined;
    case "security": return segments.length === 1 ? { route: { page: "remote" }, focus: "password" } : undefined;
    case "skills":
      if (segments.length === 1) return { route: { page: "skills" } };
      return segments.length === 2 && second !== undefined ? { route: { page: "skill-files", skillId: second } } : undefined;
    case "plugins":
      if (segments.length === 1) return { route: { page: "plugins" } };
      if (segments.length === 2 && second === "install") return { route: { page: "plugins" }, openInstall: true };
      if (segments.length === 2 && second === "model-groups") return { route: { page: "model-groups" } };
      return undefined;
    case "providers":
      if (segments.length === 1) return { route: { page: "models" } };
      if (second === undefined) return undefined;
      if (segments.length === 2) return second === "new" ? { route: { page: "provider-new" } } : { route: { page: "provider", providerId: second } };
      if (segments.length === 3 && second !== "new" && (third === "edit" || third === "override")) return { route: { page: "provider", providerId: second }, focus: "connection" };
      return undefined;
    default:
      return undefined;
  }
}

/** 页面所属的一级分类（导航高亮、手机端返回目标）。 */
export function settingsCategoryOf(route: SettingsRoute): SettingsCategoryId | undefined {
  switch (route.page) {
    case "home": return undefined;
    case "provider":
    case "provider-new":
      return "models";
    case "plugins":
    case "skills":
    case "skill-files":
      return "extensions";
    default:
      return route.page;
  }
}

export function categoryRoute(category: SettingsCategoryId): SettingsRoute {
  return category === "extensions" ? { page: "plugins" } : { page: category };
}

/** 没有应用内历史可退时的上一级：详情页回到分类页，分类页回到首页（手机）。 */
export function parentSettingsRoute(route: SettingsRoute): SettingsRoute | undefined {
  switch (route.page) {
    case "home": return undefined;
    case "provider":
    case "provider-new":
      return { page: "models" };
    case "skill-files":
      return { page: "skills" };
    default:
      return { page: "home" };
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

function splitSegments(pathname: string): string[] {
  return pathname.slice(SETTINGS_ROOT.length + 1).split("/").filter(Boolean).map(decodeSegment);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
