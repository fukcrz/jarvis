import type { SettingsCategoryId, SettingsRoute } from "./settings-routes";

/** 设置搜索里的一条结果：跳到哪个页面、定位到哪一项。 */
export interface SettingsSearchEntry {
  key: string;
  title: string;
  description?: string;
  /** 额外的检索词（不显示），空格分隔。 */
  keywords?: string;
  category: SettingsCategoryId;
  route: SettingsRoute;
  /** 页面上 settingAnchorId(focus) 对应的元素，跳转后滚过去并高亮。 */
  focus?: string;
}

/** 同义词：任一个词命中，同组的其他词也算命中。都按小写写。 */
export const SETTINGS_SYNONYMS: readonly (readonly string[])[] = [
  ["密码", "认证", "登录", "鉴权", "安全", "password", "auth", "login"],
  ["穿透", "公网", "外网", "隧道", "远程", "内网穿透", "tunnel", "frp", "cloudflare", "cloudflared", "sish"],
  ["测试版", "beta", "预览", "预发布", "通道", "channel"],
  ["正式版", "stable", "稳定版"],
  ["密钥", "api key", "apikey", "key", "token", "令牌"],
  ["供应商", "provider", "服务商", "接口", "账号"],
  ["模型", "model", "llm"],
  ["模型组", "路由", "group", "router", "fallback", "备用"],
  ["插件", "扩展", "plugin", "extension", "npm"],
  ["技能", "skill", "skills"],
  ["工作区", "项目", "文件夹", "目录", "workspace", "project"],
  ["通知", "提醒", "notification", "notify"],
  ["名字", "名称", "昵称", "称呼", "name"],
  ["详细程度", "过程", "档位", "时间线", "简洁", "详细", "detail", "verbose"],
  ["回收站", "删除", "恢复", "trash", "restore"],
  ["日志", "诊断", "log", "logs", "debug", "排查"],
  ["更新", "升级", "版本", "update", "upgrade", "version"],
  ["重启", "restart", "服务"],
  ["快捷键", "键盘", "shortcut", "hotkey"],
  ["退出", "登出", "logout", "设备"],
];

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function expandToken(token: string): string[] {
  const variants = new Set([token]);
  for (const group of SETTINGS_SYNONYMS) {
    if (group.some((word) => word === token || (token.length >= 2 && word.startsWith(token)))) for (const word of group) variants.add(word);
  }
  return [...variants];
}

/**
 * 按空格拆开查询；每个词（或它的同义词）都要命中标题/说明/检索词。
 * 排序：标题开头命中 > 标题包含 > 只在说明或检索词里命中；同分保持原顺序。
 */
