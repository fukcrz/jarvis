---
name: panel1
description: 项目清单与多站点 1Panel 管理。登记项目名称、Git 远程地址，关联面板上的网站/容器/运行环境/应用，查询日志与状态、操作服务、初始化站点。当用户提到项目列表、添加/修改/删除项目登记、项目远程地址、1panel、面板、部署或线上环境时使用。项目登记仅在用户明确要求时写入，不自动收集；按完整远程地址或唯一 key 识别。
---

# panel1 —— 多站点 1Panel 管理

## 概述

管理多个 1Panel 面板（称为"站点"）。每个站点在 `data/sites.json` 有独立配置（地址、API Key、版本画像）。`data/projects.json` 是唯一项目清单，保存名称、远程地址和可选部署关联；没有部署的项目也可登记。**按完整 Git 远程地址或唯一 key 匹配**，不保存本地目录路径。项目数据约定与命令见 [项目管理](docs/projects.md)。

**铁律：所有 API 调用必须走 CLI（`scripts/client.mjs`），绝不手拼签名/请求体。** CLI 负责签名（md5）、版本兼容、参数校验、写操作分级。

## 工作流

1. **识别上下文**：
   - 用户提到某个站点名（如"home"）→ 直接查 `node scripts/client.mjs list`
   - 用户明确指定项目名称/key/远程地址 → `project show --repo <名称或完整地址>` 或 `project show --key <key>`；名称重复时询问，不猜
   - 用户指当前仓库 → `git remote get-url origin`，再用完整地址查项目；找不到只报告未登记，不自动创建
   - 都没有指定 → 问用户用哪个站点（用 ask_user_question），不要猜
2. **操作前先查**：用 `query` 拿到确切 id/名称再操作，不要用记忆中的旧 id。
3. **写操作分级执行**（见下）。
4. **情况记录**：
   - 站点特有情况 → `site note --site <key> --text "..."`
   - 项目特有情况 → 仅用户明确要求记录时执行 `project note --key <key> --text "..." --confirm`；部署完成不是自动记笔记的授权
   - 共性踩坑/版本差异 → 更新 `docs/version-compat.md`；通用排障 → `docs/troubleshooting.md`
   - 新站点初始化 → `add-site`（用户名/密码只用于初始化，验证码用 read 看图片后传入）

## 项目登记的写入边界

- **用户说了才写**：添加、修改、删除项目，绑定/解绑部署、追加备注、保存刷新结果，必须有用户本次明确指令。不得扫描仓库自动建档，不得根据项目名猜远程地址或部署归属。
- 所有项目写命令强制 `--confirm`。明确的添加/修改指令且信息齐全即为授权，不必重复确认；该参数不能代替用户授权。
- 删除项目或解绑：先列出目标和影响，说明登记信息无法通过 CLI 恢复，再用 `ask_user_question` 二次确认。只删本地登记/关联，**绝不连带删除 Git 仓库、本地目录或 1Panel 资源**。
- `list/show/check` 只读；`refresh` 默认只查询实时状态，不写数据。只有用户说“更新/保存记录”才能加 `--save --confirm`。刷新失败不落盘、不自动移除失效关联。
- 本节限定项目登记。现有站点 `status/operate` 写入站点状态与日志的行为不变，不应借此改动项目清单。

## 常用命令

```bash
node scripts/client.mjs list                                    # 所有站点
node scripts/client.mjs status --site home                      # 连通性自检
node scripts/client.mjs query websites --site home              # 网站列表
node scripts/client.mjs query websites --site home --id 3       # 网站详情+域名
node scripts/client.mjs query containers --site home --name x
node scripts/client.mjs query apps --site home
node scripts/client.mjs query runtimes --site home              # 运行环境
node scripts/client.mjs query databases --site home --pageSize 50  # 数据库列表(已脱敏)
node scripts/client.mjs query groups --site home                    # 分组(ID 用作建站 webSiteGroupID)
node scripts/client.mjs query acme --site home                      # ACME 账户(证书签发需要, 无则 create acme)
node scripts/client.mjs query ssl --site home --name 域名           # SSL 证书条目(已脱敏)
node scripts/client.mjs logs website --site home --name 域名 --tail 100
node scripts/client.mjs logs panel --site home --type login
node scripts/client.mjs project list                           # 项目列表与部署摘要
node scripts/client.mjs project list --site home                # 按站点反查项目
node scripts/client.mjs project show --key <项目key>             # 项目详情与备注
node scripts/client.mjs project refresh --key <项目key>          # 只查询实时状态，不回写
node scripts/client.mjs project check                          # 只读校验，不修复
node scripts/client.mjs files upload --site k --file 本地zip --path /opt/...   # 上传文件
node scripts/client.mjs files decompress --site k --path 压缩包 --dst 目标目录  # 解压
node scripts/client.mjs files del --site k --path 文件或目录 --confirm        # 递归删除(危险, 必带 --confirm)
node scripts/client.mjs files wget --site k --url <x> --path <目录>            # 服务器直下
```

## 写操作分级（严格遵守）

| 等级 | 操作 | 规则 |
|---|---|---|
| 安全 | start / restart / pause / unpause | 直接执行 |
| 注意 | stop / upgrade | 执行前向用户说一句要干什么（不用等确认） |
| 确认 | **create runtime/website/database/acme/ssl、configure https** | 先向用户说明方案并确认，再带 `--confirm`（CLI 不带会拒绝） |
| 危险 | delete / remove / kill | **先向用户说明方案 → ask_user_question 确认 → 才带 --confirm 执行** |

CLI 对危险操作强制 `--confirm`（不带会拒绝）。但"是否应该走到这一步"由你判断：危险操作未确认前绝不许带 `--confirm`。

## 写操作命令格式

