import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildDiagnosticsZip } from "./diagnostics.js";
import { listRecoveryNotices, listStartupWarnings } from "./fs.js";
import type { RecentLogs } from "./recent-logs.js";
import { SNAPSHOT_KEEP, type DailySnapshots } from "./snapshot.js";

export interface SystemRouteDeps {
  snapshots?: DailySnapshots;
  recentLogs?: RecentLogs;
  runningCount?: () => number;
}

/** 网页端上报：未捕获异常、接口失败、点击未生效。落到最近日志，导出诊断包时一起带走。 */
const clientLogInput = z.object({
  kind: z.string().min(1).max(64),
  message: z.string().min(1).max(4_000),
  detail: z.string().max(8_000).optional(),
}).strict();

/** 数据安全相关接口：配置恢复记录、每日快照、诊断包。 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): void {
  app.get("/api/system/recoveries", async () => ({ recoveries: listRecoveryNotices() }));
  app.get("/api/system/info", async () => ({
    ...(deps.snapshots === undefined ? {} : { snapshotDirectory: deps.snapshots.path, snapshotKeep: SNAPSHOT_KEEP, snapshots: await deps.snapshots.list() }),
    warnings: listStartupWarnings(),
  }));
  app.post("/api/system/client-log", async (request) => {
    const body = clientLogInput.parse(request.body);
    deps.recentLogs?.push(clientLogLine(body));
    return { ok: true };
  });
  app.get("/api/system/diagnostics", async (_request, reply) => {
    const { fileName, data } = await buildDiagnosticsZip({
      ...(deps.recentLogs === undefined ? {} : { recentLogs: () => deps.recentLogs?.text() ?? "" }),
      extra: () => ({ runningSessions: deps.runningCount?.() }),
    });
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .header("cache-control", "no-store")
      .send(data);
  });
}

export function clientLogLine(body: { kind: string; message: string; detail?: string }): string {
  return `[client] ${body.kind}: ${body.message}${body.detail === undefined || body.detail === "" ? "" : ` | ${body.detail}`}`;
}
