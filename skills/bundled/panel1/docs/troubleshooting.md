# 1Panel 排障手册（troubleshooting）

> 按现象找排查路径。新问题解决后，把结论补在最后（格式：现象 → 原因 → 解法）。

## 认证/连接类

### 401 "API 接口禁止访问"
- 面板 API 接口没开（设置→API 接口）→ 用 `add-site` 重新初始化，或面板手动开启
- 状态值错误（旧版需要 `"Enable"` 大写）→ 见 version-compat.md

### 401 "API 接口时间戳错误"
- `apiKeyValidityTime` 未设置/为空 → 更新配置时显式传 `"0"`（add-site 已内置）
- 机器时钟偏差 > 60s → 校准本机时间

### 401 "API 接口密钥错误"
- 常见原因：配置 update 调用（不带 apiKey 字段）**清空了 Key** → 重新走"update→generate"流程（顺序不能反）
- Key 复制错/被轮换 → sites.json 与面板不一致，重新初始化

### 401 "调用 API 接口 IP 不在白名单"
- 本机出口 IP 变了（家宽/代理）→ 面板白名单加 `当前IP/32` 或放宽 `0.0.0.0/0`
- 注意旧版白名单只认 CIDR，裸 IP 不匹配

### 登录失败（add-site 场景）
- `ErrCaptchaCode` → 验证码过期/看错，重新拉
- `ErrEntrance` → 安全入口码不对（URL 路径段，不是密码）
- `ErrAuth` → 用户名/密码错误，或**连续失败已锁 IP**（等几分钟）；面板锁 IP 后要求验证码，脚本无法自动过
- MFA 已启用 → 本 CLI 不支持，手动开通 API Key

## 版本兼容类

### 接口 404 / HTML 页面（非 JSON）
- 面板版本与 CLI 兼容层不匹配 → 查 profile（sites.json），对照 docs/version-compat.md；unknown 时 CLI 已做双路由 fallback
- 请求打到了旧版不存在的新路由（或反之）→ 同上

### 搜索接口 400 "参数错误: …required"
- 缺必填字段（order/orderBy/state）→ CLI 已内置补齐；如果是新模块，把必填字段加进 `SEARCH_EXTRA`

## 功能类

### 网站日志 record not found（home 实测）
- legacy + runtime 类型网站（name=null）→ `files/read` 按 name 查不到网站记录，疑似该组合不支持
- 临时替代：直接看站点路径下日志文件（需 SSH），或面板 UI 查看
- 若其他版本/类型网站可读，更新 version-compat.md 结论

## 部署类

### 改 PHP 代码后不要重启 PHP 运行环境
- **现象**：`files save` / 覆盖 PHP 文件后又 `operate runtime restart`（php73 等 php-fpm）
- **原因**：把 Node/Nuxt 编译部署的重启步骤套到了 PHP。PHP-FPM 按请求读文件，覆盖后即生效
- **解法**：PHP 站点改代码只传文件，**不要重启 PHP runtime**。用户未要求时禁止重启。Node/Nuxt 仍需 restart 才加载新产物
- 来源：2026-09-24 谙新商城（anxin1p / php73）用户明确要求记下

### Nuxt 项目（pnpm）打包后依赖丢失
- **现象**：普通压缩（如 PowerShell Compress-Archive、zip 命令）打包 Nuxt 输出目录后上传部署，`server/node_modules` 下文件不完整/缺失，服务启动报模块找不到
- **原因**：pnpm 全局 store 用**软链接**链接依赖，普通压缩器按链接目标解析/跳过，导致包内只有链接指针而非实体文件；且当前版面板解压（Go archive/zip）不还原符号链接
- **解法**：
  1. **优先用 Bandizip 的 `bz.exe` 打包**（能正确处理软链接、保留实体文件）；用完必须校验产物：zip 内无 0 字节/软链接条目、关键文件完整
  2. **不要用 `Bandizip.exe`（GUI 版）做命令行压缩**：它把参数里的文件名写到当前目录的同名文件（实测把 `-o:` 后第一个文件列表参数解释为输出，会在 cwd 生成/覆盖同名文件，如 `.env` 变成 zip 内容），静默无输出且 exit=0，极难察觉
  3. **没有 Bandizip 时（2026-09-07 sqcs 实测可行）：先实体化/清理 `.output` 内符号链接，再用普通 zip 打包**，详见下条「无 Bandizip 环境：.output 符号链接预处理后 zip 打包」
  4. 普通打包上传后，**必须检查 `server/node_modules` 下文件是否完整**（`files ls` 数量对比、抽查关键包），缺了就得重打
