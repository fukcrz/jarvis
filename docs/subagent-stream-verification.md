# 子代理输出流验证记录

日期：2026-11-13。实现说明见 [right-dock.md](right-dock.md)，助手补定参数见 [未确认业务规则.md](未确认业务规则.md)。

## 当前状态

代码已实现并构建，浏览器验收部分通过；尚未提交或部署本次输出流改动。不得将结束后的输出展示或 runtime 快照视为运行中实时增量的完整验收。

## 静态与自动检查

- 客户端、服务端、配置仓库插件 TypeScript 检查通过。
- 客户端完整测试：46 文件、561 项通过。
- 服务端完整测试：358 项通过、1 项失败。失败为 `snapshot.test.ts` 调用 `unzip` 时 ENOENT，已有环境问题。
- 插件 block ID / 跨 block 正文 / 长正文保留：2 项通过。
- 核心改动 ESLint、git diff --check、完整服务端及客户端构建通过。
- 历史接口回归覆盖：不调用 getActive、归属不符拒绝、读取前后文件 mtime 不变。

## 隔离浏览器验证

仅一个只读 executor：读取 README、git status、sleep；无写文件工具调用。

- 正文、read / bash / bash 三条工具记录及结果展示通过。
- 刷新恢复 7 个唯一输出项，无重复。
- read 展开后完整 README 可见。
- 历史 GET 首次模拟 503，点击重试返回 200，恢复 7 项且无重复。
- 子代理详情无输入框、停止或重新执行按钮。
- 拖拽宽度实测 326px、651px；1440×900 面板打开时输出区 scrollWidth/clientWidth 为 650/650，无横向溢出。
- 390×844 主页面无横向溢出；当前移动端没有子代理 dock。

## 未验证与能力边界

- 未捕获浏览器原始 `subagent.stream` WebSocket 帧、运行中正文增长或工具 partial。首次进入输出页时任务已结束。
- 本轮未取得真实 thinking 输出展示证据。
- 未在浏览器验证超过一页的历史、进程重启后的完整恢复或运行期上翻时的自动跟随行为。
- 简化输出流不支持工具图片。

## 环境与证据

- 源码：`D:\projects\jarvis`；权威插件：`C:\Users\fszax\.pi\agent\plugins\pi-subagent-manager`。
- `JARVIS_HOME=%TEMP%\jarvis-stream-qa`，`PI_CODING_AGENT_DIR=%TEMP%\pi-agent-stream-qa`。
- 工作区：`%TEMP%\jarvis-stream-qa\ws`。
- 测试 API 39131 / PID 22108，Vite 28471 / listener PID 43068；验证结束时保留。进程状态可能变化，复用前再次检查。
- 本轮未操作真实服务 9528 / PID 32884。
- 浏览器报告与截图：`%TEMP%\jarvis-stream-qa-shots\report.md`；关键截图 `03-output-view-after-run.png`、`04-output-after-refresh.png`、`10-read-tool-expanded.png`、`11-history-retry-recovered.png`。
- 本地发行种子源码已同步；未复制构建产物到已安装 Jarvis，也未重启真实服务。
