import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, Globe, Loader2, LogOut, Pencil, ShieldCheck, Trash2 } from "lucide-react";
import type { AuthStatus, TunnelInput, TunnelLogEntry, TunnelMethod, TunnelSnapshot, TunnelState } from "../../shared/protocol";
import { api, notifyUnauthorized } from "../api";
import { copyText } from "../lib/clipboard";
import { SaveState, SettingsConfirm, useSaveStatus, useSettingsToast } from "./settings-feedback";
import { SectionAction, SettingRow, SettingsBanner, SettingsCard, SettingsEmptyLine, SettingsField, SettingsFormSwitch, SettingsLoading, SettingsPageHead, SettingsSection, SettingsSwitch, SettingsTag, StButton, settingAnchorId } from "./settings-ui";
import { Dialog, DialogContent } from "./ui/dialog";

const TUNNEL_METHODS: Array<{ id: TunnelMethod; name: string; description: string }> = [
  { id: "cloudflared", name: "Cloudflare 隧道", description: "无需账号，每次启动地址会变" },
  { id: "sish", name: "自建 SSH (sish)", description: "用自己的 sish 服务器" },
  { id: "frp", name: "frp", description: "用自己的 frps 服务器，可绑定域名" },
];

const STATE_META: Record<TunnelState, { label: string; tone?: "ok" | "warn" | "acc" | "danger"; busy?: boolean }> = {
  idle: { label: "未开启" },
  starting: { label: "连接中…", tone: "acc", busy: true },
  running: { label: "运行中", tone: "ok" },
  stopping: { label: "停止中…", tone: "acc", busy: true },
  error: { label: "出错", tone: "danger" },
};

export interface RemoteSummary {
  running: number;
  total: number;
  authRequired?: boolean;
}

function portNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
}

function methodName(method: TunnelMethod): string {
  return TUNNEL_METHODS.find((item) => item.id === method)?.name ?? method;
}

function tunnelLabel(tunnel: TunnelSnapshot): string {
  return tunnel.name ?? methodName(tunnel.method);
}

function tunnelDescription(tunnel: TunnelSnapshot): string {
  const parts: string[] = [];
  if (tunnel.method === "cloudflared") parts.push("Cloudflare 隧道 · 无需账号，每次启动地址会变");
  if (tunnel.method === "sish" && tunnel.sish !== undefined) parts.push(`sish · ${tunnel.sish.server}${tunnel.sish.subdomain === undefined ? "" : ` · ${tunnel.sish.subdomain}`}`);
  if (tunnel.method === "frp" && tunnel.frp !== undefined) parts.push(`frp · ${tunnel.frp.server}${tunnel.frp.remotePort === undefined ? "" : ` → 远程端口 ${String(tunnel.frp.remotePort)}`}${tunnel.frp.domain === undefined ? "" : ` · ${tunnel.frp.domain}`}`);
  if (tunnel.enabled) parts.push("随 Jarvis 自动启动");
  return parts.join(" · ");
}

function tunnelInput(tunnel: TunnelSnapshot, patch: Partial<TunnelInput> = {}): TunnelInput {
  return {
    method: tunnel.method,
    enabled: tunnel.enabled,
    ...(tunnel.name === undefined ? {} : { name: tunnel.name }),
    ...(tunnel.sish === undefined ? {} : { sish: tunnel.sish }),
    ...(tunnel.frp === undefined ? {} : { frp: tunnel.frp }),
    ...patch,
  };
}

