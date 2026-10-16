import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildDiagnosticsZip } from "./diagnostics.js";
import { listRecoveryNotices, listStartupWarnings } from "./fs.js";
import { defaultLogDirectory, LOG_RETENTION_DAYS } from "./log-files.js";
import { TRASH_RETENTION_DAYS, type TrashService } from "./trash.js";
import { SNAPSHOT_KEEP, type DailySnapshots } from "./snapshot.js";

export interface SystemRouteDeps {
  trash: TrashService;
  snapshots?: DailySnapshots;
  logDirectory?: string;
  runningCount?: () => number;
}

/** 数据安全相关接口：回收站、配置恢复记录、日志与诊断包。 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): void {
  const { trash } = deps;
  const idParams = z.object({ id: z.string().min(1).max(200) });

  app.get("/api/system/recoveries", async () => ({ recoveries: listRecoveryNotices() }));
  app.get("/api/system/info", async () => ({
    logDirectory: deps.logDirectory ?? defaultLogDirectory(),
    logRetentionDays: LOG_RETENTION_DAYS,
    ...(deps.snapshots === undefined ? {} : { snapshotDirectory: deps.snapshots.path, snapshotKeep: SNAPSHOT_KEEP, snapshots: await deps.snapshots.list() }),
    warnings: listStartupWarnings(),
  }));
  app.get("/api/system/diagnostics", async (_request, reply) => {
    const { fileName, data } = await buildDiagnosticsZip({
      ...(deps.logDirectory === undefined ? {} : { logDirectory: deps.logDirectory }),
      extra: () => ({ runningSessions: deps.runningCount?.() }),
    });
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${fileName}"`)
      .header("cache-control", "no-store")
      .send(data);
  });

  app.get("/api/trash", async () => ({ entries: await trash.list(), retentionDays: TRASH_RETENTION_DAYS, directory: trash.directory }));
  app.post("/api/trash/:id/restore", async (request) => {
    const { id } = idParams.parse(request.params);
    return trash.restore(id);
  });
  app.delete("/api/trash/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    await trash.remove(id);
    return { removed: true };
  });
}
