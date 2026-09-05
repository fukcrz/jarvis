import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Pencil, Plus, Radio, Square, Trash2 } from "lucide-react";
import type { TunnelInput, TunnelMethod, TunnelSnapshot, TunnelState } from "../../shared/protocol";
import { api } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

const TUNNEL_METHODS: Array<{ id: TunnelMethod; name: string; description: string }> = [
  { id: "cloudflared", name: "Cloudflare 隧道", description: "无需账号，自动下载 cloudflared" },
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

function methodName(method: TunnelMethod): string {
  return TUNNEL_METHODS.find((item) => item.id === method)?.name ?? method;
}

export function TunnelPanel({ onMessage }: { onMessage: (message: string, tone?: "success" | "error") => void }) {
  const [tunnels, setTunnels] = useState<TunnelSnapshot[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TunnelSnapshot | undefined>();
  const [detailId, setDetailId] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [copied, setCopied] = useState<"url" | "caddy" | undefined>();
  const onMessageRef = useRef(onMessage);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { onMessageRef.current = onMessage; });

  // 轮询状态：驱动 URL/日志/错误展示。
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const next = await api.tunnelList();
        if (!disposed) setTunnels(next);
      } catch (error) {
        if (!disposed) onMessageRef.current(error instanceof Error ? error.message : "无法读取穿透状态", "error");
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const element = logRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [tunnels]);

  const run = async (operation: string, id: string, fn: () => Promise<TunnelSnapshot>) => {
    if (busy !== undefined) return;
    setBusy(`${operation}-${id}`);
    try {
      const snapshot = await fn();
      setTunnels((current) => current.map((item) => item.id === snapshot.id ? snapshot : item));
    } catch (error) {
      onMessageRef.current(error instanceof Error ? error.message : "操作失败", "error");
    } finally {
      setBusy(undefined);
    }
  };
  const addOrUpdate = async (input: TunnelInput, id?: string) => {
    setBusy("editor");
    try {
      const snapshot = id === undefined ? await api.tunnelAdd(input) : await api.tunnelUpdate(id, input);
      setTunnels((current) => id === undefined
        ? [...current, snapshot].sort((left, right) => left.method.localeCompare(right.method))
        : current.map((item) => item.id === snapshot.id ? snapshot : item));
      setEditorOpen(false);
      onMessageRef.current(id === undefined ? "已添加穿透" : "穿透配置已保存");
    } catch (error) {
      onMessageRef.current(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (tunnel: TunnelSnapshot) => {
    setBusy(`remove-${tunnel.id}`);
    try {
      await api.tunnelRemove(tunnel.id);
      setTunnels((current) => current.filter((item) => item.id !== tunnel.id));
      onMessageRef.current("已删除穿透");
    } catch (error) {
      onMessageRef.current(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      setBusy(undefined);
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

  return <section className="settings-section">
    <div className="settings-section-heading">
      <h2>内网穿透</h2>
      <Button size="sm" onClick={() => { setEditing(undefined); setEditorOpen(true); }}><Plus size={14} />添加穿透</Button>
    </div>
    <p className="settings-muted">把本机 Jarvis 暴露到公网，适合临时演示或远程访问。可同时启用多个穿透（比如 Cloudflare + FRP）。当前无访问鉴权，公网地址泄露即任何人可操作。</p>
    {tunnels.length === 0 ? <div className="model-empty">尚未添加穿透，点击「添加穿透」选择类型（Cloudflare / sish / frp）。</div> : <div className="tunnel-entry-list">
      {tunnels.map((tunnel) => {
        const stateMeta = STATE_META[tunnel.state];
        const detailOpen = detailId === tunnel.id;
        const caddySnippet = tunnel.method === "frp" && tunnel.frp?.domain !== undefined
          ? `${tunnel.frp.domain} {\n    reverse_proxy 127.0.0.1:${portNumber(tunnel.frp.remotePort !== undefined ? String(tunnel.frp.remotePort) : "") ?? "远程端口"}\n}`
          : "";
        return <article className={`tunnel-entry${detailOpen ? " open" : ""}`} key={tunnel.id}>
          <div className="tunnel-entry-head">
            <button type="button" className="tunnel-entry-toggle" onClick={() => setDetailId(detailOpen ? undefined : tunnel.id)}>
              <span className="tunnel-entry-title"><strong>{tunnel.name ?? methodName(tunnel.method)}</strong><small>{tunnel.method}</small></span>
              <span className={`tunnel-state ${stateMeta.className}`}>{stateMeta.busy === true ? <Loader2 size={12} className="spin" /> : null}{stateMeta.label}</span>
            </button>
            <div className="tunnel-entry-actions">
              {tunnel.url === undefined ? null : <>
                <a className="button button-secondary button-default-size" href={tunnel.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />{tunnel.url}</a>
                <Button variant="ghost" size="icon" aria-label="复制公网地址" title="复制公网地址" onClick={() => { void copyText(tunnel.url as string, "url"); }}>{copied === "url" ? <Check size={13} /> : <Copy size={13} />}</Button>
              </>}
              <Button variant="ghost" size="icon" aria-label={`编辑 ${tunnel.name ?? methodName(tunnel.method)}`} title="编辑" onClick={() => { setEditing(tunnel); setEditorOpen(true); }} disabled={busy !== undefined}><Pencil size={14} /></Button>
              <Button variant="ghost" size="icon" aria-label={`删除 ${tunnel.name ?? methodName(tunnel.method)}`} title="删除" disabled={busy !== undefined} onClick={() => { void remove(tunnel); }}><Trash2 size={14} /></Button>
              <Button variant={tunnel.state === "idle" || tunnel.state === "error" ? "default" : "danger"} size="sm" disabled={busy !== undefined} onClick={() => {
                if (tunnel.state === "idle" || tunnel.state === "error") void run("start", tunnel.id, () => api.tunnelStart(tunnel.id));
                else void run("stop", tunnel.id, () => api.tunnelStop(tunnel.id));
              }}>
                {busy === `start-${tunnel.id}` || busy === `stop-${tunnel.id}` ? <Loader2 size={13} className="spin" /> : tunnel.state === "idle" || tunnel.state === "error" ? <Radio size={13} /> : <Square size={13} />}
                {tunnel.state === "idle" || tunnel.state === "error" ? "启动" : "停止"}
              </Button>
            </div>
          </div>
          {tunnel.error === undefined ? null : <div className="settings-error" role="alert">{tunnel.error}</div>}
          {detailOpen ? <div className="tunnel-entry-detail">
            <div className="tunnel-config-fields">
              <label className="settings-field"><span>目标端口</span><input value={String(portNumber("") === undefined ? "" : "")} disabled placeholder="跟随当前服务端口" /></label>
            </div>
            {tunnel.method === "sish" && tunnel.sish !== undefined ? <div className="tunnel-config-fields">
              <label className="settings-field"><span>服务器地址</span><input value={tunnel.sish.server} disabled /></label>
              <label className="settings-field"><span>子域名</span><input value={tunnel.sish.subdomain ?? "（随机分配）"} disabled /></label>
              <label className="settings-field"><span>SSH 端口</span><input value={String(tunnel.sish.sshPort ?? 22)} disabled /></label>
            </div> : null}
            {tunnel.method === "frp" && tunnel.frp !== undefined ? <div className="tunnel-config-fields">
              <label className="settings-field"><span>frps 服务器</span><input value={tunnel.frp.server} disabled /></label>
              <label className="settings-field"><span>远程端口</span><input value={String(tunnel.frp.remotePort ?? "（同本地）")} disabled /></label>
              {caddySnippet === "" ? null : <div className="tunnel-caddy">
                <div className="tunnel-caddy-head"><span>HTTPS 建议（Caddyfile）：</span><Button variant="ghost" size="sm" onClick={() => { void copyText(caddySnippet, "caddy"); }}>{copied === "caddy" ? <Check size={13} /> : <Copy size={13} />}复制</Button></div>
                <pre>{caddySnippet}</pre>
              </div>}
            </div> : null}
            <label className="settings-checkbox tunnel-auto-start"><input type="checkbox" checked={tunnel.enabled} disabled={busy !== undefined} onChange={(event) => { const enabled = event.target.checked; void run("update", tunnel.id, () => api.tunnelUpdate(tunnel.id, {
          method: tunnel.method,
          enabled,
          ...(tunnel.name === undefined ? {} : { name: tunnel.name }),
          ...(tunnel.sish === undefined ? {} : { sish: tunnel.sish }),
          ...(tunnel.frp === undefined ? {} : { frp: tunnel.frp }),
        })); }} /><span>自动启动（服务启动时自动连接，默认关闭）</span></label>
            <p className="settings-muted">当前穿透固定指向本机服务端口（生产默认 9528）。</p>
            {tunnel.logs.length === 0 ? null : <div className="tunnel-logs" ref={logRef}>
              {tunnel.logs.map((entry, index) => <div key={`${entry.t}-${index}`}>{entry.line}</div>)}
            </div>}
          </div> : null}
        </article>;
      })}
    </div>}
    <TunnelEditor open={editorOpen} tunnel={editing} busy={busy === "editor"} onClose={() => setEditorOpen(false)} onSave={addOrUpdate} />
  </section>;
}

/** 添加/编辑穿透的对话框：选类型 + 服务器配置 + 自动启动开关（默认关闭）。 */
function TunnelEditor({ open, tunnel, busy, onClose, onSave }: { open: boolean; tunnel: TunnelSnapshot | undefined; busy: boolean; onClose: () => void; onSave: (input: TunnelInput, id?: string) => void }) {
  const [method, setMethod] = useState<TunnelMethod>("cloudflared");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [sishServer, setSishServer] = useState("");
  const [sishSubdomain, setSishSubdomain] = useState("");
  const [sishSshPort, setSishSshPort] = useState("22");
  const [frpServer, setFrpServer] = useState("");
  const [frpToken, setFrpToken] = useState("");
  const [frpRemotePort, setFrpRemotePort] = useState("");
  const [frpDomain, setFrpDomain] = useState("");

  useEffect(() => {
    if (!open) return;
    if (tunnel === undefined) {
      setMethod("cloudflared");
      setName(""); setEnabled(false);
      setSishServer(""); setSishSubdomain(""); setSishSshPort("22");
      setFrpServer(""); setFrpToken(""); setFrpRemotePort(""); setFrpDomain("");
      return;
    }
    setMethod(tunnel.method);
    setName(tunnel.name ?? "");
    setEnabled(tunnel.enabled);
    setSishServer(tunnel.sish?.server ?? "");
    setSishSubdomain(tunnel.sish?.subdomain ?? "");
    setSishSshPort(tunnel.sish?.sshPort !== undefined ? String(tunnel.sish.sshPort) : "22");
    setFrpServer(tunnel.frp?.server ?? "");
    setFrpToken(tunnel.frp?.token ?? "");
    setFrpRemotePort(tunnel.frp?.remotePort !== undefined ? String(tunnel.frp.remotePort) : "");
    setFrpDomain(tunnel.frp?.domain ?? "");
  }, [open, tunnel]);

  const formValid = (method !== "sish" || sishServer.trim() !== "") && (method !== "frp" || frpServer.trim() !== "");
  const buildInput = (): TunnelInput => ({
    ...(name.trim() === "" ? {} : { name: name.trim() }),
    method,
    enabled,
    ...(method === "sish" ? { sish: {
      server: sishServer.trim(),
      ...(sishSubdomain.trim() === "" ? {} : { subdomain: sishSubdomain.trim() }),
      ...(portNumber(sishSshPort) === undefined ? {} : { sshPort: portNumber(sishSshPort) as number }),
    } } : {}),
    ...(method === "frp" ? { frp: {
      server: frpServer.trim(),
      ...(frpToken.trim() === "" ? {} : { token: frpToken }),
      ...(portNumber(frpRemotePort) === undefined ? {} : { remotePort: portNumber(frpRemotePort) as number }),
      ...(frpDomain.trim() === "" ? {} : { domain: frpDomain.trim() }),
    } } : {}),
  });

  const remotePort = portNumber(frpRemotePort);
  const caddySnippet = method === "frp" && frpDomain.trim() !== ""
    ? `${frpDomain.trim()} {\n    reverse_proxy 127.0.0.1:${remotePort ?? "远程端口"}\n}`
    : "";

  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}><DialogContent className="provider-dialog tunnel-editor-dialog" title={tunnel === undefined ? "添加穿透" : "编辑穿透"} description="目标端口固定为本机服务端口（生产默认 9528）；自动启动默认关闭，需手动启动。">
    <div className="provider-wizard">
      <div className="tunnel-methods">
        {TUNNEL_METHODS.map((item) => <button type="button" key={item.id} className={`tunnel-method${method === item.id ? " selected" : ""}`} onClick={() => setMethod(item.id)}>
          <strong>{item.name}</strong><small>{item.description}</small>
        </button>)}
      </div>
      <label className="settings-field"><span>显示名称（可选）</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="如 演示用 Cloudflare" /></label>
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
        {caddySnippet === "" ? null : <div className="tunnel-caddy"><div className="tunnel-caddy-head"><span>HTTPS 建议：VPS 上装 Caddy（自动签发/续期 Let's Encrypt 证书），Caddyfile 内容：</span></div><pre>{caddySnippet}</pre></div>}
        <p className="settings-muted">frp 本身不支持自动证书，域名 + Caddy 是标准 HTTPS 方案。</p>
      </div> : null}
      <label className="settings-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>自动启动（服务启动时自动连接，默认关闭）</span></label>
      <div className="dialog-actions">
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button disabled={busy || !formValid} onClick={() => onSave(buildInput(), tunnel?.id)}><Check size={14} />{busy ? "保存中…" : tunnel === undefined ? "添加" : "保存"}</Button>
      </div>
    </div>
  </DialogContent></Dialog>;
}