- 适用场景：pnpm 项目 ALL（Nuxt 输出 .output、任何含 node_modules 的部署产物）

### 无 Bandizip 环境：.output 符号链接预处理后 zip 打包（sqcs 实测 2026-09-07）
- **背景**：Bandizip 不可用时，普通 zip（Info-ZIP/7z）无法可靠保留符号链接，而 1Panel 解压器（Go archive/zip）也不还原链接。但 **Nuxt 的 `.output/server/node_modules` 是可以在打包前直接变成纯实体的**——这就是等效方案。
- **原理**：Nitro 产出的 node_modules 是**扁平实体布局**（141 个条目，`node_modules/.nitro/<pkg>@<ver>` 存放去重后的包实体），只有少量符号链接指向 `.nitro/`：
  - 顶层 8 个：**有效链接**（如 `node_modules/readable-stream -> .nitro/readable-stream@3.6.2`）→ 实体化后与链接目标内容完全一致，Node 解析行为不变
  - 嵌套 25 个：**原本就悬空的链接**（如 `node_modules/unzipper/node_modules/readable-stream/node_modules/safe-buffer -> ../../safe-buffer@5.1.2`，目标路径不存在，`.nitro` 里才有）→ Node 模块解析遇悬空链接会**跳过继续向上查找**，所以线上现状也一直工作；**直接删除**即等价（链接如果被解压器还原成普通文件反而会 require 失败，必须删）
- **操作步骤**：
  ```bash
  cd .output
  # ① 实体化有效链接（目标存在才处理）
  while IFS= read -r -d '' l; do
    target=$(readlink "$l")
    if [ -d "$(dirname "$l")/$target" ]; then
      cp -a "$(dirname "$l")/$target" "$(dirname "$l")/.tmp-$(basename "$l")"
      rm "$l" && mv "$(dirname "$l")/.tmp-$(basename "$l")" "$l"
    else
      echo "BROKEN $l -> $target"   # ② 悬空链接：确认后删除
    fi
  done < <(find . -type l -print0)
  find . -type l -delete            # 全量清理后应为 0 个符号链接
  # ③ 打包：zip 根 = server/ public/（平铺结构站点用）
  zip -rq ../<pkg>.zip server public
  ```
- **校验**：`find . -type l | wc -l` = 0；zip 内条目数与 `find` 数一致；部署后验证 `/_nuxt/<新hash>` 200、旧 hash 404、页面 buildId 更新
- **注意**：实体化只对 `.output` 这种 nitro 扁平布局成立；**Workspace 源码级别的 pnpm node_modules（含 `.pnpm` 虚拟 store + 大量嵌套链接）不能这样处理**，必须走 Bandizip
- **遗留**：CLI 无 files 删除子命令（`files del` 只存在于面板 API），部署 zip 会残留在 CODE_DIR，用面板网页删除即可

### Git Bash 会把远端路径转成 Windows 路径
- **现象**：`files mkdir --path /opt/1panel/apps/sqcs` 实际创建的目录是 `C:/Program Files/Git/opt/1panel/apps/sqcs`；后续创建 runtime 报「目录不存在」
- **原因**：Git Bash（MSYS）自动把 `/opt/...` 形参转换为 Windows 路径（`MSYS_NO_PATHCONV` 未关闭）
- **解法**：所有传给 1Panel API 的绝对路径参数，命令前加 `MSYS_NO_PATHCONV=1`

