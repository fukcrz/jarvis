import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGroupsConfig } from "../shared/plugins.js";
import { ModelGroupsService } from "./model-groups-service.js";

const validConfig: ModelGroupsConfig = {
  version: 1,
  retry: { groupRetryDelayMs: 180_000 },
  compaction: { thresholdTokens: 230_000, reserveTokens: 32_768 },
  groups: {
    balanced: {
      name: "Balanced",
      contextWindow: 128_000,
      maxTokens: 8_192,
      reasoning: true,
      input: ["text", "image"],
      routes: [{ provider: "openai", model: "gpt-4.1", recommendedConcurrency: 2 }],
    },
  },
};

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("ModelGroupsService", () => {
  it("returns an empty editable snapshot when the config file is missing", async () => {
    const root = await createRoot();
    const service = new ModelGroupsService(join(root, "agent"));

    const snapshot = await service.snapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.exists).toBe(false);
    expect(snapshot.config).toEqual({ version: 1, groups: {} });
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists valid config and reloads through the supplied hook", async () => {
    const root = await createRoot();
    const reload = vi.fn(async () => 0);
    const service = new ModelGroupsService(join(root, "agent"), () => true, { reload });

    const saved = await service.save(validConfig);

    expect(reload).toHaveBeenCalledOnce();
    expect(saved.exists).toBe(true);
    expect(saved.config).toEqual(validConfig);
    expect(JSON.parse(await readFile(join(root, "agent", "model-groups.json"), "utf8"))).toEqual(validConfig);
  });

  it("rejects invalid numeric values before writing", async () => {
    const root = await createRoot();
    const service = new ModelGroupsService(join(root, "agent"));
    const invalid = { ...validConfig, groups: { balanced: { ...validConfig.groups.balanced, maxTokens: 0 } } };

    await expect(service.save(invalid)).rejects.toMatchObject({ code: "MODEL_GROUPS_INVALID" });
    await expect(readFile(join(root, "agent", "model-groups.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale revision without overwriting newer config", async () => {
    const root = await createRoot();
    const service = new ModelGroupsService(join(root, "agent"));
    const initial = await service.snapshot();
    await service.save(validConfig, initial.revision);
    const changed = { ...validConfig, groups: { changed: { ...validConfig.groups.balanced, name: "Changed" } } };

    await expect(service.save(changed, initial.revision)).rejects.toMatchObject({ code: "MODEL_GROUPS_CONFLICT" });
    expect((await service.snapshot()).config.groups.balanced?.name).toBe("Balanced");
  });

  it("restores the previous file when reload fails", async () => {
    const root = await createRoot();
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "model-groups.json"), `${JSON.stringify(validConfig)}\n`, "utf8");
    let attempts = 0;
    const reload = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("reload failed");
      return 0;
    });
    const service = new ModelGroupsService(agentDir, () => true, { reload });

    await expect(service.save({ ...validConfig, groups: {} })).rejects.toMatchObject({ code: "MODEL_GROUPS_RELOAD_FAILED" });
    expect(JSON.parse(await readFile(join(agentDir, "model-groups.json"), "utf8"))).toEqual(validConfig);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-model-groups-"));
  roots.push(root);
  return root;
}
