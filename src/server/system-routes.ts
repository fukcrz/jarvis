import type { FastifyInstance } from "fastify";
import { buildDiagnosticsZip } from "./diagnostics.js";
import { listRecoveryNotices, listStartupWarnings } from "./fs.js";
import type { RecentLogs } from "./recent-logs.js";
import { SNAPSHOT_KEEP, type DailySnapshots } from "./snapshot.js";

export interface SystemRouteDeps {
  snapshots?: DailySnapshots;
  recentLogs?: RecentLogs;
  runningCount?: () => number;
}

/** 数据安全相关接口：配置恢复记录、每日快照、诊断包。 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): void {
  app.get("/api/system/recoveries", async () => ({ recoveries: listRecoveryNotices() }));
  app.get("/api/system/info", async () => ({
    ...(deps.snapshots === undefined ? {} : { snapshotDirectory: deps.snapshots.path, snapshotKeep: SNAPSHOT_KEEP, snapshots: await deps.snapshots.list() }),
    warnings: listStartupWarnings(),
  }));
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
