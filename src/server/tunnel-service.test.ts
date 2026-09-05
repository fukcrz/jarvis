import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFrpcToml, detectTunnelUrl, extractArchiveFile } from "./tunnel-service.js";

describe("detectTunnelUrl", () => {
  it("解析 cloudflared 的 trycloudflare URL", () => {
    const line = "INF Registered tunnel connection connIndex=0 connection=abc123 event=0 https://abc-123.trycloudflare.com";
    expect(detectTunnelUrl("cloudflared", line)).toBe("https://abc-123.trycloudflare.com");
  });

  it("解析 sish 的子域名 URL", () => {
    const line = "Forwarding: https://myjarvis.example.com";
    expect(detectTunnelUrl("sish", line)).toBe("https://myjarvis.example.com");
  });

  it("frp 仅在成功标记出现时返回构造地址", () => {
    expect(detectTunnelUrl("frp", "some random log", "http://1.2.3.4:9528")).toBeUndefined();
    expect(detectTunnelUrl("frp", "INFO start proxy success", "http://1.2.3.4:9528")).toBe("http://1.2.3.4:9528");
  });

  it("清理尾部标点并忽略 ANSI 色码", () => {
    const line = "https://abc-1.trycloudflare.com). \u001b[0m";
    expect(detectTunnelUrl("cloudflared", line)).toBe("https://abc-1.trycloudflare.com");
  });

  it("无关日志不产生 URL", () => {
    expect(detectTunnelUrl("cloudflared", "connecting to edge…")).toBeUndefined();
    expect(detectTunnelUrl("sish", "Warning: Permanently added host key")).toBeUndefined();
  });
});

describe("buildFrpcToml", () => {
  it("生成基本代理配置（代理名带远程端口后缀）", () => {
    const toml = buildFrpcToml("1.2.3.4", 7000, 9528, 9528, "");
    expect(toml).toContain('serverAddr = "1.2.3.4"');
    expect(toml).toContain("serverPort = 7000");
    expect(toml).toContain('type = "tcp"');
    expect(toml).toContain("localPort = 9528");
    expect(toml).toContain("remotePort = 9528");
    expect(toml).toContain('name = "jarvis-9528"');
    expect(toml).not.toContain("auth.token");
  });

  it("包含 token 并转义引号", () => {
    const toml = buildFrpcToml("1.2.3.4", 7000, 8080, 9000, 'pa"ss');
    expect(toml).toContain('auth.token = "pa\\"ss"');
    expect(toml).toContain("localPort = 8080");
    expect(toml).toContain("remotePort = 9000");
  });
});

describe("extractArchiveFile", () => {
  it("解压 tar.gz（系统 tar）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-extract-"));
    try {
      const src = join(dir, "src");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "frpc"), "binary");
      // 相对路径打包，避免 Windows 上 msys GNU tar 把 "C:\\" 解析为 rsh 主机
      const pack = spawnSync("tar", ["-czf", "frp.tar.gz", "-C", "src", "."], { cwd: dir });
      expect(pack.status).toBe(0);
      const out = join(dir, "out");
      await mkdir(out);
      await extractArchiveFile(join(dir, "frp.tar.gz"), out);
      expect(await readFile(join(out, "frpc"), "utf8")).toBe("binary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("解压 zip（PowerShell Expand-Archive）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-extract-"));
    try {
      const src = join(dir, "src");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "frpc.exe"), "binary");
      const pack = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Compress-Archive -Path '${join(src, "*")}' -DestinationPath '${join(dir, "frp.zip")}' -Force`,
      ]);
      expect(pack.status).toBe(0);
      const out = join(dir, "out");
      await mkdir(out);
      await extractArchiveFile(join(dir, "frp.zip"), out);
      expect(await readFile(join(out, "frpc.exe"), "utf8")).toBe("binary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