export function searchSettings(entries: readonly SettingsSearchEntry[], query: string, limit = 30): SettingsSearchEntry[] {
  const normalized = normalizeSearchText(query);
  if (normalized === "") return entries.slice(0, limit);
  const tokens = normalized.split(" ");
  const scored: { entry: SettingsSearchEntry; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    const title = entry.title.toLowerCase();
    const haystack = `${title} ${(entry.description ?? "").toLowerCase()} ${(entry.keywords ?? "").toLowerCase()}`;
    let score = 0;
    for (const token of tokens) {
      if (title.startsWith(token)) score += 30;
      else if (title.includes(token)) score += 20;
      else if (haystack.includes(token)) score += 10;
      else if (expandToken(token).some((word) => haystack.includes(word))) score += 5;
      else return;
    }
    if (title === normalized) score += 50;
    scored.push({ entry, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((item) => item.entry);
}

/** 不随数据变化的设置项。 */
export const STATIC_SETTINGS_ENTRIES: readonly SettingsSearchEntry[] = [
  { key: "assistant-name", title: "助手名称", description: "通用 · 会话里 AI 的称呼", keywords: "名字 jarvis", category: "general", route: { page: "general" }, focus: "assistant-name" },
  { key: "shortcuts", title: "快捷键", description: "通用 · Ctrl+, 打开设置，Ctrl+K 搜索设置", keywords: "ctrl k 逗号", category: "general", route: { page: "general" }, focus: "shortcuts" },
  { key: "detail-level", title: "过程显示默认档位", description: "外观与显示 · 简洁 / 普通 / 详细", keywords: "详细程度 时间线", category: "appearance", route: { page: "appearance" }, focus: "detail-level" },
  { key: "notify", title: "运行结束通知", description: "通知 · 跑完一轮时提醒", category: "notifications", route: { page: "notifications" }, focus: "notify-run-finished" },
  { key: "providers", title: "供应商", description: "模型与供应商 · 添加、登录、API Key", category: "models", route: { page: "models" }, focus: "providers" },
  { key: "provider-new", title: "添加供应商", description: "模型与供应商 · 官方接口或自定义 OpenAI 兼容接口", keywords: "新建 自定义 base url", category: "models", route: { page: "provider-new" } },
  { key: "enabled-models", title: "启用的模型", description: "模型与供应商 · 选择器里出现哪些模型", keywords: "模型范围 选择器", category: "models", route: { page: "models" }, focus: "enabled-models" },
  { key: "model-groups", title: "模型组", description: "按顺序路由多个模型，失败自动换下一条", category: "model-groups", route: { page: "model-groups" }, focus: "model-group-list" },
  { key: "model-group-globals", title: "重试等待 / 压缩阈值", description: "模型组 · 所有模型组共用的高级参数", keywords: "重试 压缩 token 阈值 预留 compaction retry", category: "model-groups", route: { page: "model-groups" }, focus: "model-group-globals" },
  { key: "bundled-plugins", title: "自带插件", description: "插件与技能 · 模型组路由、会话互通", category: "extensions", route: { page: "plugins" }, focus: "bundled-plugins" },
  { key: "recommended-plugins", title: "推荐插件", description: "插件与技能 · 一键安装", category: "extensions", route: { page: "plugins" }, focus: "recommended-plugins" },
  { key: "install-plugin", title: "安装插件", description: "插件与技能 · 搜索 npm 或填 npm:包名 / GitHub 地址", category: "extensions", route: { page: "plugins" }, focus: "installed-plugins" },
  { key: "skills", title: "技能", description: "插件与技能 · 自带、用户、项目、包", category: "extensions", route: { page: "skills" }, focus: "bundled-skills" },
  { key: "workspaces", title: "工作区", description: "工作区 · 排序、改名、添加、移除", category: "workspaces", route: { page: "workspaces" }, focus: "workspace-list" },
  { key: "tunnels", title: "内网穿透", description: "远程访问 · Cloudflare 隧道 / frp / sish", keywords: "手机", category: "remote", route: { page: "remote" }, focus: "tunnels" },
  { key: "password", title: "访问密码", description: "远程访问 · 登录认证", category: "remote", route: { page: "remote" }, focus: "password" },
  { key: "devices", title: "退出登录的设备", description: "远程访问 · 退出这台设备 / 所有设备", category: "remote", route: { page: "remote" }, focus: "devices" },
  { key: "trash", title: "最近删除", description: "数据与恢复 · 回收站，保留 30 天", category: "data", route: { page: "data" }, focus: "trash" },
  { key: "recoveries", title: "配置恢复记录", description: "数据与恢复 · 配置文件损坏时自动备份", keywords: "备份 损坏", category: "data", route: { page: "data" }, focus: "recoveries" },
  { key: "diagnostics", title: "导出诊断包", description: "数据与恢复 · 日志、版本、配置（不含密码）", keywords: "反馈 问题", category: "data", route: { page: "data" }, focus: "diagnostics" },
  { key: "logs", title: "日志目录", description: "数据与恢复 · 日志文件位置", category: "data", route: { page: "data" }, focus: "logs" },
  { key: "snapshots", title: "每日快照", description: "数据与恢复 · 保留 7 份", keywords: "备份", category: "data", route: { page: "data" }, focus: "snapshots" },
  { key: "version", title: "当前版本", description: "关于与更新 · 版本号、检查更新", keywords: "检查更新", category: "about", route: { page: "about" }, focus: "version" },
  { key: "update-channel", title: "更新通道", description: "关于与更新 · 正式版 / 测试版", category: "about", route: { page: "about" }, focus: "update-channel" },
  { key: "restart-service", title: "重启服务", description: "关于与更新 · 重新启动 Jarvis 后台服务", category: "about", route: { page: "about" }, focus: "restart-service" },
];
