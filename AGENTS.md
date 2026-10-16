# 项目说明（面向 AI 代理）

## ⚠️ 最高优先级警告：不要轻易关闭或重启 9528 端口服务

- **9528 是本机 Jarvis 的生产服务端口**（`src/server/index.ts`：`defaultPort = production ? 9528 : 39130`）。
- **你（AI 代理）自己很可能就运行在这个服务上**：当前的 Pi 会话可能正通过该服务运行，关闭或重启它等于切断自己的连接、中断正在进行的对话和工具调用，可能导致当前会话永久丢失。
- 因此，**除非用户明确要求，禁止**对 9528 端口上的服务执行任何操作，包括但不限于：
  - `kill` / `pkill` / `systemctl stop` 等关闭操作；
  - 重启、重载、`npm start` 抢端口、重启进程导致端口冲突。
- 动手前先自查：`ss -tlnp | grep 9528`，若端口上有监听进程，说明 Jarvis 正在运行，**默认不要动它**。
- **服务运行期间构建是安全的**（如 `npm run build` 重新生成 `dist/`），可以正常执行，不影响正在运行的服务。

## Windows 后台进程与控制台

- Windows 上新增或修改 `spawn`、`execFile`、`spawnSync` 等子进程调用时，必须显式设置 `windowsHide: true`，并且不得继承控制台 `stdio`。
- 需要在调用者退出后持续运行的 Windows Node 服务，禁止直接对 Node 使用 `detached: true`：这会创建控制台窗口。必须复用 `scripts/prod-service.mjs` 的隐藏启动器，或采用等效的隐藏启动方案。
- 后台服务或工具启动路径的改动，必须用非 `9528` 的隔离端口实测：没有控制台弹窗、调用命令返回后进程持续运行、且能够正常停止。

## 其他注意事项

- Pi 嵌在 Jarvis 服务进程里运行：派生 Pi 子进程的扩展（pi-subagent 等）用 `process.argv[1]` 推导子进程入口，会落到 `dist/server/server/index.js`。`src/server/pi-cli-forward.ts` 在启动服务前把这类 Pi CLI 调用（`--mode text|json|rpc`）转发给真正的 Pi CLI；改启动入口时不要绕过它。

- 自举式开发：用 Jarvis 开发 Jarvis 的约定见 [BOOTSTRAP.md](BOOTSTRAP.md)（编译与重启分离；重启只由用户触发）。

- 开发模式端口：Vite 前端 `28471`，Fastify 后端 `39130`（与生产端口 9528 不同，开发重启相对安全，但仍需确认用户意图）。
- Jarvis 存储工作区注册表于 `~/.jarvis/workspaces.json`；Pi JSONL 是会话历史的唯一权威来源，不要与 Pi CLI 并发写入同一个会话。
- 遇到任何"是否要关闭/重启服务"的模糊请求时，先向用户确认，而不是自行操作。

## 插件发版：先核对兼容，再让自动更新生效

Jarvis 会自动把新插件版本应用到已有配置：自带插件只要哈希落在 `plugins/manifest.json` 的已发布清单里，就会覆盖成当前文件；推荐包在启动时缺了就装、已有就更新（`ensureRecommended`）。因此发新版本不能只改代码和哈希。

发布或改动会被自动更新吃进去的插件版本前，必须先检查：

- 新版本与上一版是否兼容：配置、落盘数据、和其他同时加载的插件有没有冲突。
- 不兼容时是否已有升级机制。没有就补升级，或不要让这次变更走自动覆盖/自动更新。
- 检查结论写进该插件的说明或本次变更说明。没核对过，不要更新 `plugins/manifest.json` 的已发布哈希，也不要改 `RECOMMENDED_PACKAGES` 让启动去拉新版本。
- 下线自带插件时，把已发布哈希挪到 `plugins/manifest.json` 的 `retired`，不要直接丢掉。对得上的安装文件会在更新时删除；对不上的留下。移出推荐列表不卸载已安装的包。
