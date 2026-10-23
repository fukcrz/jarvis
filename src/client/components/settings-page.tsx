import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import type { PluginSnapshot } from "../../shared/plugins";
import type { Workspace } from "../../shared/protocol";
import type { SkillSnapshot } from "../../shared/skills";
import { api } from "../api";
import { useIsMobile } from "../hooks/use-is-mobile";
import { SETTINGS_CATEGORIES, SETTINGS_GROUPS, settingsCategory } from "../lib/settings-registry";
import { APP_VERSION } from "../lib/app-version";
import { STATIC_SETTINGS_ENTRIES, type SettingsSearchEntry } from "../lib/settings-search";
import { categoryRoute, isSettingsPath, legacySettingsRedirect, navigateBackOr, parentSettingsRoute, parseSettingsPath, settingsCategoryOf, settingsPath, type SettingsCategoryId, type SettingsRoute } from "../lib/settings-routes";
import { AboutPage, GeneralPage, NotificationsPage, WorkspacesPage, initialNotificationsEnabled } from "./settings-app-pages";
import { UsagePage } from "./settings-usage";
import { ExtensionsPage, SkillFilesPage } from "./settings-extensions";
import { LeaveGuardProvider, SaveStatusProvider, SettingsToastProvider, useLeaveGuard } from "./settings-feedback";
import { ModelGroupsPage } from "./settings-model-groups";
import { ModelsPage, ProviderNewPage, ProviderPage, providerDisplayName, useProviderSettings } from "./settings-providers";
import { RemotePage, type RemoteSummary } from "./settings-remote";
import { SettingsSearchPalette, modKeyLabel } from "./settings-search";
import { displayModelName } from "../model-display";
import { Kbd, SettingsBanner, SettingsTopBar, StButton, settingAnchorId } from "./settings-ui";

export interface SettingsPageProps {
  assistantName: string;
  refreshKeys: { models: number; tunnel: number; security: number };
  onAssistantNameChange: (name: string) => void;
  workspaces: Workspace[];
  onWorkspacesChange: (workspaces: Workspace[]) => void;
  onAddWorkspace: (path: string, label?: string) => Promise<void>;
  onRemoveWorkspace: (workspace: Workspace) => Promise<void>;
  onBack: () => void;
}

interface SettingsLocationState {
  focus?: string;
  openInstall?: boolean;
}

/**
 * 设置入口。电脑端：左侧分类导航 + 右侧整页；手机端：分类列表 → 点进子页。
 * 两端共用 settings-registry 里的同一份分类清单。
 */
export function SettingsPage(props: SettingsPageProps) {
  return <SaveStatusProvider>
    <SettingsToastProvider>
      <LeaveGuardProvider>
        <SettingsShell {...props} />
      </LeaveGuardProvider>
    </SettingsToastProvider>
  </SaveStatusProvider>;
}

