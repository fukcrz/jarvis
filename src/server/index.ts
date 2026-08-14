import { buildApp } from "./app.js";

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

await app.listen({ port, host });
const address = app.server.address();
const actualPort = typeof address === "object" && address !== null && typeof address.port === "number" ? address.port : port;
// 设置目标端口；若开启了自动穿透，这里会直接拉起隧道。
await app.jarvis.tunnel.initialize(actualPort);
