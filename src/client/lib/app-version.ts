declare const __JARVIS_VERSION__: string | undefined;

/** 构建时由 Vite 注入的 Jarvis 版本号（package.json）；测试环境里没有。 */
export const APP_VERSION: string | undefined = typeof __JARVIS_VERSION__ === "string" ? __JARVIS_VERSION__ : undefined;

/** 设置页「检查更新」按钮发出的事件，桌面端的更新提示组件会接住并走手动检查流程。 */
export const CHECK_UPDATE_EVENT = "jarvis:check-update";
