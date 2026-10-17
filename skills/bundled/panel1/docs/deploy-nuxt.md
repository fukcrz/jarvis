# Nuxt 项目标准部署流程

> 适用：Nuxt 4 + pnpm workspace 项目（如 compass）部署到 1Panel 站点。本文件是"照做即成的正面流程"；
> 疑难杂症（打包丢依赖、解压位置不对等）详见 `troubleshooting.md` 部署类。

## 0. 前置：确认部署形态（必做）

```bash
node scripts/client.mjs project show --key <项目key>   # 拿到 site/kind/id/domain/path；未登记则询问，不自动建档
node scripts/client.mjs query websites --site <k> --id <n>   # runtimeName/sitePath
node scripts/client.mjs query runtimes --site <k> --id <n>   # 容器化? 参数 CODE_DIR/run.sh
```

关键判断（决定打包内容与重启对象）：

| 形态 | 说明 |
|---|---|
| **平铺结构**（gongsi1p 现状） | runtime 启动链 `run.sh → npm run start → node ./server/index.mjs`（cwd=CODE_DIR），代码 = `server/`+`public/`+`package.json` 平铺，**不读 .output/** |
| app 目录结构（kaice1p 等） | 代码在 `/opt/1panel/apps/<name>`，通常也是 npm start 模式 |

## 1. 本地构建

```bash
cd <项目>/app && pnpm build        # 产出 .output/{server,public}
```

## 2. 打包（必须 Bandizip）

pnpm 依赖是软链接，普通压缩（PowerShell/zip）会丢 `server/node_modules` 实体：

```bash
cd .output
bandizip c -y ../<pkg>.zip server public    # zip 根 = server/、public/ 两个目录
```

打包后自检：`server/node_modules` 条目数 ≈ 2900+（可 python zipfile 统计抽查）。

## 3. 上传 + 解压（注意 MSYS 路径转换）

**Git Bash 会把 `/opt/...` 转成 `C:/Program Files/Git/...`，一切 --path/-dst 都要加 `MSYS_NO_PATHCONV=1`；--file 用 Windows 路径（cygpath -w）**：

```bash
MSYS_NO_PATHCONV=1 node scripts/client.mjs files upload --site <k> \
  --file "D:\\path\\pkg.zip" --path /opt/1panel/www/sites/compass

MSYS_NO_PATHCONV=1 node scripts/client.mjs files decompress --site <k> \
  --path /opt/1panel/www/sites/compass/pkg.zip --dst /opt/1panel/www/sites/compass
```

- **zip 必须先上传到目标目录内再解压**：current 版面板会忽略 `dst`、按 zip 所在目录解压（见 troubleshooting）
- zip 内顶层内容（server/public）会被整体替换，zip 外的 `package.json`/`package-lock.json` 等保留不动——**打包必须是完整产物**

## 4. 重启

```bash
# 容器化（gongsi1p 现状）
MSYS_NO_PATHCONV=1 node scripts/client.mjs operate container --site <k> --names <容器名> --action restart
# runtime 型
MSYS_NO_PATHCONV=1 node scripts/client.mjs operate runtime --site <k> --id <id> --action restart
```

重启窗口会有几秒 502，属正常。

## 5. 验证（三步，缺一不可）

```bash
# ① 首页 buildId 已更新 + 引用新 chunk
curl -sk https://<域名>/ | grep -oE 'buildId:"[^"]*"'
# ② 新构建独有 chunk 在线 200（hash 文件名构建后才存在）
curl -sk -o /dev/null -w "%{http_code}" https://<域名>/_nuxt/<新chunk>.js   # 期望 200
# 旧版本 chunk 应 404
# ③ 服务器磁盘核心文件 md5 与本地一致（防"解压假成功"）
# files/download?path=<CODE_DIR>/server/chunks/_/nitro.mjs 对比本地 md5
```

## 6. 收尾

- 删除服务器上的部署 zip（`files/del { path }`）
- 仅用户明确要求记录时，执行 `project note --key <项目key> --text "yyyy-mm-dd 部署 xxx" --confirm`；部署指令本身不授权维护项目登记
- 项目专属差异（端口、容器名、目录）同样须用户要求才记入 project note；共性排障经验写入 `troubleshooting.md`

## 常见坑速查

| 坑 | 现象 | 对策 |
|---|---|---|
| 结构传错（.output/ 平铺） | 线上无变化、新 chunk 404 | 见第 0 步；gongsi1p 必须 server/public 平铺 |
| 普通压缩丢依赖 | 启动报模块找不到 | Bandizip；打包后抽查 node_modules |
| Git Bash 路径转换 | 文件传到 `C:/Program Files/Git/...` | 全程 `MSYS_NO_PATHCONV=1` |
| current 版忽略 dst | 解压产物不在 dst | zip 先传到目标目录内 |
| 缓存/面板列表旧快照 | 面板看到旧时间戳 | 以 curl/md5 为准，不信面板列表 |
