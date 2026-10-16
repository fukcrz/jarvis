import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listRecoveryNotices } from "./fs.js";
import { TRASH_RETENTION_DAYS, type TrashService } from "./trash.js";

export interface SystemRouteDeps {
  trash: TrashService;
}

/** 数据安全相关接口：回收站、配置恢复记录。 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemRouteDeps): void {
  const { trash } = deps;
  const idParams = z.object({ id: z.string().min(1).max(200) });

  app.get("/api/system/recoveries", async () => ({ recoveries: listRecoveryNotices() }));

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
