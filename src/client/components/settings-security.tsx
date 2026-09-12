import { useEffect, useState, type FormEvent } from "react";
import { Check, LogOut, ShieldCheck } from "lucide-react";
import type { AuthStatus } from "../../shared/protocol";
import { api, notifyUnauthorized } from "../api";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";

type SettingsMessageTone = "success" | "error";

/** 安全子页内容：访问密码、登录设备与认证关闭确认。 */
export function SecurityPanel({ onMessage }: { onMessage: (message: string, tone?: SettingsMessageTone) => void }) {
  const [status, setStatus] = useState<AuthStatus | undefined>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const enabled = status?.required === true;

  useEffect(() => {
    let disposed = false;
    void api.authStatus().then(({ auth }) => { if (!disposed) setStatus(auth); })
      .catch((error: unknown) => { if (!disposed) onMessage(error instanceof Error ? error.message : "无法读取认证状态", "error"); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [onMessage]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (newPassword.length < 8) {
      onMessage("密码至少 8 位", "error");
      return;
    }
    if (newPassword !== confirmPassword) {
      onMessage("两次输入的密码不一致", "error");
      return;
    }
    setBusy(true);
    try {
      setStatus(await api.setPassword(newPassword, enabled ? currentPassword : undefined));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onMessage(enabled ? "密码已更新，其他设备需要重新登录" : "已启用登录认证");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "密码保存失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setDisableOpen(false);
    if (currentPassword === "") {
      onMessage("请先填写当前密码", "error");
      return;
    }
    setBusy(true);
    try {
      setStatus(await api.setPassword(null, currentPassword));
      setCurrentPassword("");
      onMessage("已关闭登录认证");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "关闭认证失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const signOut = (allDevices: boolean) => {
    if (busy) return;
    setBusy(true);
    const request = allDevices ? api.logoutAll() : api.logout();
    void request.catch((error: unknown) => { onMessage(error instanceof Error ? error.message : "退出登录失败", "error"); })
      .finally(() => { notifyUnauthorized(); });
  };

  return <section className="settings-section">
    {loading ? <p className="settings-page-note">正在读取认证状态…</p> : <>
      <div className="security-status">
        <span className={`provider-chip ${enabled ? "ready" : "unset"}`}>{enabled ? <><Check size={12} />已启用登录认证</> : "未设置密码"}</span>
        <small>{enabled ? null : "当前无需密码即可访问会话与穿透地址。"}</small>
      </div>
      <form className="security-form" onSubmit={(event) => { void save(event); }}>
        {enabled ? <label className="settings-field"><span>当前密码</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label> : null}
        <label className="settings-field"><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} placeholder="至少 8 位" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label className="settings-field"><span>确认新密码</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        <div className="security-actions">
          <Button type="submit" disabled={busy || newPassword === ""}><ShieldCheck size={15} />{enabled ? "修改密码" : "启用登录认证"}</Button>
          {enabled ? <Button type="button" variant="danger" disabled={busy} onClick={() => setDisableOpen(true)}>关闭认证</Button> : null}
        </div>
      </form>
      {enabled ? <div className="security-actions">
        <Button variant="secondary" disabled={busy} onClick={() => signOut(false)}><LogOut size={15} />退出登录</Button>
        <Button variant="ghost" disabled={busy} onClick={() => signOut(true)}>退出所有设备</Button>
      </div> : null}
    </>}
    <Dialog open={disableOpen} onOpenChange={(open) => { if (!open && !busy) setDisableOpen(false); }}><DialogContent title="关闭登录认证"><p className="delete-session-message">关闭后，任何能访问该地址的人都可以读取会话、执行命令与修改文件，公网穿透地址也会直接暴露。</p><div className="dialog-actions"><Button variant="secondary" onClick={() => setDisableOpen(false)} disabled={busy}>取消</Button><Button variant="danger" onClick={() => { void disable(); }} disabled={busy}>关闭认证</Button></div></DialogContent></Dialog>
  </section>;
}
