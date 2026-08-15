# Jarvis 自举式开发约定（BOOTSTRAP）

用 Jarvis 开发 Jarvis。核心机制：**编译与重启分离**。

## 工作流

1. **编译**：AI 随时执行 `npm run build`（无风险，不中断服务）。产出新 `dist/`。
2. **重启**：只由用户触发——设置页「重启服务」按钮（或明确说「可以重启了」）。AI 不主动重启。
3. **验收**：重启后连接自动恢复，在 9528 上验收新构建。

```
改源码 → npm run typecheck / npm test（快速反馈）
      → npm run build（随时，AI 可做）
      → 用户点「重启服务」→ 自动重连 → 验收
```

## 验证命令

- `npm run typecheck`（快速类型检查；`markdown-message.tsx` 有预存类型错误可忽略）
- `npm test`（vitest，160 个用例）
- `npm run build`（tsc + vite）
- `node scripts/ui-smoke.mjs`（Playwright UI 冒烟）

## 会话内命令

- `/reload`：重新加载 AGENTS.md / 插件 / 技能 / 提示词（不重开会话；已打开的会话默认不感知外部改动，用它刷新）

## 安全红线

- **未获用户显式授权，不得对 9528 生产服务做任何操作**（kill / 重启 / 抢端口）。
- 重启只加载现有 `dist/`，不会自动编译——想让新代码生效，先编译再点重启。
- 截图验证 UI 时用 `/api/files` 贴图进对话（`![](路径)`）。
