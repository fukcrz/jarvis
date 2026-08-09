import { buildApp } from "./app.js";

const app = await buildApp({ serveStatic: process.env["NODE_ENV"] === "production" });
const port = Number(process.env["PORT"] ?? 4310);

const close = async (signal: string) => {
  app.log.info({ signal }, "Shutting down Jarvis");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => { void close("SIGINT"); });
process.on("SIGTERM", () => { void close("SIGTERM"); });

await app.listen({ port, host: "127.0.0.1" });
