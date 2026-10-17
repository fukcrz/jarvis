# 项目登记与部署关联

## 边界

`data/projects.json` 是唯一项目清单，`data/sites.json` 保存 1Panel 站点配置与凭据。项目可以没有部署，也可以关联多个站点、多条资源。此 CLI 不提供自动扫描、自动登记或自动删除资源。

用户明确要求添加/修改时才写登记；只提到项目、打开仓库或要求部署，不代表授权维护登记表。所有项目写命令要求 `--confirm`，由 Agent 在取得授权后传入。删除/解绑须先说明影响，再用 `ask_user_question` 二次确认：记录无法通过 CLI 恢复，但不会删除仓库、目录或远端服务。

## 数据结构

| 字段 | 含义 |
|---|---|
| `key` | 唯一且稳定的项目标识；默认远程仓库末段，同名仓库须指定不同 key |
| `name` | 用户可读名称，可修改；名称不唯一时查找报错 |
| `repoUrls[]` | 同一项目的仓库/镜像地址；每个地址只属于一个项目 |
| `deployments[]` | 可为空；每条关联含 `site`、`kind` 和资源身份 |
| `notes` | 用户要求记录的项目备注，带时间戳；明确写操作也会记录变更摘要 |
| `updatedAt` | 最近登记变更或已保存刷新时间，不等于最新部署时间 |

部署的 `site` 引用 `sites.json` 的 key；`kind` 为 `website/container/runtime/app`。网站、运行环境和应用用正整数 `id`（应用安装 ID）；容器用 `container` 名称。`domain/path` 是可选的用户确认信息。

`path` 是部署操作使用的目录，刷新不会覆盖它。面板报告的网站目录单独存 `sitePath`，运行环境目录单独存 `codeDir`，不能把这三个目录视为等价。缓存状态的时效由部署条目的 `updatedAt` 表示；实际操作前仍须重新查询面板。

远程地址归一化为 `host/path`：HTTPS、SSH 与 scp 格式忽略协议/用户名及 `.git` 后缀，主机名小写，路径保留大小写；非默认端口保留。不允许以仓库简称、本地目录登记远程地址。不同域名/组织下的同名仓库绝不自动合并。

## 读取

```bash
node scripts/client.mjs project list
node scripts/client.mjs project list --name 商城
node scripts/client.mjs project list --site kaice1p
node scripts/client.mjs project list --repo https://example.com/team/shop.git
node scripts/client.mjs project show --key shop
node scripts/client.mjs project show --repo "商城"
node scripts/client.mjs project check
node scripts/client.mjs project refresh --key shop
```

`list` 省略长篇 notes；`show` 返回完整记录。选择器支持 key、完整远程地址或精确名称，歧义时报错。省略选择器时仅检测调用命令时所在目录的 `origin`，不会取第一个 remote；应使用脚本绝对路径在项目目录运行，不要先切到 skill 目录再自动识别。

`refresh` 是实时查询视图，输出 `{ saved, project, errors }`。默认不回写，不追加备注；部分失败返回非零退出码并保留原文件。只有显式保存且全部查询成功才落盘。列表查询有分页与超时，不会把资源未找到解释为应该自动解除关联。

## 写入（先取得明确授权）

```bash
node scripts/client.mjs project add --key shop --name "商城" --repo https://example.com/team/shop.git --confirm
node scripts/client.mjs project edit --key shop --name "新商城名称" --confirm
node scripts/client.mjs project edit --key shop --add-repo https://mirror.example.com/team/shop.git --confirm
node scripts/client.mjs project edit --key shop --remove-repo https://example.com/team/shop.git --confirm
node scripts/client.mjs project bind --key shop --site kaice1p --kind website --id 3 --domain shop.example.com --path /opt/shop --confirm
node scripts/client.mjs project bind --key shop --site kaice1p --kind runtime --id 7 --path /opt/shop --confirm
node scripts/client.mjs project bind --key shop --site kaice1p --kind container --container shop --confirm
node scripts/client.mjs project note --key shop --text "用户要求记录的事项" --confirm
node scripts/client.mjs project refresh --key shop --save --confirm
```

`add` 只新建，不隐式修改同名项目。支持同时指定部署参数；不指定则仅登记。`edit` 可在同一条命令添加新远程、移除旧远程，至少保留一个地址；镜像归属冲突直接报错。`key` 不随名称或仓库地址修改。

`bind` 按资源身份更新同一关联，其余部署不变；参数省略则保留原值。绑定前应查询确认资源 ID，此命令本身只检查本地站点引用，不联系 1Panel。

删除或解绑在二次确认后执行：

```bash
node scripts/client.mjs project unbind --key shop --site kaice1p --kind website --id 3 --confirm
node scripts/client.mjs project unbind --key shop --site kaice1p --kind container --container shop --confirm
node scripts/client.mjs project remove --key shop --confirm
```

`unbind` 只移除指定关联，可清理已不存在站点的失效关联；`remove` 物理删除该项目登记、全部关联和备注。都不会向面板发送删除请求。

## 持久化与验证

项目登记随配置仓库同步；不另存机器本地 checkout 路径。JSON 损坏会报错，不回退为空表；CLI 保存采用同目录临时文件替换、排他写锁与读取快照检查，检测到并行修改就拒绝覆盖。锁是 `.tmp` 文件，已在同步忽略范围。崩溃留下锁时须确认无写入进程后再清理，不自动抢锁。外部手工编辑不受 CLI 写锁保护。

本次保留既有 21 条项目登记及线上部署信息，不迁移、不重写数据。只读校验发现 `zz_blhsym.repoUrls` 含一条仓库简称 `zz_blhsym`（同项目另有完整地址），不属于有效远程地址；须用户要求后再删除该错误条目。该问题不妨碍通过 key 或完整地址查询，`check` 会持续报出。

离线回归测试使用临时目录里的 CLI 副本、模拟站点和本地 HTTP 服务，不访问实际面板、不修改真实登记表：

```bash
node --test tests/panel1-projects.test.mjs
```
