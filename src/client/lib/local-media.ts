import { createContext } from "react";

/** 仅在打开会话、刷新或 run 结算时变化；memo 消息中的图片也订阅此上下文。 */
export const LocalMediaVersionContext = createContext<string | undefined>(undefined);

/** 本地文件引用读取当前文件；远程链接、内嵌图片和会话附件快照不参与刷新。 */
export function localMediaUrl(src: string, version: string | undefined): string {
  if (version === undefined || !src.startsWith("/api/files?")) return src;
  const url = new URL(src, "http://jarvis.local");
  url.searchParams.set("v", version);
  return `${url.pathname}${url.search}${url.hash}`;
}
