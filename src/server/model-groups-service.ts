import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelGroup, ModelGroupsConfig, ModelGroupsSnapshot } from "../shared/plugins.js";
import { AppError, asMessage } from "./errors.js";
import { atomicWrite, isMissingFile } from "./fs.js";
import { isRecord } from "../shared/protocol.js";
import { z } from "zod";

export const MODEL_GROUPS_PLUGIN_ID = "model-groups-router";

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const routeSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  recommendedConcurrency: positiveInteger.optional(),
}).passthrough();

const groupSchema = z.object({
  name: z.string().min(1),
  contextWindow: positiveInteger,
  maxTokens: positiveInteger,
  reasoning: z.boolean(),
  input: z.array(z.enum(["text", "image"])),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  routes: z.array(routeSchema).min(1),
}).passthrough();

const configSchema = z.object({
  version: z.number().int().nonnegative().optional(),
  retry: z.object({ groupRetryDelayMs: nonNegativeInteger.optional() }).passthrough().optional(),
  compaction: z.object({ thresholdTokens: nonNegativeInteger.optional(), reserveTokens: nonNegativeInteger.optional() }).passthrough().optional(),
  groups: z.record(z.string(), groupSchema),
}).passthrough();

const defaultConfig: ModelGroupsConfig = { version: 1, groups: {} };

type ReloadHooks = {
  assertReady?: () => void;
  reload?: () => Promise<number>;
  withReload?: <T>(operation: (reload: () => Promise<number>) => Promise<T>) => Promise<T>;
};

export class ModelGroupsService {
  private readonly configPath: string;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly agentDir = getAgentDir(),
    private readonly isEnabled: () => boolean = () => true,
    private readonly reloadHooks: ReloadHooks = {},
  ) {
    this.configPath = join(this.agentDir, "model-groups.json");
  }

  async snapshot(): Promise<ModelGroupsSnapshot> {
    const enabled = this.isEnabled();
    const loaded = await this.readConfig();
    return {
      enabled,
      path: this.configPath,
      exists: loaded.exists,
      revision: loaded.revision,
      config: loaded.config,
      ...(loaded.error === undefined ? {} : { error: loaded.error }),
    };
  }

  async save(input: unknown, expectedRevision?: string): Promise<ModelGroupsSnapshot> {
    const config = parseConfig(input);
    const previous = this.saveChain;
    let release!: () => void;
    this.saveChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const operation = async (reload: () => Promise<number>): Promise<ModelGroupsSnapshot> => {
        if (!this.isEnabled()) throw new AppError("PLUGIN_DISABLED", "模型组插件未启用", 409);
        const current = await this.readConfig();
        if (expectedRevision !== undefined && expectedRevision !== current.revision) {
          throw new AppError("MODEL_GROUPS_CONFLICT", "模型组配置已被其他页面修改，请重新读取后再保存", 409);
        }
        if (this.reloadHooks.withReload === undefined) this.reloadHooks.assertReady?.();
        await mkdir(dirname(this.configPath), { recursive: true });
        const previousRaw = current.raw;
        await atomicWrite(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
        try {
          await reload();
        } catch (error) {
          if (previousRaw === undefined) await rm(this.configPath, { force: true });
          else await atomicWrite(this.configPath, previousRaw);
          try {
            await reload();
          } catch (rollbackError) {
            throw new AppError("MODEL_GROUPS_RELOAD_FAILED", `模型组恢复失败：${asMessage(rollbackError)}`, 409);
          }
          throw error instanceof AppError ? error : new AppError("MODEL_GROUPS_RELOAD_FAILED", `模型组重新加载失败：${asMessage(error)}`, 409);
        }
        return this.snapshot();
      };
      const reload = this.reloadHooks.reload ?? (async () => 0);
      return this.reloadHooks.withReload === undefined
        ? operation(reload)
        : this.reloadHooks.withReload(operation);
    } finally {
      release();
    }
  }

  private async readConfig(): Promise<{ exists: boolean; raw?: string; config: ModelGroupsConfig; revision: string; error?: string }> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { exists: false, config: cloneDefaultConfig(), revision: revisionOf(undefined) };
      throw error;
    }
    try {
      return { exists: true, raw, config: parseConfig(JSON.parse(raw)), revision: revisionOf(raw) };
    } catch (error) {
      return { exists: true, raw, config: cloneDefaultConfig(), revision: revisionOf(raw), error: asMessage(error) };
    }
  }
}

function parseConfig(input: unknown): ModelGroupsConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("MODEL_GROUPS_INVALID", issue === undefined ? "模型组配置无效" : `模型组配置无效：${issue.message}`);
  }
  const value = parsed.data as ModelGroupsConfig;
  return { ...value, version: value.version ?? 1, groups: value.groups as Record<string, ModelGroup> };
}

function cloneDefaultConfig(): ModelGroupsConfig {
  return { version: defaultConfig.version, groups: {} };
}

function revisionOf(raw: string | undefined): string {
  return createHash("sha256").update(raw ?? "<missing>", "utf8").digest("hex");
}

export function isModelGroupsConfig(value: unknown): value is ModelGroupsConfig {
  return isRecord(value) && configSchema.safeParse(value).success;
}