```bash
node scripts/client.mjs operate container --site home --names c1,c2 --action restart
node scripts/client.mjs operate website --site home --id 3 --action stop
node scripts/client.mjs operate website --site home --id 3 --action delete --confirm
node scripts/client.mjs operate app --site home --install-id 2 --action restart
node scripts/client.mjs operate runtime --site home --id 1 --action start
```

## 项目包装部署（编译部署流程）

用户说"编译部署 xxx"时，按以下流程（站点数据来自 `project show --repo`）：

1. **本地编译**：在项目目录执行 build（nuxt build / npm build 等），产出到输出目录
2. **打包**：**Nuxt+pnpm 项目必须用 Bandizip 打包**（普通压缩会因软链接丢依赖，详见 `docs/troubleshooting.md` 部署类）；打完检查 `server/node_modules` 完整性
3. **先删后传（推荐）**：删除目标 index 目录中的**旧部署产物**（构建产物目录/入口文件，如 `assets/`、`static/`、`index.html`），保留站点运行支撑文件（`index.php`、`404.html`、运行时配置等）：`files del --site k --path <产物路径> --confirm`；删除前先向用户说明将删的路径清单
4. **上传**：`files upload --site <k> --file <产物.zip> --path <目标目录>`（目标目录 = runtime 的 CODE_DIR，如 `/opt/1panel/apps/<name>` 或网站 sitePath；zip 先上传到目标目录同级）
5. **解压**：`files decompress --site <k> --path <zip路径> --dst <目标目录>`；解压后可用 `files del` 清理远端 zip 包
6. **重启（仅 Node/编译型 runtime）**：`operate runtime --site k --id <id> --action restart` 或 `operate container --names <容器名> --action restart`。**PHP 运行环境一般不需要重启**：覆盖/保存 PHP 文件后不要 `restart` php-fpm（如 php73），PHP 按请求读最新文件，重启会中断请求且无必要。用户未要求时禁止重启 PHP runtime。
7. **验证**：`query websites --site k --id <id>` 看状态 / `logs website`（若可用）；静态站点 curl 首页 + 关键 chunk 特征

> 经验：运行文件都在宿主机（runtime 容器挂载 CODE_DIR），不需要 SSH/容器终端；一切走面板 API。

## 创建类基础命令（拆分开, 不要封装一键流程）

CLI 只提供原子命令, 流程编排由 Agent 在会话里手工组合：

```bash
node scripts/client.mjs create runtime --site k --name dyzbphp --port 19001 \
  --appDetailId 172 --image 1panel-php-fpm:7.3.33 --confirm
node scripts/client.mjs create website --site k --domain xxx.com --runtimeId N --confirm
node scripts/client.mjs create database --site k --name db --username u --password p --confirm
node scripts/client.mjs create ssl --site k --domain xxx.com --acmeId 1 --confirm
node scripts/client.mjs create ssl --site k --domain xxx.com --acmeId 1 --provider dnsAccount --dns-account-id 1 --confirm
node scripts/client.mjs configure https --site k --websiteId N --sslId N --confirm
node scripts/client.mjs rewrite get --site k --websiteId N
node scripts/client.mjs rewrite set --site k --websiteId N --content-file /tmp/spa.conf --confirm
```

- `create ssl` 默认 provider=http（HTTP-01，域名须已解析到面板）；`--provider dnsAccount --dns-account-id N` 走面板已登记的 DNS 账号（DNS-01）。签发为后台任务，query ssl 看 status=ready 后再 configure https。
- `create website` 的 `webSiteGroupID` 用 query groups 里的 website 类型分组（通常 1=Default）。
- PHP 运行环境参数默认按现有 php73 画像生成（可 --version/--phpExtensions 覆盖）。

## 项目登记与绑定（仅用户明确要求时）

下列写命令示例以已取得授权为前提；登记与部署关联可分别进行：

```bash
node scripts/client.mjs project add --key compass --name "项目名称" --repo https://example.com/team/compass.git --confirm
node scripts/client.mjs project edit --key compass --name "新项目名称" --confirm
node scripts/client.mjs project edit --key compass --add-repo https://mirror.example.com/team/compass.git --confirm
node scripts/client.mjs project bind --key compass --site home --kind website --id 3 --domain xxx.cn --path /opt/... --confirm
node scripts/client.mjs project bind --key compass --site home --kind container --container compass --confirm
```

`project add` 只新建；已有项目修改名称/地址用 `edit`，调整部署关联用 `bind`。同一 `site + kind + id`（容器用名称）重复绑定会更新该关联，域名不是资源身份。先 `query` 核实资源；普通登记命令不调用面板 API。

## 初始化新站点

```bash
node scripts/client.mjs add-site --key <站点名> --url <面板地址> \
  --user <用户名> --entrance <安全入口码> --password-env 环境变量名
```

- 验证码：CLI 第一次运行会保存图片到 /tmp 并打印 captchaID → **用 read 工具查看图片** → 重新运行附上 `--captcha-id <id> --captcha <code>`
- 账号密码只用于本次初始化，登录失败提示与重试注意看 CLI 输出
- 站点名（--key）用户没告知就先用 ask_user_question 问，问了再建

## 版本兼容

不同站点的 1Panel 版本可能不同，CLI 按 `profile`（legacy/current）自动适配路由、状态值和必填字段。**不要假设接口路径**，一律走 CLI。发现新版本差异时先记录到 `docs/version-compat.md` 再考虑改 CLI。

## 常见坑

- 面板对 API 接口有 IP 白名单（当前 home=0.0.0.0/0 全放行）——如果请求 401，先 `status` 看错误码，再查白名单
- 登录失败会触发面板验证码/锁 IP，add-site 重试要拉新验证码
- 站点数据含密码和 Key，仓库必须保持私有
