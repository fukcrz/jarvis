import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { UNAUTHORIZED_EVENT, api } from "../api";
import { LoginPage } from "./login-page";

/** 未认证时不挂载应用；认证连接失效后核对最新 Cookie 并重新订阅。 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [assistantName, setAssistantName] = useState("Jarvis");
  const [connectionGeneration, setConnectionGeneration] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let disposed = false;
    let checking = false;
    let generation = 0;
    const check = (initial = false) => {
      if (!initial && checking) return;
      checking = true;
      const requestGeneration = ++generation;
      // 卸载应用清理旧连接；改密后的新 Cookie 可直接恢复。
      if (!initial) setState("checking");
      void api.authStatus().then(({ auth, assistantName: name }) => {
        if (disposed || requestGeneration !== generation) return;
        setAssistantName(name);
        if (!initial && auth.authenticated) setConnectionGeneration((current) => current + 1);
        setState(auth.authenticated ? "signed-in" : "signed-out");
      }).catch(() => {
        if (disposed || requestGeneration !== generation) return;
        // 初次状态接口不可用时保留原有进入行为，失效连接则回到登录。
        setState(initial ? "signed-in" : "signed-out");
      }).finally(() => { if (requestGeneration === generation) checking = false; });
    };
    const onUnauthorized = () => { check(); };
    const onVisible = () => { if (!document.hidden && stateRef.current === "signed-out") check(); };
    const onOnline = () => { if (stateRef.current === "signed-out") check(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) onVisible(); };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    check(true);
    return () => {
      disposed = true;
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  if (state === "checking") return <main className="app-loading">正在检查登录状态…</main>;
  if (state === "signed-out") return <LoginPage assistantName={assistantName} onAuthenticated={() => { setState("signed-in"); }} />;
  return <Fragment key={connectionGeneration}>{children}</Fragment>;
}
