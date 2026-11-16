# Jarvis 本地适配

基于上游 `pi-subagent-manager@1.6.1`，本地 fork。

## 源码位置与加载方式

- 唯一源码：`~/.pi/agent/plugins/pi-subagent-manager`，随配置仓库提交。
- `~/.pi/agent/settings.json` 的 `packages` 用相对路径 `"./plugins/pi-subagent-manager"`（相对 settings 所在目录解析），换机器不需要改。
- 依赖已随包入库（`node_modules/{yaml,fuzzysort,shell-quote}`），克隆后无需 `npm install`。需要重建时用 `npm ci --omit=dev`。
- `<Jarvis>/plugins/pi-subagent-manager` 是发行版种子：本地目录缺失时用于初始化；本地内容仍等于上次播种记录（`<jarvisHome>/local-package-seeds.json`）时随发行版升级；被改过就保留，只在界面上报「有更新」。运行依赖（yaml、fuzzysort、shell-quote）在播种时从 Jarvis 自己的 `node_modules` 复制到本地插件，版本与插件清单一致。
- 改完代码 `/reload` 或新会话生效，没有构建步骤。
- 类型检查：`node <tsc> -p tsconfig.json`。需要 peer 依赖，未安装时全部报 “Cannot find module”；本机通过在插件 `node_modules/` 里对 Jarvis 的 peer 包建 junction 解决，junction 不入库。

## 相对上游的改动

清单同步记录在 `package.json` 的 `_jarvis.patches`。

- 子代理模型请求透传根会话 `ownerSessionId`，用于模型组路由。
- 通过当前会话的 `pi.events` 发送 `pi-subagent:live:v1`，数据为 `{ version: 1, thread: ThreadView }`。进度与用量按线程每 150ms 合并，其他事件立即发送。切换会话和关闭时清理待发计时器。
- 子会话正文、思考及工具执行由 `pi-subagent:stream:v1` 推送 `{ version: 1, path, items }`，每线程按 200ms 合批；结束状态立即冲刷。条目以 assistant timestamp + contentIndex 或 toolCallId 标识，工具支持运行中的部分结果。流不额外裁剪正文，不写入父会话 JSONL。Jarvis 的历史读取与缓冲回放见其 `docs/right-dock.md`。
- 费用显示默认关闭；`costDisplay: "off"` 清除费用状态，设置菜单可选择 Off。
- `ask_user_question` 对所有子代理恒不可用：无人值守的批次不能再被人工提问卡住。
- 类型新增 `canSpawn`（缺省 false）决定是否把 `agent_spawn`/`agent_steer`/`agent_stop`/`agent_wait` 放进工具池，系统提示的委派说明由同一字段生成。
- `agent_spawn` 支持按次传入 `model` 与 `thinkingLevel`；不传则继承。显式 `model` 不可用时立即失败并列出可用候选。
- 类型可声明 `modelAliases`（别名 → `provider/model-id`），`agent_spawn` 的 `model` 既接受别名也接受任意可用模型；`agent_types` 输出每个类型的别名与可用模型数量。别名不是白名单。
- 默认类型不声明任何模型（`models`/`model`/`modelSuggestions` 全部不写），一律继承。`agent_types` 每行显示生效模型、生效思考档（被模型 `thinkingLevelMap` 调整过的会注明声明值）、是否 `delegates`，末尾给出可用模型数量。
- 思考档优先级：显式参数 > 类型配置 > 恢复会话 > 父会话 > 根会话 > `off`（修改前恢复值压过类型配置）。
- `toolFiltering: all-except-blocked` 下类型只写了 `tools.allow` 会得到一条诊断，说明该字段在本模式被忽略。
- 默认类型收敛为 `planner`（只读可派）、`executor`（可写不派）、`verifier`（只读不派，含 review / evidence 两种输出契约）；`docs` 与 `qa` 放在用户层 `~/.pi/agent/subagent-manager/agents/`。

## 重试

子代理用框架默认的重试预算，**不继承根会话 `settings.retry`**（根会话当前为 `maxRetries: 100`）：

| 项 | 子代理 |
|---|---|
| 重试次数 | 3 |
| 退避 | 2000ms 起，指数增长，单次上限 60s |
| 判定 | pi-ai `isRetryableAssistantError`：overloaded、rate limit、429/500/502/503/504/520/524、网络与流中断、timeout；上下文溢出交给压缩，额度/账单类与未列入清单的错误（如 404）直接失败 |

