import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { RecentLogs } from "./recent-logs.js";
import { clientLogLine, registerSystemRoutes } from "./system-routes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.map(async (app) => app.close()));
  apps.length = 0;
});

function createApp(recentLogs?: RecentLogs): FastifyInstance {
  const app = Fastify();
  registerSystemRoutes(app, recentLogs === undefined ? {} : { recentLogs });
  apps.push(app);
  return app;
}

describe("POST /api/system/client-log", () => {
  it("appends the report to the recent logs", async () => {
    const recentLogs = new RecentLogs();
    const response = await createApp(recentLogs).inject({
      method: "POST",
      url: "/api/system/client-log",
      payload: { kind: "session-select", message: "点击会话后未选中", detail: "target=w:s listed=3 inList=是" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(recentLogs.text()).toBe("[client] session-select: 点击会话后未选中 | target=w:s listed=3 inList=是\n");
  });

  it("accepts a report without a detail and without recent logs", async () => {
    const response = await createApp().inject({ method: "POST", url: "/api/system/client-log", payload: { kind: "window-error", message: "boom" } });
    expect(response.statusCode).toBe(200);
  });
});

describe("clientLogLine", () => {
  it("skips an empty detail", () => {
    expect(clientLogLine({ kind: "window-error", message: "boom" })).toBe("[client] window-error: boom");
    expect(clientLogLine({ kind: "window-error", message: "boom", detail: "" })).toBe("[client] window-error: boom");
  });
});
