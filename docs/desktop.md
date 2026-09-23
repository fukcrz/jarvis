# Jarvis 桌面端

Windows 先行的 Tauri 壳。窗口加载本机 Fastify 服务，数据仍在 `~/.jarvis` 与 `~/.pi/agent`。

## 行为

- 启动时使用系统 Node 24+；没有则下载官方 `node.exe` 到 `%LOCALAPPDATA%\jarvis\runtime\`
- 服务绑定 `0.0.0.0`，默认端口 `9528`（可用 `JARVIS_PORT` 覆盖）
- 关闭窗口会藏到托盘，进程和会话继续跑
- 运行结束通知默认开启；窗口在前台时不弹
- 本机已有 Jarvis 在跑时，窗口直接连上，不另起一份；退出桌面壳也不会关掉那份服务
- 端口被非 Jarvis 程序占用才启动失败
- 自动更新读取公开 GitHub Releases 的 `latest.json`；发现新版本先确认再安装
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

## 发布

```bash
npm run desktop:build
```

CI 在 tag `vX.Y.Z` 时构建 NSIS 安装包。更新签名私钥放在 GitHub Actions secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
