import type { FastifyReply, FastifyRequest } from "fastify";
import { AUTH_COOKIE_NAME, AuthService, SESSION_TTL_MS } from "./auth-service.js";

export function readAuthCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== AUTH_COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

/** 下发/续期会话 Cookie；仅当连接本身是 HTTPS 时加 Secure（frp tcp 与局域网都是 HTTP）。 */
export function applyAuthCookie(reply: FastifyReply, token: string, request: FastifyRequest): void {
  const secure = request.protocol === "https" ? "; Secure" : "";
  reply.header("set-cookie", `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(SESSION_TTL_MS / 1_000)}${secure}`);
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.header("set-cookie", `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

interface CloseableSocket { close(code?: number, reason?: string): void }

/** WebSocket 握手鉴权：返回连接所用 token，失败用 4401 关闭。 */
export function authorizeSocket(auth: AuthService, request: FastifyRequest, socket: CloseableSocket): { token?: string } | undefined {
  const token = readAuthCookie(request.headers.cookie);
  if (auth.status(token).authenticated) return token === undefined ? {} : { token };
  socket.close(4401, "Unauthorized");
  return undefined;
}