/** 远程访问：内网穿透 + 访问密码（原「内网穿透」「安全」两页合并）。 */
export function RemotePage({ refreshKeys, onSummary }: { refreshKeys: { tunnel: number; security: number }; onSummary: (summary: RemoteSummary) => void }) {
  const toast = useSettingsToast();
  const saveStatus = useSaveStatus();
  const [tunnels, setTunnels] = useState<TunnelSnapshot[]>();
  const [auth, setAuth] = useState<AuthStatus>();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string>();
  const [editor, setEditor] = useState<{ open: boolean; tunnel?: TunnelSnapshot }>({ open: false });
  const [editorBusy, setEditorBusy] = useState(false);
  const [copied, setCopied] = useState<string>();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // 轮询状态：页面在后台时暂停，回到前台立即刷新。
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const next = await api.tunnelList();
        if (!disposed) setTunnels(next);
      } catch (error) {
        if (!disposed) toastRef.current.notify(error instanceof Error ? error.message : "无法读取穿透状态", "error");
      }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 2_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refreshKeys.tunnel]);
  useEffect(() => {
    let disposed = false;
    void api.authStatus().then(({ auth: next }) => { if (!disposed) setAuth(next); })
      .catch((error: unknown) => { if (!disposed) toastRef.current.notify(error instanceof Error ? error.message : "无法读取访问密码状态", "error"); });
    return () => { disposed = true; };
  }, [refreshKeys.security]);

  const visible = tunnels?.filter((tunnel) => !hidden.has(tunnel.id)) ?? [];
  const running = visible.filter((tunnel) => tunnel.state === "running");
  const runningCount = running.length;
  const authRequired = auth?.required;
  useEffect(() => {
    if (tunnels !== undefined) onSummary({ running: runningCount, total: visible.length, authRequired });
  }, [authRequired, onSummary, runningCount, tunnels, visible.length]);

  const replace = useCallback((snapshot: TunnelSnapshot) => setTunnels((current) => current?.map((item) => item.id === snapshot.id ? snapshot : item)), []);
  const toggleRunning = (tunnel: TunnelSnapshot, on: boolean) => {
    const previous = tunnel;
    replace({ ...tunnel, state: on ? "starting" : "stopping" });
    void saveStatus.run(`tunnel:${tunnel.id}`, async () => { replace(await (on ? api.tunnelStart(tunnel.id) : api.tunnelStop(tunnel.id))); }, { rollback: () => replace(previous) });
  };
  const toggleAutoStart = (tunnel: TunnelSnapshot, enabled: boolean) => {
    const previous = tunnel;
    replace({ ...tunnel, enabled });
    void saveStatus.run(`tunnel-auto:${tunnel.id}`, async () => { replace(await api.tunnelUpdate(tunnel.id, tunnelInput(tunnel, { enabled }))); }, { rollback: () => replace(previous) });
  };
  const remove = (tunnel: TunnelSnapshot) => {
    const setHide = (value: boolean) => setHidden((current) => { const next = new Set(current); if (value) next.add(tunnel.id); else next.delete(tunnel.id); return next; });
    setHide(true);
    toast.showUndo({
      message: `已删除穿透 ${tunnelLabel(tunnel)}${tunnel.state === "running" ? "（会先停止）" : ""}`,
      undo: () => setHide(false),
      commit: async () => {
        await api.tunnelRemove(tunnel.id);
        setTunnels((current) => current?.filter((item) => item.id !== tunnel.id));
        setHide(false);
      },
      onCommitError: (error) => { setHide(false); toast.notify(error instanceof Error ? error.message : "删除失败", "error"); },
    });
  };
  const saveEditor = async (input: TunnelInput, id?: string) => {
    setEditorBusy(true);
    try {
      const snapshot = id === undefined ? await api.tunnelAdd(input) : await api.tunnelUpdate(id, input);
      setTunnels((current) => id === undefined ? [...(current ?? []), snapshot] : current?.map((item) => item.id === snapshot.id ? snapshot : item));
      setEditor({ open: false });
      toast.notify(id === undefined ? "已添加穿透，打开开关就能启动" : "穿透配置已保存");
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setEditorBusy(false);
    }
  };
  const copyValue = async (value: string, key: string) => {
    try {
      await copyText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(undefined), 1_500);
    } catch {
      toast.notify("复制失败", "error");
    }
  };
  const focusPassword = () => {
    const field = document.getElementById("st-password-new");
    document.getElementById(settingAnchorId("password"))?.scrollIntoView({ behavior: "smooth", block: "center" });
    field?.focus({ preventScroll: true });
  };

  const primary = running[0];
  return <>
    <SettingsPageHead title="远程访问" description="用内网穿透从手机或外网打开这台电脑上的 Jarvis。对外开放时建议设置访问密码。" />
    {runningCount > 0 && auth !== undefined && !auth.required ? <SettingsBanner id="remote-warn" action={<StButton onClick={focusPassword}>设置密码</StButton>}>
      公网地址正在运行，但还没有设置访问密码：拿到地址的人都能操作这台电脑。
    </SettingsBanner> : null}
    <SettingsSection id="remote-status" title="当前状态">
      <SettingsCard>
        <div className="st-status-card">
          <Globe size={22} />
          <div className="st-status-text">
            {primary === undefined ? <><b>未开启</b><small>只能在这台电脑上访问</small></> : <><b>运行中 · {tunnelLabel(primary)}{runningCount > 1 ? ` 等 ${String(runningCount)} 条` : ""}</b>{primary.url === undefined ? <small>正在获取公网地址…</small> : <span className="st-url">{primary.url}</span>}</>}
          </div>
          {primary?.url === undefined ? null : <>
            <StButton onClick={() => { void copyValue(primary.url as string, "status"); }}>{copied === "status" ? <Check size={13} /> : <Copy size={13} />}{copied === "status" ? "已复制" : "复制"}</StButton>
            <a className="st-btn" href={primary.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开</a>
          </>}
          {auth === undefined ? null : auth.required ? <SettingsTag tone="ok">有密码</SettingsTag> : <SettingsTag tone="warn">没有密码</SettingsTag>}
        </div>
      </SettingsCard>
    </SettingsSection>
    <SettingsSection id="tunnels" title="内网穿透" action={<SectionAction label="添加穿透" onClick={() => setEditor({ open: true })} />}>
      {tunnels === undefined ? <SettingsLoading /> : <SettingsCard>
        {visible.length === 0 ? <SettingsEmptyLine>还没有穿透。添加一条 Cloudflare 隧道最省事，不需要账号。</SettingsEmptyLine> : visible.map((tunnel) => {
          const meta = STATE_META[tunnel.state];
          const open = openId === tunnel.id;
          const on = tunnel.state === "running" || tunnel.state === "starting";
          const caddySnippet = tunnel.method === "frp" && tunnel.frp?.domain !== undefined
            ? `${tunnel.frp.domain} {\n    reverse_proxy 127.0.0.1:${tunnel.frp.remotePort === undefined ? "远程端口" : String(tunnel.frp.remotePort)}\n}`
            : "";
          return <div key={tunnel.id} className={`st-expand${open ? " open" : ""}`} id={settingAnchorId(`tunnel-${tunnel.id}`)}>
            <SettingRow title={<>{tunnelLabel(tunnel)}<SettingsTag tone={meta.tone}>{meta.busy === true ? <Loader2 size={11} className="spin" /> : null}{meta.label}</SettingsTag></>} description={tunnelDescription(tunnel)}
              control={<>
                <StButton variant="ghost" icon aria-label={open ? "收起详情" : "展开详情"} title={open ? "收起" : "详情与日志"} onClick={() => setOpenId(open ? undefined : tunnel.id)}><ChevronDown size={14} className="st-rot" /></StButton>
                <StButton variant="ghost" icon aria-label={`编辑 ${tunnelLabel(tunnel)}`} title="编辑" onClick={() => setEditor({ open: true, tunnel })}><Pencil size={14} /></StButton>
                <StButton variant="ghost" icon aria-label={`删除 ${tunnelLabel(tunnel)}`} title="删除" onClick={() => remove(tunnel)}><Trash2 size={14} /></StButton>
                <SaveState k={`tunnel:${tunnel.id}`} />
                <SettingsSwitch checked={on} disabled={meta.busy === true} label={on ? `停止 ${tunnelLabel(tunnel)}` : `启动 ${tunnelLabel(tunnel)}`} onChange={(next) => toggleRunning(tunnel, next)} />
              </>} />
            {tunnel.error === undefined ? null : <div className="st-row-error" role="alert">{tunnel.error}</div>}
            {tunnel.url === undefined || primary?.id === tunnel.id ? null : <div className="st-row-sub"><span className="st-url">{tunnel.url}</span><StButton variant="ghost" onClick={() => { void copyValue(tunnel.url as string, tunnel.id); }}>{copied === tunnel.id ? <Check size={13} /> : <Copy size={13} />}复制</StButton></div>}
            {open ? <div className="st-row-detail">
              <dl className="settings-kv">
                <dt>类型</dt><dd>{methodName(tunnel.method)}</dd>
                <dt>目标端口</dt><dd>跟随当前服务端口</dd>
                {tunnel.method === "sish" && tunnel.sish !== undefined ? <>
                  <dt>服务器地址</dt><dd>{tunnel.sish.server}</dd>
                  <dt>子域名</dt><dd>{tunnel.sish.subdomain ?? "随机分配"}</dd>
                  <dt>SSH 端口</dt><dd>{String(tunnel.sish.sshPort ?? 22)}</dd>
                </> : null}
                {tunnel.method === "frp" && tunnel.frp !== undefined ? <>
                  <dt>frps 服务器</dt><dd>{tunnel.frp.server}</dd>
                  <dt>远程端口</dt><dd>{tunnel.frp.remotePort === undefined ? "同本地" : String(tunnel.frp.remotePort)}</dd>
                  {tunnel.frp.domain === undefined ? null : <><dt>域名</dt><dd>{tunnel.frp.domain}</dd></>}
                </> : null}
              </dl>
              <div className="st-inline-switch"><SettingsFormSwitch label="自动启动" description="Jarvis 启动时自动打开这条穿透" checked={tunnel.enabled} onChange={(enabled) => toggleAutoStart(tunnel, enabled)} /><SaveState k={`tunnel-auto:${tunnel.id}`} /></div>
              {caddySnippet === "" ? null : <div className="tunnel-caddy">
                <div className="tunnel-caddy-head"><span>Caddyfile</span><StButton variant="ghost" onClick={() => { void copyValue(caddySnippet, `caddy-${tunnel.id}`); }}>{copied === `caddy-${tunnel.id}` ? <Check size={13} /> : <Copy size={13} />}复制</StButton></div>
                <pre>{caddySnippet}</pre>
              </div>}
              {tunnel.logs.length === 0 ? null : <TunnelLogView logs={tunnel.logs} />}
            </div> : null}
          </div>;
        })}
      </SettingsCard>}
    </SettingsSection>
    <PasswordSection auth={auth} onAuth={setAuth} />
    <TunnelEditor open={editor.open} tunnel={editor.tunnel} busy={editorBusy} onClose={() => setEditor({ open: false })} onSave={(input, id) => { void saveEditor(input, id); }} />
  </>;
}

