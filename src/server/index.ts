import { buildApp } from "./app.js";

const production = process.env["NODE_ENV"] === "production";
const app = await buildApp({ serveStatic: production });
// Development defaults to a fixed port (39130) so it never collides with the
// production default (39126). Override either with PORT.
const defaultPort = production ? 39126 : 39130;
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