实现位置：`src/orch/runtime.ts` 的 `SettingsManager.inMemory({ cacheWarming: "off" })`。改成内存设置是为了让子代理 `reload()` 不会触发包自动安装；代价是磁盘上的 `retry` 配置也不生效。这是有意保留的行为：后台批次快速失败，把决策交回主代理，避免长时间占用并发槽位。

模型组在 provider 层多一层：未产出内容时同请求内切下一条 route；已产出内容后不混模型，改抛 `HTTP 503` 交给上面的核心重试；整个组耗尽后等待 `retry.groupRetryDelayMs`（180s）再从第一条 route 重来。子代理请求透传根会话的 `ownerSessionId`，因此共用根会话的路由状态。

## 兼容性

费用显示新增 `off` 配置值，保留已有显示模式；未显式配置时默认关闭，无需数据迁移。registry 落盘格式不变，新增的 `canSpawn` 是可选 frontmatter 字段，缺省 false：依赖隐式委派能力的自定义类型需要显式加上 `canSpawn: true`。`tools.allow` 只有在 `toolFiltering: allowed` 下生效，其余模式一律用 `tools.block`，且 `block` 只能写保证存在的内置工具名。

实时事件只用于 UI，不写入 JSONL，不触发模型回合。Jarvis 在会话级事件总线上监听并复用 `tool.upsert` 更新已有卡片及详情；主模型回合结束不丢弃子代理卡片引用。重新打开会话时使用既有 registry 全量与增量记录恢复卡片状态。该本地包不通过已发布哈希自动覆盖，也不从 npm 自动更新。

## 长任务模式

`subagentMode: "orchestration"` 把 /root 变成调度器，主代理与子代理共用 `src/orch/prompt.ts` 里的 `delegationGuidance`（递归纪律）和 `reportingGuidance`（汇报契约）。

- 派不派按动作类型和次数判：主代理全程最多自己动 2 次工具调用，仅限只读查看（read/ls/grep/find）和不产生改动的短命令；改文件、会改动的长命令、联网、多轮试错一律派。不需要工具就能答的问题由主代理自己做。复杂度只决定怎么切。
- 强制 `wait:false`、禁止 `agent_wait`，派完一句话说明在跑什么就结束回合。
- 递归：只有 `planner` 能再派，且只能派叶子（`executor`、`verifier`、`docs`、`qa`）；其余类型都是叶子。子代理尝试派一个仍能派生的类型会被 `manager.spawn` 直接拒绝（`src/orch/manager.ts:352`），不靠提示词自律。层数上限默认 3，即 /root → planner → 叶子。
- 文件所有权：清单每项带「允许改的路径」，派活前查重叠，重叠就串行或合并；构建、部署、迁移永远单负责人。
- 完成闸门：清单全部 `[x]` 且每项挂证据（命令与输出、截图、diff）才能宣布完成；收尾时逐条对照用户原始需求给出「满足 / 不满足 / 待确认」和复现步骤。
- 递归纪律：只派真正可分割的活（独立证据问题、独立实现切片、验证轮），最浅层优先，不许把任务原样下放，不许为了汇总或转发派子代理。
- 汇报：子代理用 `agent_update` 在开始、里程碑、阻塞、交回时各报一行，不贴长输出。
- 清单：跨多个交付物或可能跨上下文压缩时，主代理在 `docs/tasks.md` 用 `- [ ]` / `- [x]` 维护任务清单，清单是扛压缩的锚。
- 停滞保险：`agent_settled` 时如果清单还有未完成项、又没有子代理在跑，插件自动唤醒主代理一次（冷却 45s、同一份清单最多 5 次，清单内容变化即重置配额）。实现见 `src/orch/task-watch.ts`，关闭方式是把 `taskWatchFile` 设为空字符串。
- 唤醒边界：`agent_update` 只进主代理上下文，不唤醒它；只有完成、失败、停止，以及 `timeoutMs` 触发的 timeout 事件会开启主代理新回合。子代理跑完之前主代理不会主动说话，实时进度看 Jarvis 右侧子代理面板。
- 恢复 `opportunistic` 模式即回到“普通任务自己做”。
