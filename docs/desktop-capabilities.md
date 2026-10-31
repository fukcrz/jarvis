# 桌面壳能力边界

桌面壳（Tauri）和网页版共用一套前端代码，但浏览器原生行为在 WebView2 里不等价。这里列出**每个能力归谁管**，以及新增功能该怎么接。

## 三条硬规则

1. **组件层不碰宿主**：组件里不写 `@tauri-apps/*`、不写 `window.open`、不判断 `isDesktopShell()`。需要系统能力就调能力层。
2. **引擎层兜底**：下载、主框架导航、新窗口请求在 Rust 的窗口策略里统一处理，漏掉的入口也走同一条路，不会「点了没反应」。
3. **新增能力必须补矩阵**：加一个新能力，同时补本文件的矩阵行、能力层函数、以及对应测试，否则 `npm test` 的守卫会拦。

守卫测试在 `src/client/lib/shell-boundary.test.ts`：能力层白名单、`app.windows` 不许回来、注册命令 ↔ `permissions/desktop.toml` ↔ `capabilities/default.json` 必须一致。CI（`.github/workflows/release-desktop.yml`）会跑 `npm test` 与 `cargo test`。

## 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 引擎层 | `src-tauri/src/lib.rs`（窗口与策略）、`src-tauri/src/download.rs` | 窗口创建、下载接管、导航与新窗口分流、命令实现 |
| 能力层 | `src/client/desktop.ts`、`src/client/lib/download.ts` | 前端唯一出口：下载、打开、定位、外链、更新、通知 |
| 组件层 | `src/client/components/**` | 只用能力层 API |
| 环境层 | `src-tauri/src/{node,sidecar,supervisor,update}.rs` | 运行时、服务生命周期、更新、诊断 |

## 能力矩阵

状态：✅ 已处理 · ⚠️ 有已知缺口 · ❌ 不可用/未做 · ❓ 待实测

### 内容与文件

| 能力 | 桌面壳行为 | 状态 |
| --- | --- | --- |
| 站外 http(s) 外链 | 前端捕获 → 系统浏览器；引擎层兜底 | ✅ |
| 站外 `target=_blank` / `window.open` | `on_new_window` → 系统浏览器，不新开 webview | ✅ |
| `mailto:` / `tel:` | 系统默认程序 | ✅ |
| 整页导航到站外 | `on_navigation` 拦截并转系统浏览器，页面不被替换 | ✅ |
| 下载（锚点 / blob / `data:` / 未来入口） | `on_download` → 临时目录 → 原生另存为 → 通知 | ✅ |
| 下载 401 / 404 | 能力层预检：401 回登录页，其余明确报错，不再存成 `files.json` | ✅ |
| 本地文件链接 | 文本进预览弹窗，其余定位到资源管理器 | ✅ |
| 用系统默认程序打开 | `open_path`（拒绝可执行扩展名） | ✅ |
| 图片/音视频内联 | 正常（`/api/files` 支持 Range） | ✅ |
| 导出诊断包 | 走统一下载链路 | ✅ |
| PDF 预览 | iframe 渲染；窗口参数里单独保留 `msPdfOOUI`，查看器带工具栏（下载 UI 仍由 `on_download` 接管） | ❓ |

### 窗口与导航

| 能力 | 桌面壳行为 | 状态 |
| --- | --- | --- |
| 关闭窗口 | 隐藏到托盘，进程与会话继续 | ✅ |
| 单实例 | 二次启动唤醒已有窗口 | ✅ |
| 托盘菜单、通知点击 | 正常 | ✅ |
| 多显示器 / 不同 DPI 拖拽落点 | 按 `scaleFactor` 换算 | ✅ |
| 返回/前进 | 无浏览器 UI，鼠标侧键无效 | ⚠️ |
| 页面内查找（Ctrl+F） | 未实现 | ❌ |

### 本地系统

| 能力 | 桌面壳行为 | 状态 |
| --- | --- | --- |
| 文件选择（`input[type=file]`） | Chromium 原生对话框 | ✅ |
| 拖文件进输入框 | Tauri `onDragDropEvent` + 坐标换算 | ✅ |
| 文本剪贴板 | Clipboard API + `execCommand` 兜底 | ✅ |
| 图片写剪贴板（mermaid 复制图） | WebView2 ClipboardItem | ❓ |
| 右键菜单 | 系统默认（选中迷你菜单已关） | ✅ |
| 摄像头 / 麦克风 / 定位 / 屏幕共享 | `on_permission_request` 直接拒绝，不弹系统授权框 | ✅（有意） |
| 剪贴板读 / 通知 / 自动播放 / 连续下载 | 允许 | ✅ |

### 渲染与输入

| 能力 | 桌面壳行为 | 状态 |
| --- | --- | --- |
| H.264 / AAC 播放 | Edge 运行时自带 | ✅ |
| MKV / AVI | 不解码，走失败兜底 | ✅（有意） |
| 自动播放策略 | wry 默认参数 | ❓ |
| 中文输入法（CodeMirror 组合输入） | 未验证 | ❓ |
| 暗色主题 | 跟随系统 | ✅ |

### 网络与环境

| 能力 | 桌面壳行为 | 状态 |
| --- | --- | --- |
| 本机服务连接 / 复用 | 健康检查 + 复用已有服务 | ✅ |
| 旧后端复用（版本漂移） | `/api/health` 带 `appVersion`，和客户端版本不一致时提示一次，托盘「重启服务」解决 | ✅ |
| 端口被非 Jarvis 程序占用 | 自动顺延最多 20 个端口，启动页显示换成了哪个；`JARVIS_PORT` 指定时不顺延 | ✅ |
| 局域网访问 | 服务绑 `0.0.0.0` | ✅ |
| 内网穿透 | frp zip 用 PowerShell 解压 | ✅ |
| WebSocket 断线重连 | 已处理；休眠唤醒后未验证 | ❓ |
| 系统代理 / 企业证书（服务端 fetch） | 不读系统代理，未支持自定义 CA | ❌ |
| `%TEMP%` 不可写 | 下载回退到 WebView2 默认路径 | ✅ |

### 运行时

| 能力 | 桌面壳行为 | 状态 |
| --- | --- | --- |
| 系统 Node 22.19+ / 下载运行时 | 已处理，带进度 | ✅ |
| 子进程黑框 | `windowsHide` + preload + postinstall 补丁 | ✅（上游漂移时告警） |
| 服务崩溃自动重启 | 看门狗，5 分钟 3 次退避 | ✅ |
| 渲染进程崩溃 | 白屏后只能重启客户端：wry 0.57 / tauri 2.12 都没暴露 WebView2 的 `ProcessFailed` 事件，做不了自动重载 | ❌ |

## 新增能力怎么做

1. **要碰系统，先加 Rust 命令**，同时改三处：`generate_handler!`、`permissions/desktop.toml`、`capabilities/default.json`（守卫测试会校验一致）。
2. **能力层加函数**（`desktop.ts` 或 `lib/download.ts`），网页端给出等价退化行为，别让组件自己判断环境。
3. **组件只调能力层**。
4. **补矩阵行 + 测试**，再跑 `npm test` 与 `cargo test`。

## 验证方式

- 单测：`download.rs` 的文件名/移动、`navigation_tests` 的分流规则、`download.test.ts` 的预检、`shell-boundary.test.ts` 的边界。
- 桌面壳实测（不改 9528 的生产服务）：

```bash
set JARVIS_PORT=39528
npm run desktop:dev
```

按矩阵逐行验证；下载链路重点看「取消后临时目录清空」「同名文件」「中文名」「401 回登录」。
