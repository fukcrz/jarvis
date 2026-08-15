import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Radio, Square } from "lucide-react";
import type { TunnelConfig, TunnelMethod, TunnelState, TunnelStatus } from "../../shared/protocol";
import { api } from "../api";
import { Button } from "./ui/button";

const TUNNEL_METHODS: Array<{ id: TunnelMethod; name: string; description: string; recommended?: boolean }> = [
  { id: "cloudflared", name: "Cloudflare 隧道", description: "无需账号，自动下载 cloudflared", recommended: true },
  { id: "localtunnel", name: "localtunnel", description: "npx 零安装，无需账号" },
  { id: "ssh", name: "SSH / localhost.run", description: "系统 ssh，匿名免费" },
  { id: "sish", name: "自建 SSH (sish)", description: "自有服务器，子域名 + 自动 HTTPS" },
  { id: "frp", name: "frp", description: "自有 frps 服务器" },
];

const STATE_META: Record<TunnelState, { label: string; className: string; busy?: boolean }> = {
  idle: { label: "未开启", className: "tunnel-state-idle" },
  starting: { label: "连接中…", className: "tunnel-state-starting", busy: true },
  running: { label: "运行中", className: "tunnel-state-running" },
  stopping: { label: "停止中…", className: "tunnel-state-stopping", busy: true },
  error: { label: "错误", className: "tunnel-state-error" },
};

function portNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
}