function SettingsShell({ assistantName, refreshKeys, onAssistantNameChange, workspaces, onWorkspacesChange, onAddWorkspace, onRemoveWorkspace, onBack }: SettingsPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const leave = useLeaveGuard();
  const parsed = parseSettingsPath(location.pathname);
  const route: SettingsRoute = parsed ?? { page: "home" };
  const state = (location.state ?? {}) as SettingsLocationState;
  const ps = useProviderSettings(refreshKeys.models);
  const [notificationsEnabled, setNotificationsEnabled] = useState(initialNotificationsEnabled);
  const [plugins, setPlugins] = useState<PluginSnapshot>();
  const [skills, setSkills] = useState<SkillSnapshot>();
  const [groupCount, setGroupCount] = useState<{ count: number; enabled: boolean; ids: string[] }>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [remote, setRemote] = useState<RemoteSummary>();

  // 旧地址 → 新地址；未知地址回到首页；电脑端没有「首页」，落到第一个分类。
  useEffect(() => {
    const redirect = legacySettingsRedirect(location.pathname);
    if (redirect !== undefined) {
      navigate(settingsPath(redirect.route), { replace: true, state: { focus: redirect.focus, openInstall: redirect.openInstall } satisfies SettingsLocationState });
      return;
    }
    if (parsed === undefined && isSettingsPath(location.pathname)) navigate(settingsPath({ page: "home" }), { replace: true });
    else if (parsed?.page === "home" && !isMobile) navigate(settingsPath({ page: "general" }), { replace: true, state: location.state });
  }, [isMobile, location.pathname, location.state, navigate, parsed]);

  // 导航摘要需要的数据：插件、技能、模型组、远程状态。
  const loadExtensions = useCallback(() => {
    void api.plugins().then(setPlugins).catch(() => undefined);
    void api.skills().then(setSkills).catch(() => undefined);
  }, []);
  useEffect(() => { loadExtensions(); }, [loadExtensions]);
  useEffect(() => {
    void api.modelGroups().then((snapshot) => setGroupCount({ count: Object.keys(snapshot.config.groups).length, enabled: snapshot.enabled, ids: Object.keys(snapshot.config.groups) })).catch(() => undefined);
  }, [plugins?.bundled]);
  useEffect(() => {
    let disposed = false;
    void Promise.all([api.tunnelList().catch(() => undefined), api.authStatus().catch(() => undefined)]).then(([tunnels, auth]) => {
      if (disposed) return;
      setRemote((current) => ({
        running: tunnels?.filter((tunnel) => tunnel.state === "running").length ?? current?.running ?? 0,
        total: tunnels?.length ?? current?.total ?? 0,
        authRequired: auth?.auth.required ?? current?.authRequired,
      }));
    });
    return () => { disposed = true; };
  }, [refreshKeys.tunnel, refreshKeys.security]);

  // 跳转后定位：滚到对应设置项并闪一下（搜索、旧地址重定向都用它）。
  const focusId = state.focus;
  useEffect(() => {
    if (focusId === undefined) return;
    let cancelled = false;
    let attempts = 0;
    const find = () => {
      if (cancelled) return;
      const element = document.getElementById(settingAnchorId(focusId));
      if (element === null) {
        if (++attempts < 40) window.setTimeout(find, 80);
        return;
      }
      for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.remove("st-flash");
      void element.offsetWidth;
      element.classList.add("st-flash");
      window.setTimeout(() => element.classList.remove("st-flash"), 2_400);
    };
    find();
    return () => { cancelled = true; };
  }, [focusId, location.key]);

  const go = useCallback((next: SettingsRoute, options: { focus?: string; replace?: boolean } = {}) => {
    leave.guard(() => navigate(settingsPath(next), { replace: options.replace, state: options.focus === undefined ? undefined : { focus: options.focus } satisfies SettingsLocationState }));
  }, [leave, navigate]);
  const goBack = useCallback(() => {
    leave.guard(() => {
      const parent = parentSettingsRoute(route);
      const fallback = () => {
        if (parent === undefined || (parent.page === "home" && !isMobile)) onBack();
        else navigate(settingsPath(parent), { replace: true });
      };
      // 手机端分类页的上一级固定是设置首页；电脑端用历史记录返回。
      if (isMobile && parent !== undefined) navigate(settingsPath(parent), { replace: true });
      else navigateBackOr(navigate, fallback);
    });
  }, [isMobile, leave, navigate, onBack, route]);
  const exitSettings = useCallback(() => leave.guard(onBack), [leave, onBack]);

  // Ctrl+K / ⌘K：在设置里搜索。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 搜索索引：固定的设置项 + 供应商、模型、模型组、插件、技能、工作区。
  const searchEntries = useMemo<SettingsSearchEntry[]>(() => {
    const entries: SettingsSearchEntry[] = STATIC_SETTINGS_ENTRIES.filter((entry) => !isMobile || entry.key !== "shortcuts");
    for (const provider of ps.visibleProviders) {
      const name = providerDisplayName(provider, ps.customById.get(provider.id));
      entries.push({ key: `provider:${provider.id}`, title: name, description: `供应商 · ${provider.id}`, keywords: "供应商 provider 连接 api key 密钥 base url", category: "models", route: { page: "provider", providerId: provider.id } });
      if (provider.supportsApiKey || provider.custom) entries.push({ key: `provider-key:${provider.id}`, title: `${name} 的 API Key`, description: "供应商 · 连接", keywords: "密钥 key token", category: "models", route: { page: "provider", providerId: provider.id }, focus: "api-key" });
      for (const model of provider.models) entries.push({ key: `model:${provider.id}/${model.id}`, title: displayModelName(model.name ?? model.id), description: `模型 · ${name} · ${model.id}`, keywords: "模型 model", category: "models", route: { page: "provider", providerId: provider.id }, focus: `model-${provider.id}-${model.id}` });
    }
    for (const id of groupCount?.ids ?? []) entries.push({ key: `group:${id}`, title: id, description: "模型组", keywords: "模型组 路由 group", category: "model-groups", route: { page: "model-groups" }, focus: `model-group-${id}` });
    for (const plugin of plugins?.bundled ?? []) entries.push({ key: `plugin:${plugin.id}`, title: plugin.label, description: "自带插件", keywords: `插件 plugin ${plugin.id}`, category: "plugins", route: { page: "plugins" }, focus: `plugin-${plugin.id}` });
    const seenPlugins = new Set<string>();
    for (const plugin of [...(plugins?.recommended ?? []), ...(plugins?.installed ?? [])]) {
      if (seenPlugins.has(plugin.name)) continue;
      seenPlugins.add(plugin.name);
      const recommended = plugins?.recommended.some((item) => item.name === plugin.name) ?? false;
      entries.push({ key: `plugin:${plugin.name}`, title: plugin.name, description: recommended ? "推荐插件" : "已安装插件", keywords: "插件 plugin npm", category: "plugins", route: { page: "plugins" }, focus: `plugin-${plugin.name}` });
    }
    for (const skill of [...(skills?.bundled ?? []), ...(skills?.installed ?? [])]) {
      entries.push({ key: `skill:${skill.id}`, title: skill.label || skill.name, description: `技能 · ${skill.id}`, keywords: `技能 skill ${skill.name} ${skill.description ?? ""}`, category: "skills", route: { page: "skills" }, focus: `skill-${skill.id}` });
    }
    for (const workspace of workspaces) entries.push({ key: `workspace:${workspace.id}`, title: workspace.label, description: `工作区 · ${workspace.cwd}`, keywords: "工作区 项目 文件夹 workspace", category: "workspaces", route: { page: "workspaces" }, focus: `workspace-${workspace.id}` });
    return entries;
  }, [groupCount?.ids, isMobile, plugins, ps.customById, ps.visibleProviders, skills, workspaces]);
  const pickSearch = (entry: SettingsSearchEntry) => {
    setSearchOpen(false);
    const samePath = settingsPath(entry.route) === location.pathname;
    go(entry.route, { focus: entry.focus, replace: samePath });
  };

  const enabledModelCount = [...ps.enabled].filter((key) => ps.allModelKeys.has(key)).length;
  const remoteWarn = remote !== undefined && remote.running > 0 && remote.authRequired === false;
  const meta = useMemo<Record<SettingsCategoryId, string | undefined>>(() => ({
    general: assistantName,
    notifications: notificationsEnabled ? "开" : "关",
    models: ps.loading ? undefined : ps.connectedCount === 0 ? "未配置" : `${String(ps.connectedCount)} 已连接 · ${String(enabledModelCount)} 模型`,
    usage: undefined,
    "model-groups": groupCount === undefined ? undefined : groupCount.enabled ? `${String(groupCount.count)} 个` : "插件未启用",
    plugins: plugins === undefined ? undefined : `${String(plugins.bundled.filter((item) => item.enabled).length + plugins.recommended.filter((item) => item.installed && item.enabled).length + plugins.installed.filter((item) => !plugins.recommended.some((recommended) => recommended.name === item.name)).length)} 个`,
    skills: skills === undefined ? undefined : `${String(skills.bundled.filter((item) => item.enabled).length + skills.installed.length)} 个`,
    workspaces: `${String(workspaces.length)} 个`,
    remote: remote === undefined ? undefined : remote.running > 0 ? `${String(remote.running)} 运行中` : remote.total > 0 ? "已停止" : "未设置",
    about: APP_VERSION === undefined ? undefined : `v${APP_VERSION}`,
  }), [assistantName, enabledModelCount, groupCount, notificationsEnabled, plugins, ps.connectedCount, ps.loading, remote, skills, workspaces.length]);

  const activeCategory = settingsCategoryOf(route);
  let page: ReactNode = null;
  switch (route.page) {
    case "home":
      page = null;
      break;
    case "general":
      page = <GeneralPage assistantName={assistantName} onAssistantNameChange={onAssistantNameChange} />;
      break;
    case "notifications":
      page = <NotificationsPage enabled={notificationsEnabled} onEnabledChange={setNotificationsEnabled} />;
      break;
    case "models":
      page = <ModelsPage ps={ps} onOpenProvider={(providerId) => go({ page: "provider", providerId })} onAddProvider={() => go({ page: "provider-new" })} />;
      break;
    case "usage":
      page = <UsagePage />;
      break;
    case "provider-new":
      page = <ProviderNewPage ps={ps} onBack={() => go({ page: "models" })} onCreated={(providerId) => go({ page: "provider", providerId }, { replace: true, focus: "provider-models" })} />;
      break;
    case "provider":
      page = <ProviderPage key={route.providerId} ps={ps} providerId={route.providerId} onBack={() => go({ page: "models" })} />;
      break;
    case "model-groups":
      page = <ModelGroupsPage ps={ps} refreshKey={0} onOpenPlugins={() => go({ page: "plugins" }, { focus: "plugin-model-groups-router" })} onSnapshot={(snapshot) => setGroupCount({ count: Object.keys(snapshot.config.groups).length, enabled: snapshot.enabled, ids: Object.keys(snapshot.config.groups) })}
        focusGroupId={state.focus?.startsWith("model-group-") === true && state.focus !== "model-group-list" && state.focus !== "model-group-globals" ? state.focus.slice("model-group-".length) : undefined} focusToken={location.key} />;
      break;
    case "plugins":
    case "skills":
      page = <ExtensionsPage tab={route.page === "skills" ? "skills" : "plugins"}
        plugins={plugins} onPlugins={setPlugins} skills={skills} onSkills={setSkills} openInstall={state.openInstall}
        onOpenModelGroups={() => go({ page: "model-groups" })} onOpenSkillFiles={(skillId) => go({ page: "skill-files", skillId })} />;
      break;
    case "skill-files": {
      const skill = [...(skills?.bundled ?? []), ...(skills?.installed ?? [])].find((item) => item.id === route.skillId);
      page = <SkillFilesPage skillId={route.skillId} label={skill === undefined ? undefined : skill.label || skill.name} onBack={() => go({ page: "skills" })} />;
      break;
    }
    case "workspaces":
      page = <WorkspacesPage workspaces={workspaces} onWorkspacesChange={onWorkspacesChange} onAddWorkspace={onAddWorkspace} onRemoveWorkspace={onRemoveWorkspace} />;
      break;
    case "remote":
      page = <RemotePage refreshKeys={refreshKeys} onSummary={setRemote} />;
      break;
    case "about":
      page = <AboutPage />;
      break;
  }

  const showNav = !isMobile || route.page === "home";
  const showMain = !isMobile || route.page !== "home";
  const parent = parentSettingsRoute(route);
  const mobileTitle = route.page === "provider" ? "供应商" : route.page === "provider-new" ? "添加供应商" : route.page === "skill-files" ? "技能文件" : activeCategory === undefined ? "设置" : settingsCategory(activeCategory).title;
  const mobileBackLabel = parent === undefined || parent.page === "home" ? "设置" : activeCategory === undefined ? "设置" : settingsCategory(activeCategory).title;

  return <section className={`st-app${isMobile ? " mobile" : ""}`}>
    {showNav ? <aside className="st-nav" aria-label="设置分类">
      <button type="button" className="st-nav-back" onClick={exitSettings}><ArrowLeft size={15} /><span className="st-desk">返回会话</span><span className="st-mob">设置</span></button>
      <button type="button" className="st-nav-search" onClick={() => setSearchOpen(true)}><Search size={14} /><span>搜索设置</span><Kbd>{modKeyLabel()} K</Kbd></button>
      {isMobile && remoteWarn ? <SettingsBanner action={<StButton onClick={() => go({ page: "remote" }, { focus: "password" })}>去设置</StButton>}>公网穿透正在运行，但还没设置访问密码</SettingsBanner> : null}
      {SETTINGS_GROUPS.map((group) => <div key={group} className="st-nav-section">
        <div className="st-nav-group">{group}</div>
        <div className="st-nav-list">
          {SETTINGS_CATEGORIES.filter((category) => category.group === group).map((category) => {
            const Icon = category.icon;
            const on = activeCategory === category.id;
            const warn = category.id === "remote" && remoteWarn;
            return <button type="button" key={category.id} className={`st-nav-item${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => { if (!on || route.page !== categoryRoute(category.id).page) go(categoryRoute(category.id)); }}>
              <Icon size={16} />
              <span>{category.title}</span>
              {warn ? <span className="st-dot" title="需要处理：公网地址没有访问密码" /> : meta[category.id] === undefined ? null : <span className="st-meta">{meta[category.id]}</span>}
              <ChevronRight size={15} className="st-nav-chev" />
            </button>;
          })}
        </div>
      </div>)}
    </aside> : null}
    {showMain ? <main className="st-main">
      {isMobile ? <SettingsTopBar title={mobileTitle} backLabel={mobileBackLabel} onBack={goBack} /> : null}
      <div className="st-page" key={isMobile ? undefined : activeCategory}>{page}</div>
    </main> : null}
    <SettingsSearchPalette open={searchOpen} entries={searchEntries} onClose={() => setSearchOpen(false)} onPick={pickSearch} />
  </section>;
}
