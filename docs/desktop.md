# Jarvis 桌面端

Windows 先行的 Tauri 壳。窗口加载本机 Fastify 服务，数据仍在 `~/.jarvis` 与 `~/.pi/agent`。

## 行为

- 启动时使用系统 Node 22.19+；没有则确认后下载官方 `node.exe` 到 `%LOCALAPPDATA%\jarvis\runtime\`，启动页显示进度
- 传给 Node 的路径会去掉 Windows `\\?\` 前缀，避免部分机器上服务进程以 `EISDIR` / `lstat 'C:'` 退出
- 服务绑定 `0.0.0.0`，默认端口 `9528`（可用 `JARVIS_PORT` 覆盖）
- 服务超过 30 秒仍在启动时显示等待状态，60 秒未就绪或进程异常退出时显示末尾诊断日志
- 关闭窗口会藏到托盘，进程和会话继续跑
- 运行结束通知默认开启；窗口在前台时不弹
- 本机已有 Jarvis 在跑时，窗口直接连上，不另起一份；退出桌面壳也不会关掉那份服务
- 端口被非 Jarvis 程序占用才启动失败
- 自动更新读取公开 GitHub Releases 的 `latest.json`。启动后以及每 30 分钟检查一次；有新版本先确认下载，下载完成后再确认安装。下载显示进度，失败可重试。同一版本点过稍后，本次运行不再自动弹。有会话在跑时先提示数量，确认后停止本壳启动的后端，再退出并安装。Windows 更新器的 `cleanup_before_exit` 同样清理后端，避免更新后继续复用旧进程
- 聊天和设置里的外链用系统浏览器打开，不离开 Jarvis 窗口

## 开发

需要 Rust `stable-msvc` 与 VS Build Tools（C++ 工作负载）。

```bash
npm run build
npm run desktop:dev
```

不要对正在使用的 9528 生产服务做重启。本地可：

```bash
set JARVIS_PORT=39528
npm run desktop:dev
```

## 更新后图片报服务端错误

如果 `/api/files` 读取同一张图片不带 `v` 返回 200、带 `v` 返回 500 且报 `Unrecognized key: "v"`，表示网页已更新，但后端仍是更新前的进程。仅刷新网页或重新打开桌面窗口不会替换这个进程。

这次已在实际环境确认：旧后端在 2026-10-10 08:45 启动，0.1.17 文件于 08:52 覆盖安装，后续打开的新桌面壳复用了旧后端。完整新版在隔离服务的桌面和移动视口中通过 26 项本地图片缓存检查。

恢复现有环境需要在会话任务结束后，由用户触发实际服务重启。若新桌面壳只是连接既有服务，其托盘退出不会停止那个服务；应确认旧进程确实退出后再启动客户端。代码修复保证以后通过更新器退出时清理本壳启动的服务，不接管或强杀独立启动的服务。

桌面生命周期回归使用临时目录和随机端口，检查服务启动后持续运行、更新资源清理后端口释放、重复清理及退出后拒绝启动：

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

## 发布

```bash
npm run desktop:build
```

CI 在 tag `vX.Y.Z` 时构建 NSIS 安装包。更新签名私钥放在 GitHub Actions secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