function PasswordSection({ auth, onAuth }: { auth?: AuthStatus; onAuth: (auth: AuthStatus) => void }) {
  const toast = useSettingsToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const enabled = auth?.required === true;
  const mismatch = confirmPassword !== "" && newPassword !== confirmPassword;

  const save = async () => {
    if (newPassword === "" || newPassword !== confirmPassword) return;
    setBusy(true);
    try {
      onAuth(await api.setPassword(newPassword, enabled ? currentPassword : undefined));
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      toast.notify(enabled ? "密码已更新，其他设备需要重新登录" : "已启用访问密码");
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "密码保存失败", "error");
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      onAuth(await api.setPassword(null, currentPassword));
      setCurrentPassword("");
      setDisableOpen(false);
      toast.notify("已关闭访问密码");
    } catch (error) {
      toast.notify(error instanceof Error ? error.message : "关闭失败", "error");
    } finally {
      setBusy(false);
    }
  };
  const signOut = (allDevices: boolean) => {
    setBusy(true);
    void (allDevices ? api.logoutAll() : api.logout()).then(() => { notifyUnauthorized(); }).catch((error: unknown) => {
      toast.notify(error instanceof Error ? error.message : "退出登录失败", "error");
      setBusy(false);
    });
  };

  return <>
    <SettingsSection id="password" title="访问密码">
      {auth === undefined ? <SettingsLoading /> : <SettingsCard className="st-form-card">
        <SettingRow title={enabled ? "已启用访问密码" : "未设置密码"} description={enabled ? "其他设备需要输入密码才能访问" : "现在不用密码就能访问会话与穿透地址"}
          control={enabled ? <SettingsTag tone="ok"><Check size={11} />已启用</SettingsTag> : <SettingsTag tone="warn">未启用</SettingsTag>} />
        <form className="st-form st-form-inner" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          {enabled ? <SettingsField label="当前密码"><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></SettingsField> : null}
          <SettingsField label="新密码" warn={newPassword !== "" && newPassword.length < 8 ? `只有 ${String(newPassword.length)} 位，建议至少 8 位（仍然可以使用）` : undefined}>
            <input id="st-password-new" type="password" autoComplete="new-password" placeholder="建议至少 8 位" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </SettingsField>
          <SettingsField label="确认新密码" error={mismatch ? "两次输入的密码不一致" : undefined}><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></SettingsField>
          <div className="st-form-actions end">
            {enabled ? <StButton variant="ghost" className="danger" disabled={busy} onClick={() => setDisableOpen(true)}>关闭访问密码</StButton> : null}
            <StButton type="submit" variant="primary" disabled={busy || newPassword === "" || newPassword !== confirmPassword}><ShieldCheck size={14} />{enabled ? "修改密码" : "启用访问密码"}</StButton>
          </div>
        </form>
      </SettingsCard>}
    </SettingsSection>
    {enabled ? <SettingsSection id="devices" title="已登录设备">
      <SettingsCard>
        <SettingRow title="退出这台设备" description="这台设备需要重新输入密码" control={<StButton disabled={busy} onClick={() => signOut(false)}><LogOut size={13} />退出</StButton>} />
        <SettingRow danger title="退出所有设备" description="所有已登录的手机、浏览器都要重新输入密码" control={<StButton variant="danger" disabled={busy} onClick={() => signOut(true)}>全部退出</StButton>} />
      </SettingsCard>
    </SettingsSection> : null}
    <SettingsConfirm open={disableOpen} busy={busy} danger title="关闭访问密码？" confirmLabel="关闭" onCancel={() => setDisableOpen(false)} onConfirm={() => { void disable(); }}>
      <p>关闭后，任何能访问这个地址的人都可以读取会话、执行命令、修改文件，公网穿透地址也会直接暴露。</p>
      <SettingsField label="当前密码"><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></SettingsField>
    </SettingsConfirm>
  </>;
}

