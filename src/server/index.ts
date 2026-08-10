import { buildApp } from "./app.js";

const production = process.env["NODE_ENV"] === "production";
const app = await buildApp({ serveStatic: production });
const port = Number(process.env["PORT"] ?? 39126);
const host = production ? "127.0.0.1" : "0.0.0.0";

const close = async (signal: string) => {
  app.log.info({ signal }, "Shutting down Jarvis");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => { void close("SIGINT"); });
process.on("SIGTERM", () => { void close("SIGTERM"); });

await app.listen({ port, host });
