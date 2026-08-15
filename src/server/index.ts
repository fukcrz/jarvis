import { buildApp } from "./app.js";
import type { FastifyInstance } from "fastify";

const production = process.env["NODE_ENV"] === "production";
const app = await buildApp({ serveStatic: production });

// Extension code can leave async continuations (streams, timers, compaction
// callbacks) running after a session is disposed. A stale extension ctx throws
// inside those unawaited callbacks, and Node's default behavior would take the
// whole server down. Log instead and keep serving: Jarvis's state lives on
// disk, not in this process.
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection; keeping the server alive");
});
process.on("uncaughtException", (error) => {
  app.log.error({ err: error }, "Uncaught exception; keeping the server alive");
});

// Development defaults to a fixed port (39130) so it never collides with the
// production default (9528). Override either with PORT.
const defaultPort = production ? 9528 : 39130;
const port = Number(process.env["PORT"] ?? defaultPort);
// Listen on all interfaces (LAN access) in every mode. Override with HOST if needed.
const host = process.env["HOST"] ?? "0.0.0.0";

const close = async (signal: string) => {
  app.log.info({ signal }, "Shutting down Jarvis");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => { void close("SIGINT"); });
process.on("SIGTERM", () => { void close("SIGTERM"); });

await listenWithRetry(app, port, host, process.env["JARVIS_SELF_RESTART"] === "1");
const address = app.server.address();
const actualPort = typeof address === "object" && address !== null && typeof address.port === "number" ? address.port : port;
// 设置目标端口；若开启了自动穿透，这里会直接拉起隧道。
await app.jarvis.tunnel.initialize(actualPort);

/**
 * 自重启（JARVIS_SELF_RESTART=1）时新进程可能与旧进程短暂争抢端口：
 * 遇 EADDRINUSE 轮询重试，等旧进程释放后接管；普通启动不做重试，端口被占直接报错。
 */
async function listenWithRetry(app: FastifyInstance, port: number, host: string, retryOnEaddrinuse: boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await app.listen({ port, host });
      return;
    } catch (error) {
      if (!retryOnEaddrinuse || !isEaddrinuse(error) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function isEaddrinuse(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown })["code"] === "EADDRINUSE";
}
