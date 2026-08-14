import { describe, expect, it } from "vitest";
import { buildFrpcToml, detectTunnelUrl } from "./tunnel-service.js";

describe("detectTunnelUrl", () => {
  it("解析 cloudflared 的 trycloudflare URL", () => {
    const line = "INF Registered tunnel connection connIndex=0 connection=abc123 event=0 https://abc-123.trycloudflare.com";
    expect(detectTunnelUrl("cloudflared", line)).toBe("https://abc-123.trycloudflare.com");
  });

  it("解析 localtunnel 的 your url is 行", () => {
    const line = "your url is: https://lucky-hen-42.loca.lt";
    expect(detectTunnelUrl("localtunnel", line)).toBe("https://lucky-hen-42.loca.lt");
  });

  it("解析 localhost.run 的 lhr.life URL", () => {
    const line = "https://wild-nest-9.lhr.life";
    expect(detectTunnelUrl("ssh", line)).toBe("https://wild-nest-9.lhr.life");
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
    expect(detectTunnelUrl("ssh", "Warning: Permanently added host key")).toBeUndefined();
  });
});

describe("buildFrpcToml", () => {
  it("生成基本代理配置", () => {
    const toml = buildFrpcToml("1.2.3.4", 7000, 9528, 9528, "");
    expect(toml).toContain('serverAddr = "1.2.3.4"');
    expect(toml).toContain("serverPort = 7000");
    expect(toml).toContain('type = "tcp"');
    expect(toml).toContain("localPort = 9528");
    expect(toml).toContain("remotePort = 9528");
    expect(toml).not.toContain("auth.token");
  });

  it("包含 token 并转义引号", () => {
    const toml = buildFrpcToml("1.2.3.4", 7000, 8080, 9000, 'pa"ss');
    expect(toml).toContain('auth.token = "pa\\"ss"');
    expect(toml).toContain("localPort = 8080");
    expect(toml).toContain("remotePort = 9000");
  });
});