/** 添加/编辑穿透：选类型 + 服务器配置 + 自动启动开关（默认关闭）。 */
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
    setMethod(tunnel?.method ?? "cloudflared");
    setName(tunnel?.name ?? "");
    setEnabled(tunnel?.enabled ?? false);
    setSishServer(tunnel?.sish?.server ?? "");
    setSishSubdomain(tunnel?.sish?.subdomain ?? "");
    setSishSshPort(tunnel?.sish?.sshPort !== undefined ? String(tunnel.sish.sshPort) : "22");
    setFrpServer(tunnel?.frp?.server ?? "");
    setFrpToken(tunnel?.frp?.token ?? "");
    setFrpRemotePort(tunnel?.frp?.remotePort !== undefined ? String(tunnel.frp.remotePort) : "");
    setFrpDomain(tunnel?.frp?.domain ?? "");
  }, [open, tunnel]);

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
  const portWarn = (value: string) => value.trim() !== "" && portNumber(value) === undefined ? "不是有效端口（1–65535），保存时会忽略" : undefined;
  const serverMissing = (method === "sish" && sishServer.trim() === "") || (method === "frp" && frpServer.trim() === "");

  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose(); }}><DialogContent className="st-tunnel-dialog" title={tunnel === undefined ? "添加穿透" : "编辑穿透"}>
    <div className="st-form">
      <div className="st-choice-list" role="radiogroup" aria-label="穿透类型">
        {TUNNEL_METHODS.map((item) => <button type="button" role="radio" aria-checked={method === item.id} key={item.id} className={method === item.id ? "on" : undefined} onClick={() => setMethod(item.id)}>
          <b>{item.name}</b><small>{item.description}</small>
        </button>)}
      </div>
      <SettingsField label="显示名称" hint="可选"><input value={name} onChange={(event) => setName(event.target.value)} placeholder={methodName(method)} /></SettingsField>
      {method === "sish" ? <>
        <SettingsField label="服务器地址" warn={serverMissing ? "还没填服务器地址" : undefined}><input value={sishServer} onChange={(event) => setSishServer(event.target.value)} placeholder="user@host" /></SettingsField>
        <SettingsField label="子域名" hint="留空随机分配"><input value={sishSubdomain} onChange={(event) => setSishSubdomain(event.target.value)} /></SettingsField>
        <SettingsField label="SSH 端口" hint="默认 22" warn={portWarn(sishSshPort)}><input inputMode="numeric" value={sishSshPort} onChange={(event) => setSishSshPort(event.target.value)} /></SettingsField>
      </> : null}
      {method === "frp" ? <>
        <SettingsField label="frps 服务器" warn={serverMissing ? "还没填服务器地址" : undefined}><input value={frpServer} onChange={(event) => setFrpServer(event.target.value)} placeholder="host:port" /></SettingsField>
        <SettingsField label="token"><input type="password" value={frpToken} onChange={(event) => setFrpToken(event.target.value)} /></SettingsField>
        <SettingsField label="远程端口" hint="留空和本地相同" warn={portWarn(frpRemotePort)}><input inputMode="numeric" value={frpRemotePort} onChange={(event) => setFrpRemotePort(event.target.value)} /></SettingsField>
        <SettingsField label="域名" hint="可选，填了会生成 Caddyfile 片段"><input value={frpDomain} onChange={(event) => setFrpDomain(event.target.value)} /></SettingsField>
      </> : null}
      <SettingsFormSwitch label="自动启动" description="Jarvis 启动时自动打开这条穿透" checked={enabled} onChange={setEnabled} />
      <div className="dialog-actions">
        <StButton onClick={onClose}>取消</StButton>
        <StButton variant="primary" disabled={busy} onClick={() => onSave(buildInput(), tunnel?.id)}><Check size={14} />{busy ? "保存中…" : tunnel === undefined ? "添加" : "保存"}</StButton>
      </div>
    </div>
  </DialogContent></Dialog>;
}

/** 隧道日志：按条目独立滚动；仅当用户本来就在底部时才自动跟随新日志。 */
function TunnelLogView({ logs }: { logs: TunnelLogEntry[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const onScroll = () => {
    const element = ref.current;
    if (element === null) return;
    stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };
  useEffect(() => {
    const element = ref.current;
    if (element === null || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [logs]);
  return <div className="tunnel-logs" ref={ref} onScroll={onScroll}>
    {logs.map((entry, index) => <div key={`${entry.t}-${index}`}>{entry.line}</div>)}
  </div>;
}
