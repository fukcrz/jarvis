# 1Panel 版本差异台账（version-compat）

> 遇到"这面板和别的不一样"时，先在这里查；新发现记在这里再改 CLI。
> 画像判定：`add-site` 时拉取 `/1panel/swagger/doc.json`（登录后）路由表 → `legacy` / `current` / `unknown`。

## 画像定义与差异

| 差异点 | legacy（已实测 home） | current（master 源码推断） |
|---|---|---|
| API Key 配置路由 | `POST /api/v2/core/settings/api/config/update`<br>`POST /api/v2/core/settings/api/config/generate/key` | `POST /api/v2/core/auth/api/update`<br>`POST /api/v2/core/auth/api/generate` |
| 成功响应 code | `200`（业务错误也带具体 code） | `0` |
| apiInterfaceStatus | `"Enable"`（大写 E） | `"Enable"`（master constant 相同） |
| 白名单格式 | 只认 CIDR（`0.0.0.0/0` ✓；`0.0.0.0/0,::/0` 反而解析失败；裸 IP `1.2.3.4` 不匹配） | 待验证，默认按 CIDR 传 |
| apiKeyValidityTime | 必须显式传字符串 `"0"`，否则时间戳校验报"时间戳错误" | **实测（kaice1p）**：必须为 int `0`，传字符串报 `cannot unmarshal string into Go struct field ApiInterfaceConfig.apiKeyValidityTime of type int`（CLI 已按路由区分：core/auth→int，core/settings→string） |
| 搜索必填字段 | websites/cronjobs: `order`+`orderBy`；containers 加 `state`（枚举 all/running/...）；`page`/`pageSize` 数字必填 | master 同样有 validate required（超集补齐兼容两版） |
| 日志读取 | `POST /files/read`（`type` 在 body），body 必填 `page/pageSize/type` | `POST /files/read/{type}`（path 优先，body type 兼容） |
| 网站日志 | `files/read` type=website + name 查不到（record not found）——**home 实测不可用**（runtime 类型网站 name=null），待确认是否与网站类型有关 | 待验证 |
| 登录密码 | RSA+AES 混合加密（`RSA-PKCS1v15(AES key):base64(iv):base64(AES-CBC-PKCS7)`），明文直接 ErrAuth，公钥来自 `panel_public_key` cookie | master 同样 CheckPassword→DecryptLoginPassword（同机制） |
| 验证码 | 字符型（math 驱动源码但实际渲染字母数字混合，大小写不敏感；图片 120x50，字体随机） | master 源码为数学算式型（RitaSmith）**实测（kaice1p）数学算式** ✓ |
| 登录路由 | `POST /api/v2/core/auth/login`（entrance 走 `EntranceCode: base64(安全入口)` 头） | 相同（`/api/v2/core/auth/login`） |
| Swagger | 登录后 `/1panel/swagger/doc.json` 可拉（带 psession cookie） | 相同 |
| 文件 API（部署链路） | 待验证 | **实测（kaice1p）**：`POST /files/upload`（multipart，file + path/name/taskID 表单字段，返回 `{}`）；`POST /files/decompress`（body: `{path,dst,type,secret,taskID}` 任务式异步）；`POST /files/wget`（body: `{url,name,path,ignoreCertificate,useProxy}`）；`POST /files/check`（body: `{path}` 存在性）；`POST /files/content`（读小文件）；`POST /files/del`（body: `{path}` 单文件/目录，**不是 paths 数组**）；`POST /files/search`（body: FileOption，**current 返回目录详情对象，items 可能为 null**，列表能力存疑）；`POST /files`（body: `{path,isDir:true}` 创建目录——CLI `files mkdir`）；`POST /files/save`（body: `{path,content}` 写文件——CLI `files save`）。Windows Git Bash 会把 `/opt/...` 改写为 `C:/Program Files/Git/opt/...`，CLI 已在远端 `path/dst` 与项目登记中自动还原。 |
| 创建 PostgreSQL 数据库 | — | **实测（kaice1p）**：走独立端点 `POST /databases/pg`（body: dto.PostgresqlDBCreate，`database`=应用实例名 `postgresql`）；通用 `POST /databases` 只处理 MySQL 类，传 pg 报 `exec: "postgresql": executable file not found` |
| 创建 Node runtime | — | **实测（kaice1p）**：body 层必填 `codeDir`（已存在目录，不是 params.CODE_DIR）+ `exposedPorts`（`[{hostPort,containerPort,hostIP,protocol}]`，容器内 3000）；缺 codeDir 报「目录不存在」；PHP 画像 params 与此不同（`PANEL_APP_PORT_HTTP`） |
| runtime 类型建站 | — | **实测（kaice1p）**：Node runtime 的 website 创建 body 必传 `port`（=runtime 端口），后端用 `create.Port` 生成反代 upstream（`proxyPort = strconv.Itoa(create.Port)`），不传则 `127.0.0.1:0` nginx 启动失败 |
| PostgreSQL 用户权限 | — | **实测（kaice1p）**：`POST /databases/pg/privileges`（body: `{name,database,username,superUser}`）执行 `ALTER USER ... SUPERUSER`；panel 建的 pg 库用户在 PG15+ 对 public schema 无 CREATE 权限（drizzle 迁移报 42501），需先设 superUser=true 或改 schema owner |
| 容器终端 | — | **实测（kaice1p）不可用**：`GET /hosts/terminal/container` 各种 source 值均报 "not support such source"（swagger 未注明参数，疑似新版本挪走了）；`GET /hosts/terminal/local` 可用（宿主机 root shell，双向 `{type:"cmd",data:base64}`）——但**生产部署不建议依赖它，用文件 API + operate 重启即可** |
| 安全入口 | **实测（home）**：入口码不带斜杠（如 `7d4ef58185`）。传 `/xxx` 报"安全入口信息错误"；纯码 base64 后放 `EntranceCode` 头 | **实测（kaice1p）**：同左——URL 路径 `/7d4ef58185` 只是入口路径，`--entrance` 必须传纯码 `7d4ef58185` |
| nodes 能力 | `/core/nodes/*` 不存在（capabilities.nodes=false） | 可能存在 |

## 已验证的流程顺序（勿改动：update 会清空已有 Key）

1. `POST <apiConfig路由>/update` 带 `{apiInterfaceStatus:"Enable", ipWhiteList:"0.0.0.0/0", apiKeyValidityTime:"0"}`
2. `POST <apiConfig路由>/generate/key` 取新 Key
3. 用新 Key 签名自检

> ⚠️ 任何 update 调用（含探测）都会**清空面板上已存的 API Key**，所以必须先 update 后 generate，且不要在已有 Key 的生产站点上做路由探测。

## 待验证（遇到再补）

- runtime 类型网站的日志读取
- 数据库管理模块字段差异
