import { useEffect, useState, type ReactNode } from "react";
import { UNAUTHORIZED_EVENT, api } from "../api";
import { LoginPage } from "./login-page";

/**
 * 登录门禁：未认证时不挂载应用（避免带出 401 请求与 WebSocket 连接），
 * 认证失效（HTTP 401 / WebSocket 4401）时通过 UNAUTHORIZED_EVENT 切回登录页。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [assistantName, setAssistantName] = useState("Jarvis");

  useEffect(() => {
    let disposed = false;
    void api.authStatus().then(({ auth, assistantName: name }) => {
      if (disposed) return;
      setAssistantName(name);
      setState(auth.authenticated ? "signed-in" : "signed-out");
    }).catch(() => {
      // 状态接口不可用（例如旧版本服务）时不阻塞进入应用。
      if (!disposed) setState("signed-in");
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => { setState("signed-out"); };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => { window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized); };
  }, []);

  if (state === "checking") return <main className="app-loading">正在检查登录状态…</main>;
  if (state === "signed-out") return <LoginPage assistantName={assistantName} onAuthenticated={() => { setState("signed-in"); }} />;
  return <>{children}</>;
}
