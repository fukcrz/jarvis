import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { Button } from "./ui/button";

interface LoginPageProps {
  assistantName: string;
  onAuthenticated: () => void;
}

/** 登录页：仅当服务端设置了密码时出现（未设置密码时 AuthGate 直接渲染应用）。 */
export function LoginPage({ assistantName, onAuthenticated }: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password === "" || pending) return;
    setPending(true);
    setError(undefined);
    void api.login(password).then((status) => {
      setPassword("");
      if (status.authenticated) onAuthenticated();
      else setError("登录失败，请重试");
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "登录失败，请重试");
    }).finally(() => { setPending(false); });
  };

  return <main className="login-page">
    <form className="login-card" onSubmit={submit}>
      <span className="login-mark"><ShieldCheck size={22} /></span>
      <div className="login-heading">
        <h1>{assistantName}</h1>
        <p>请输入访问密码继续</p>
      </div>
      <label className="login-field">
        <span>密码</span>
        <input
          autoFocus
          type="password"
          autoComplete="current-password"
          placeholder="访问密码"
          value={password}
          onChange={(event) => { setPassword(event.target.value); setError(undefined); }}
        />
      </label>
      {error === undefined ? null : <p className="login-error" role="alert">{error}</p>}
      <Button type="submit" className="login-submit" disabled={pending || password === ""}>
        {pending ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
        {pending ? "正在登录…" : "登录"}
      </Button>
      <p className="login-hint">登录状态保持 7 天，使用期间自动续期。</p>
    </form>
  </main>;
}