export function TunnelPanel({ onMessage }: { onMessage: (message: string, tone?: "success" | "error") => void }) {
  const [status, setStatus] = useState<TunnelStatus>({ state: "idle", logs: [] });
  const [settings, setSettings] = useState<TunnelConfig>({ enabled: false, method: "cloudflared", port: 9528 });
  const [method, setMethod] = useState<TunnelMethod>("cloudflared");
  const [port, setPort] = useState("9528");
  const [sishServer, setSishServer] = useState("");
  const [sishSubdomain, setSishSubdomain] = useState("");
  const [sishSshPort, setSishSshPort] = useState("22");
  const [frpServer, setFrpServer] = useState("");
  const [frpToken, setFrpToken] = useState("");
  const [frpRemotePort, setFrpRemotePort] = useState("");
  const [frpDomain, setFrpDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"url" | "caddy" | undefined>();
  const logRef = useRef<HTMLDivElement | null>(null);
  const onMessageRef = useRef(onMessage);
  const appliedFingerprintRef = useRef("");

  useEffect(() => { onMessageRef.current = onMessage; });

  // 轮询状态：驱动 URL/日志/错误展示。仅同步配置变化到表单，避免覆盖用户编辑。
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const data = await api.tunnelStatus();
        if (disposed) return;
        setStatus(data.status);
        setSettings((current) => {
          if (current.method === data.settings.method && current.port === data.settings.port
            && JSON.stringify(current.sish) === JSON.stringify(data.settings.sish)
            && JSON.stringify(current.frp) === JSON.stringify(data.settings.frp)) return data.settings;
          return data.settings;
        });
      } catch (error) {
        if (!disposed) onMessageRef.current(error instanceof Error ? error.message : "无法读取穿透状态", "error");
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const fingerprint = JSON.stringify({ method: settings.method, port: settings.port, sish: settings.sish, frp: settings.frp });
    if (fingerprint === appliedFingerprintRef.current) return;
    appliedFingerprintRef.current = fingerprint;
    setMethod(settings.method);
    if (settings.port > 0) setPort(String(settings.port));
    if (settings.sish !== undefined) {
      setSishServer(settings.sish.server ?? "");
      setSishSubdomain(settings.sish.subdomain ?? "");
      setSishSshPort(settings.sish.sshPort !== undefined ? String(settings.sish.sshPort) : "22");
    }
    if (settings.frp !== undefined) {
      setFrpServer(settings.frp.server ?? "");
      setFrpToken(settings.frp.token ?? "");
      setFrpRemotePort(settings.frp.remotePort !== undefined ? String(settings.frp.remotePort) : "");
      setFrpDomain(settings.frp.domain ?? "");
    }
  }, [settings]);

  useEffect(() => {
    const element = logRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [status.logs.length]);

  const running = status.state === "running" || status.state === "starting" || status.state === "stopping";
  const parsedPort = portNumber(port);
  const formValid = parsedPort !== undefined
    && (method !== "sish" || sishServer.trim() !== "")
    && (method !== "frp" || frpServer.trim() !== "");

  const buildPatch = (enabled: boolean): Partial<TunnelConfig> => ({
    enabled,
    method,
    ...(parsedPort === undefined ? {} : { port: parsedPort }),
    ...(method === "sish" ? {
      sish: {
        server: sishServer.trim(),
        ...(sishSubdomain.trim() === "" ? {} : { subdomain: sishSubdomain.trim() }),
        ...(portNumber(sishSshPort) === undefined ? {} : { sshPort: portNumber(sishSshPort) as number }),
      },
    } : {}),
    ...(method === "frp" ? {
      frp: {
        server: frpServer.trim(),
        ...(frpToken.trim() === "" ? {} : { token: frpToken }),
        ...(portNumber(frpRemotePort) === undefined ? {} : { remotePort: portNumber(frpRemotePort) as number }),
        ...(frpDomain.trim() === "" ? {} : { domain: frpDomain.trim() }),
      },
    } : {}),
  });

  const apply = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.tunnelUpdateSettings(buildPatch(enabled));
      setStatus(result.status);
      setSettings(result.settings);
      onMessageRef.current(enabled ? "隧道已启动" : "隧道已停止");
    } catch (error) {
      onMessageRef.current(error instanceof Error ? error.message : "操作失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const copyText = async (value: string, kind: "url" | "caddy") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(undefined), 1_500);
    } catch {
      // 剪贴板不可用时忽略
    }
  };

  const remotePort = portNumber(frpRemotePort) ?? parsedPort;
  const caddySnippet = method === "frp"
    ? `${frpDomain.trim() || "你的域名"} {\n    reverse_proxy 127.0.0.1:${remotePort ?? "远程端口"}\n}`
    : "";

  const stateMeta = STATE_META[status.state];

  return <section className="settings-section">
    <div className="settings-section-heading">
      <h2>内网穿透</h2>
      <span className={`tunnel-state ${stateMeta.className}`}>{stateMeta.busy === true ? <Loader2 size={12} className="spin" /> : null}{stateMeta.label}</span>
    </div>
    <p className="settings-muted">把本机 Jarvis 暴露到公网，适合临时演示或远程访问。当前无访问鉴权，公网地址泄露即任何人可操作。</p>

    {status.url === undefined ? null : <div className="tunnel-url">
      <a href={status.url} target="_blank" rel="noreferrer">{status.url}</a>
      <span className="tunnel-url-actions">
        <Button variant="secondary" size="sm" onClick={() => { void copyText(status.url as string, "url"); }}>{copied === "url" ? <Check size={13} /> : <Copy size={13} />}复制</Button>
        <a className="button button-ghost button-icon" href={status.url} target="_blank" rel="noreferrer" aria-label="打开公网地址" title="打开公网地址"><ExternalLink size={14} /></a>
      </span>
    </div>}

    {status.error === undefined ? null : <div className="settings-error" role="alert">{status.error}</div>}

    <div className="tunnel-methods">
      {TUNNEL_METHODS.map((item) => <button type="button" key={item.id} className={`tunnel-method${method === item.id ? " selected" : ""}`} onClick={() => setMethod(item.id)}>
        <strong>{item.name}{item.recommended === true ? <em>推荐</em> : null}</strong>
        <small>{item.description}</small>
      </button>)}
    </div>

    <label className="settings-field"><span>目标端口（本机 Jarvis 端口，生产默认 9528）</span><input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} /></label>

    {method === "sish" ? <div className="tunnel-config-fields">
      <label className="settings-field"><span>服务器地址（user@host 或 host）</span><input value={sishServer} onChange={(event) => setSishServer(event.target.value)} placeholder="如 user@tun.example.com" /></label>
      <label className="settings-field"><span>子域名（可选，留空随机分配）</span><input value={sishSubdomain} onChange={(event) => setSishSubdomain(event.target.value)} placeholder="如 myjarvis → https://myjarvis.example.com" /></label>
      <label className="settings-field"><span>服务器 SSH 端口（默认 22）</span><input type="number" min={1} max={65535} value={sishSshPort} onChange={(event) => setSishSshPort(event.target.value)} /></label>
      <p className="settings-muted">服务端建议部署开源 sish（docker 一条命令 + DNS 泛解析 *.你的域名 → 服务器），自动签发 HTTPS 证书、按子域名转发。官方托管 tuns.sh 为 pico+ 付费订阅（$2/月），自部署免费。</p>
    </div> : null}

    {method === "frp" ? <div className="tunnel-config-fields">
      <label className="settings-field"><span>frps 服务器地址（host:port）</span><input value={frpServer} onChange={(event) => setFrpServer(event.target.value)} placeholder="如 1.2.3.4:7000" /></label>
      <label className="settings-field"><span>token</span><input type="password" value={frpToken} onChange={(event) => setFrpToken(event.target.value)} placeholder="frps 的 auth.token" /></label>
      <label className="settings-field"><span>远程端口（默认与本地端口相同）</span><input type="number" min={1} max={65535} value={frpRemotePort} onChange={(event) => setFrpRemotePort(event.target.value)} /></label>
      <label className="settings-field"><span>域名（可选，用于生成 Caddy HTTPS 配置）</span><input value={frpDomain} onChange={(event) => setFrpDomain(event.target.value)} placeholder="如 jarvis.example.com" /></label>
      {caddySnippet === "" ? null : <div className="tunnel-caddy">
        <div className="tunnel-caddy-head"><span>HTTPS 建议：VPS 上装 Caddy（自动签发/续期 Let's Encrypt 证书），Caddyfile 内容：</span><Button variant="ghost" size="sm" onClick={() => { void copyText(caddySnippet, "caddy"); }}>{copied === "caddy" ? <Check size={13} /> : <Copy size={13} />}复制</Button></div>
        <pre>{caddySnippet}</pre>
      </div>}
      <p className="settings-muted">frp 本身不支持自动证书，域名 + Caddy 是标准 HTTPS 方案。</p>
    </div> : null}

    <div className="dialog-actions tunnel-actions">
      <label className="settings-checkbox"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(event) => { void apply(event.target.checked); }} /><span>自动穿透（服务启动时自动连接）</span></label>
      <Button variant={running ? "danger" : "default"} disabled={busy || (!running && !formValid)} onClick={() => { void apply(!running); }}>
        {busy ? <Loader2 size={14} className="spin" /> : running ? <Square size={14} /> : <Radio size={14} />}
        {running ? "停止" : "启动"}
      </Button>
    </div>

    {status.logs.length === 0 ? null : <div className="tunnel-logs" ref={logRef}>
      {status.logs.map((entry, index) => <div key={`${entry.t}-${index}`}>{entry.line}</div>)}
    </div>}
  </section>;
}
