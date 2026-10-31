import { useEffect, useState } from "react";
import { formatRunElapsed } from "../run-feedback";

/** 计时器单独成一个小组件：每秒钟只重渲染这一个节点。 */
export function ElapsedClock({ startedAt, className = "run-elapsed" }: { startedAt?: string; className?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const elapsed = formatRunElapsed(startedAt, now);
  if (elapsed === undefined) return null;
  return <time className={className}>{elapsed}</time>;
}
