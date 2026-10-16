import { Bell, Folder, Globe, Info, KeyRound, Palette, Puzzle, Route, Settings, type LucideIcon } from "lucide-react";
import type { SettingsCategoryId } from "./settings-routes";

export interface SettingsCategory {
  id: SettingsCategoryId;
  group: "应用" | "AI" | "本机" | "其他";
  title: string;
  /** 页顶的一句话说明。 */
  description: string;
  icon: LucideIcon;
  /** 只在桌面端出现的页面。 */
  desktopOnly?: boolean;
}

/**
 * 设置的唯一分类清单：电脑端左侧导航、手机端首页、搜索结果的「所在分类」都从这里生成，
 * 加新页面只改这一处。
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: "general", group: "应用", title: "通用", description: "基础信息与快捷键。改动立即生效。", icon: Settings },
  { id: "appearance", group: "应用", title: "外观与显示", description: "时间线的显示方式，只保存在这台设备上。", icon: Palette },
  { id: "notifications", group: "应用", title: "通知", description: "运行结束时提醒你。桌面端用系统通知，浏览器里需要先授权。", icon: Bell },
  { id: "models", group: "AI", title: "模型与供应商", description: "连接供应商、选择出现在模型选择器里的模型。开关立即生效，新开会话可用。", icon: KeyRound },
  { id: "model-groups", group: "AI", title: "模型组", description: "把多个供应商的模型合成一个「虚拟模型」：按顺序路由，失败自动换下一条。由自带插件「模型组路由」提供。", icon: Route },
  { id: "extensions", group: "AI", title: "插件与技能", description: "扩展 AI 能做的事。开关从下一次新开的会话开始生效。", icon: Puzzle },
  { id: "workspaces", group: "本机", title: "工作区", description: "会话按工作区分组。拖动调整侧栏顺序，名称可以直接改。", icon: Folder },
  { id: "remote", group: "本机", title: "远程访问", description: "用内网穿透从手机或外网打开这台电脑上的 Jarvis。对外开放时建议设置访问密码。", icon: Globe },
  { id: "about", group: "其他", title: "关于与更新", description: "Jarvis 版本、更新、服务维护与诊断。", icon: Info },
];

export const SETTINGS_GROUPS = ["应用", "AI", "本机", "其他"] as const;

export function settingsCategory(id: SettingsCategoryId): SettingsCategory {
  return SETTINGS_CATEGORIES.find((category) => category.id === id) ?? SETTINGS_CATEGORIES[0]!;
}
