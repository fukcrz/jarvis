---
name: web-research
description: 零付费联网检索与调研路由。需要搜索、打开网页、交叉验证、动态页或登录后浏览时使用。Linux 与 Windows 同一套。
---

# 联网调研

先读 `docs/web-research.md`。按场景升级，不要固定一条链路。

1. 官方入口明确 → `fetch_content` / clone，不搜。
2. 要搜 → `web_search`（Exa → DuckDuckGo）。一次拆 2–3 个不同角度的 query，不要热循环。
3. 打开 3–8 个候选页。摘要只用来找路，结论必须原文。
4. 对比 / 争议 / 引用 → `source_check({ fetchContent: true })`。它的 supported/contradicted 会误判，以原文段落为准。
5. HTTP 空壳 → Jina。Jina 仍空、要点击、分页、登录后 → 本 skill 包装脚本（后台无头 Playwright Chromium）：
   `node "$SKILL_DIR/scripts/pw.js" open <url>`
   详细命令读 `playwright-browser` skill。不要所有任务一上来开浏览器，也不要反复加 Jina 超时。
6. 验证码 / 登录墙 → 停，说明缺什么。

禁止：付费 SERP、`provider: "parallel-mcp"`、硬刮 Google、Whoogle、把敏感 URL 丢给 Jina。
