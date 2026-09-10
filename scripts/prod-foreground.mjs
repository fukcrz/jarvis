#!/usr/bin/env node

process.env["NODE_ENV"] = "production";
if (process.env["JARVIS_PORT"] !== undefined) process.env["PORT"] = process.env["JARVIS_PORT"];
// 这种启动方式下 process.argv[1] 是本脚本，派生子进程的 Pi 扩展会把它当成 Pi CLI。
const { forwardPiCliInvocation } = await import("../dist/server/server/pi-cli-forward.js");
await forwardPiCliInvocation();
await import("../dist/server/server/index.js");
