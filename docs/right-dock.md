# 右侧停靠面板（侧聊 / 子代理）

## 结构

```text
时间线                                    ┌ [侧聊] [子代理 ①]  ✕ ┐
                                          ├───────────────────────┤
                                          │ 列表页 / 详情页        │
                                          └───────────────────────┘
                                             ↑ 拖这条边改宽
```

- 一个抽屉、两个 tab、一条宽度：`侧聊` 与 `子代理` 共用 `src/client/components/right-dock.tsx` 的外壳和拖拽手柄。
- 开关在会话顶栏：`SideChatToggle`（侧聊）、`SubagentToggle`（子代理，带运行中数量徽标）。两者都只是"打开面板并切到自己的 tab"，再点一次关闭。
- tab 选择记忆在 `localStorage["jarvis.right-dock.tab"]`，宽度记忆在 `localStorage["jarvis.side-chat.width"]`（280–720，双击分隔条复位 440，`←`/`→` 每次 16px）。

## 子代理面板

数据来源是当前会话时间线里的 `agent_spawn` / `agent_*` 卡片：插件 `pi-subagent-manager` 每 150ms 推一次线程快照，服务端 `src/server/subagent-view.ts` 解析成 `SubagentCallView`，客户端 `src/client/lib/subagent-panel.ts` 摊平成列表行。不新增接口、不轮询。

- **列表页**：`进行中` 在上（按开始时间），`已结束` 在下（默认最近 5 条 + 「查看全部」）。每行两行文本：状态点 + 类型 + 耗时 / 当前动作（单行省略）。层级按线程路径缩进。
- **详情页**：点行替换面板内容，显示状态、模型、thinking、tokens、费用、当前动作、最近步骤、输出、任务；左上「返回」或 `Esc` 回列表。右上「在时间线中定位」复用 `reachSubagentCard`，自动展开所在回合并闪烁对应卡片。输出走 `MarkdownMessage` 渲染，不再是纯文本。
- 进程步骤只来自插件运行时的 live 快照：插件给的是一行状态（如 `Tool: bash`），客户端在 `statusStep()` 里解析出工具名当行首标签。**`recentSteps` 不落盘**，刷新后回看历史线程时「最近步骤」为空，属当前数据层限制。
- 耗时每秒跳一次（仅在有进行中线程时开 timer），当前动作跟着 live 事件更新；行高固定，状态变化只换颜色和图标。

## 边界

- 只表达当前会话；跨会话要看左侧会话列表的状态点。
- 只在桌面端提供。移动端仍用编辑器上方的子代理状态胶囊（`SubagentStatus`）。
- 不提供停止/暂停：Jarvis 目前没有从浏览器直接调用 pi 工具的通道。