### 本机 DNS 被代理 fake-ip 劫持，域名解析不可信
- **现象**：`nslookup sqcs.yunfanruanjian.com` 返回 `198.18.x.x`（TUN/fake-ip），连 223.5.5.5 也一样；letsencrypt 签发前无法确认域名是否解析到面板主机
- **解法**：用阿里 DoH 验证真实 A 记录：`curl -s "https://dns.alidns.com/resolve?name=<域名>&type=A"`（返回 JSON `Answer[].data`）

### Node runtime 建站后 nginx 报 invalid port in upstream "127.0.0.1:0"
- **现象**：`create website`（type=runtime + Node 运行时）后 nginx reload 失败，日志 `invalid port in upstream "127.0.0.1:0"`
- **原因**：1Panel v2 建站代码对 Node 类 runtime 用请求体 `port` 字段覆盖 runtime 端口（`proxyPort = strconv.Itoa(create.Port)`），不传则 0
- **解法**：`create website --port <runtime 端口>`（CLI 已支持 --port）

### 容器退出码 1：部署后服务起不来（.env 未加载）
- **现象**：Node runtime 容器 `Exited (1)`，应用日志报 `DATABASE_URL environment variable is required`
- **原因**：Node `--env-file` 依赖真实 `.env`；若打包时 `.env` 被损坏（见上一条 Bandizip.exe 坑）或未随包部署，环境变量为空
- **解法**：CODE_DIR 平铺结构放入 `.env`，`package.json` 的 start 脚本用 `node --env-file=.env server/index.mjs`；容器 run.sh 仅执行 `npm install && npm run start`（1Panel 应用商店 Node 模板）

### 1Panel v2 创建 PostgreSQL 数据库报 `exec: "postgresql": executable file not found`
- **原因**：PostgreSQL 创建走独立端点 `POST /databases/pg`（v2），通用 `POST /databases` 只处理 MySQL 类
- **解法**：CLI `create database --type postgresql`（已内置，body 用 `PostgresqlDBCreate`：`database="postgresql"` 为应用实例名）

### 创建 Node runtime 报「目录不存在」
- **原因**：1Panel v2 Node runtime 校验 `body.codeDir` 必须存在且非空（不是 params.CODE_DIR），且需要 `exposedPorts`（容器 3000→宿主映射）
- **解法**：先 `files mkdir --path /opt/1panel/apps/<name>`，再 `create runtime --type node --port <宿主端口> --codeDir /opt/1panel/apps/<name> --appDetailId 1154 --image 1panel/node:25.9.0`（不同 1Panel 版本 appDetailID 可能不同，参考同机现有 node runtime）

## 数据/仓库类

### sites.json 密码/Key 泄露风险
- 仓库必须保持私有；如怀疑泄露 → 重新 add-site 轮换 Key，并改面板密码

### 多设备同步冲突
- 数据文件低频写，冲突极少；如 pull 失败先看远端版本手动合并
- 站点/项目的 notes 是追加式，冲突时保留两份人工合并即可

## kaice1p（current 版面板）：files upload/decompress API 不生效【已更正-见下条，真正原因是 dst 被忽略】

- 现象：CLI `files upload` / `files decompress` 返回成功（code=0），但文件未落盘/未生效，重启服务后仍运行旧代码（对比 `/_nuxt/` 新 hash 文件 404 可确认）。
- 排查确认：非 zip 格式问题（tar.gz 同样）、非符号链接问题（zip 无 symlink）、解压目标目录正确（CODE_DIR=/opt/1panel/apps/<name>）。
- 处理：改用 **1Panel 面板网页手动上传+解压**（文件→/opt/1panel/apps/→上传 zip→解压到代码目录→重启运行环境/容器），随后用 `/_nuxt/<新hash>.<css|js>` 是否 200 验证。
- 待办：修 CLI 后关闭本条目（可能 endpoints 或 multipart 字段与 current 版不符）。

## gongsi1p（legacy + node runtime 容器化）：部署目录是平铺 server/+public/，不是 .output/

- 现象：按"Nuxt .output 部署"把 zip 解压到 runtime CODE_DIR 后重启，线上仍是旧代码（`/_nuxt/<新hash>` 404、页面 buildId 不变）。
- 原因（gongsi1p 本站）：node runtime（appstore 容器化）启动链为 `run.sh` → `npm run start` → `node ./server/index.mjs`（cwd=/app=挂载的 CODE_DIR）；项目代码为**平铺结构** `server/`、`public/`、`package.json`（start 脚本写死 `node ./server/index.mjs`），**不读 `.output/`**。解压 .output 到 CODE_DIR 不会生效。
- 正确流程：Bandizip 打包 `.output/server` 与 `.output/public` 两个目录（zip 根即 server/、public/）→ upload 到 CODE_DIR → decompress 覆盖 → `operate container --names compass --action restart`。
- 验证：`curl https://<域名>/_nuxt/<新构建首个 chunk 名>.js` 返回 200；首页 HTML 的 buildId/chunk 名更新。
- 工具链沉淀：该站点 `files/search` 无法列目录（itemTotal=0）、面板 UI 被安全入口锁定；但 **`files/download?path=` 可读任意文件**、`files/del { path }` 可删除、cronjob shell 可执行命令（输出写 /tmp 后 download 读取）——排查"服务实际读哪个目录"时这套组合很有效。

## kaice1p（current 版面板）：files/decompress 忽略 dst 参数
- 现象：CLI `files decompress --dst X` 解压结果不在 X，而在 **zip 所在目录**（面板 API 忽略 dst）。
- 后果：若 zip 上传在代码目录外（如 /opt/1panel/apps/），解压产物落在目录外，服务无变化，线上看不到新版本（构建产物新 hash 文件 404）。
- 正确姿势：**先把 zip 上传到目标目录（代码目录）内部**，再 `files decompress`（解压跟随 zip 位置），最后重启容器/运行环境。
- 验证办法：构建产物独有的 `/_nuxt/<新hash>.js|css` 返回 200。
- 待办：CLI 应在 decompress 前校验 zip 与 dst 位置关系，或固化为"zip 先传到目标目录内"的流程。
- 版本相关性：未知/无法源码确认（1Panel dev-v2 分支 core/app/api/v2 下无 files 目录，v2 文件 API 不在开源仓库；legacy 版 gongsi1p 的部署形态也不同——平铺 server/+public/）。当前结论：以 zip 位置为准是稳定可用姿势，升级面板未必改变此行为。

## 磁盘空间治理类（kaice1p 实测 2026-09-07）

### `/.1panel_clash/` 是 1Panel 文件传输交换缓存，可整体清理
- **现象**：磁盘 95% 满，SSH 排查发现 `/.1panel_clash/` 占 19GB（files/ 下 47 万+ 小文件 + 大 zip/jar，跨月累积）。
- **性质**：1Panel 面板做**跨主机文件传输/文件交换**时的临时工作目录（文件名 `_1p_file_1p_<路径>_p_<大小>_<时间戳>` + files/ 下按哈希命名的传输中间产物）。传输完成后**不会自动清理**，历史项目（echotune、hjlt）删除后仍残留。
- **安全判断**：`fuser -m`、`lsof +D`、`ls /proc/<1panel pid>/fd | grep clash` 均无占用；传输任务目录 `/opt/1panel/task/` 为空；面板 API 测 `dashboard/base/os` 等接口无需它。确认无进程句柄后即可清。
- **注意**：面板 UI 对 `.1panel_clash` 有特殊保护（拒绝打开/删除该目录，clashOpenAlert/clashDeleteAlert），所以只能 SSH 清理，面板删不了。
- **推荐姿势**：先 `mv /.1panel_clash /root/.trash`（同分区秒级、可回滚），观察几天再 `rm -rf`；不要直接 rm（万一有进行中的传输任务）。

### 1Panel 删除应用不会删镜像，需补 `docker rmi`
- **现象**：`operate app --action delete` 删掉应用后，容器/数据目录/网络都没了，但镜像还留着（nacos 2GB 实测）。
- **解法**：`docker images | grep <镜像名>` 确认后 `docker rmi <镜像>:\<tag>`；也可面板容器→镜像页删。

### 排查磁盘大头的技巧（SSH 只读）
- 分层 du：`du -xsh /* 2>/dev/null | sort -rh` → `du -xsh /opt/1panel/*` → 逐目录。
- `docker system df` 看镜像/容器/卷/构建缓存；`docker info | grep -i root` 确认 Docker Root Dir（kaice1p 的镜像层实际在 `/var/lib/containerd`，标准 overlay2 路径不存在——Docker 用了 containerd snapshotter，Image 12G 但 `/var/lib/docker` 只有 300M，别被误导）。
- 容器日志：`du -ch /var/lib/docker/containers/*/*-json.log` 一次性汇总；要按容器名对账用 `docker inspect --format "{{.Name}}" <id>`。
- 站点目录大小：`du -xsh /opt/1panel/www/sites/* | sort -rh`；部署残留的 zip 多在 `index/` 下（解压后未删），大的能到 700MB+。
- 应用运行时目录：`/opt/1panel/apps/` 下的 `apps/<name>` 与 `apps/<name>_prod` 可能是两套（旧部署残留 + 在用），用 `docker inspect <container> --format "{{json .Mounts}}"` 核对谁被挂载，被挂载的才是活目录。

### 清理前先"移动再删"（推荐流程）
- 目标目录：`/root/.disk-trash-YYYYMMDD/`（同分区 mv 是 rename，秒级完成，不额外占空间）
- `mv` 后验证业务（curl 站点/面板/容器）→ 稳定后再 `rm -rf` 回收目录
- 本次结果：95%（剩 2.9G）→ 55%（剩 26G），释放约 23GB

## jiangzong1p（current 版面板 + node runtime 容器化）：部署形态快照（2026-09-11 实测）

- 站点/站点映射：仓库 `jz_gglm` → website id=3 `jinlinapp.cn`（runtime `jinlin`，id=1，容器 `jinlin`，宿主 127.0.0.1:20000 → 容器 3000）；同机 `echo.jinlinapp.cn` 是**另一项目 Echo Tune**，不属于本仓库。
- **CODE_DIR `/opt/1panel/apps/jinlin` 是平铺结构**：`server/`、`public/`、`nitro.json`、`package.json`（`start: node server/index.mjs`）、`package-lock.json`；**没有 `.env`**——全部环境变量（DATABASE_URL、NUXT_* 密钥等）写在 `/opt/1panel/runtime/node/jinlin/docker-compose.yml` 的 `environment` 里，`run.sh` 只 `source /.env` + `npm install` + `npm run start`。因此部署**不需要**上传 env 文件，新增环境变量要改 compose（改完 restart runtime）。
- 打包：`.output` 下 `bz.exe c -y <zip> server public nitro.json`（zip 根即 server/、public/）；实测 33 个符号链接被打包器实体化（zip 内 `server\node_modules\<pkg>\` 有实体文件，总条目 3699），Bandizip 校验 `All OK`。
- 部署：zip 先上传到 CODE_DIR **内部**再 `files decompress`（current 版忽略 dst）；**覆盖解压可不删旧 `server/`、`public/`**，无缺失窗口——实测解压后 `nitro.json` date 立即变新，`operate runtime --id 1 --action restart` 后容器 createTime 更新、站点 buildId 变化、新 `/_nuxt/<hash>.js` 返回 200。代价是旧 hash chunk 残留（本次 public/_nuxt 由 149 变 200 个条目，不影响运行）。
- 验证基线：`curl -sk -L https://jinlinapp.cn/backstage/login | grep -oE 'buildId:"[^"]*"'`；公开数据接口 `https://jinlinapp.cn/api/app/cities` 可直接用来确认数据修复（如肇东市 adcode）。
