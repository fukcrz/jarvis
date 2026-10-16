import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager, type PackageManager } from "@earendil-works/pi-coding-agent";
import type { BundledPluginLifecycle, InstalledPluginStatus, PluginCatalogItem, PluginSnapshot, RecommendedPluginStatus } from "../shared/plugins.js";
import { AppError, asMessage } from "./errors.js";
import { atomicWrite, isMissingFile, readJsonRecovering, writeWithBackup } from "./fs.js";
import { BUNDLED_PLUGINS, readPluginText, reconcileBundledPlugins } from "./plugin-reconcile.js";
import { catalogUrl, normalizeInstallSource, packageNameFromSource } from "./plugin-source.js";
import { isRecord } from "../shared/protocol.js";
import { jarvisHome } from "./jarvis-home.js";

export const RECOMMENDED_PACKAGES: readonly { name: string; source: string }[] = [
  { name: "pi-web-access", source: "npm:pi-web-access" },
  { name: "@juicesharp/rpiv-ask-user-question", source: "npm:@juicesharp/rpiv-ask-user-question" },
  { name: "@mjakl/pi-subagent", source: "npm:@mjakl/pi-subagent" },
  { name: "pi-playwright", source: "npm:pi-playwright" },
];

interface PluginPrefs { version: 1; disabledBundled: string[]; disabledRecommended: string[]; }

const SEARCH_URL = "https://registry.npmjs.org/-/v1/search";

export function bundledPluginRoot(): string {
  return join(process.cwd(), "plugins", "bundled");
}

function manifestPath(): string {
  return join(process.cwd(), "plugins", "manifest.json");
}

export class PluginService {
  private readonly prefsPath: string;
  private prefs: PluginPrefs = { version: 1, disabledBundled: [], disabledRecommended: [] };
  private knownHashes: Record<string, string[]> = {};
  private retiredHashes: Record<string, string[]> = {};
  private bundledMutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly agentDir = getAgentDir(),
    prefsPath = join(jarvisHome(), "plugin-prefs.json"),
    private readonly packages: PackageManager = createPackageManager(agentDir),
    private readonly log: (message: string) => void = (message) => console.warn(message),
    private readonly lifecycle: BundledPluginLifecycle = {},
  ) {
    this.prefsPath = prefsPath;
  }

  async initialize(): Promise<void> {
    const manifest = await readManifest();
    this.knownHashes = manifest.plugins;
    this.retiredHashes = manifest.retired;
    await this.loadPrefs();
    await this.reconcileBundled();
  }

  async snapshot(): Promise<PluginSnapshot> {
    const installed = await this.listInstalled();
    const installedNames = new Set(installed.flatMap((item) => packageNameFromSource(item.source) === undefined ? [] : [packageNameFromSource(item.source) as string]));
    const bundled = await this.reconcileBundled();
    const recommended: RecommendedPluginStatus[] = RECOMMENDED_PACKAGES.map((item) => ({
      name: item.name,
      source: installed.find((entry) => packageNameFromSource(entry.source) === item.name)?.source ?? item.source,
      enabled: !this.prefs.disabledRecommended.includes(item.name),
      installed: installedNames.has(item.name),
    }));
    return { bundled, recommended, installed };
  }

  isBundledEnabled(id: string): boolean {
    assertBundledId(id);
    return !this.prefs.disabledBundled.includes(id);
  }

  async setBundledEnabled(id: string, enabled: boolean): Promise<PluginSnapshot> {
    assertBundledId(id);
    const wasEnabled = !this.prefs.disabledBundled.includes(id);
    if (wasEnabled === enabled) return this.snapshot();
    return this.applyBundledMutation(id, () => {
      this.prefs.disabledBundled = enabled
        ? this.prefs.disabledBundled.filter((item) => item !== id)
        : [...new Set([...this.prefs.disabledBundled, id])];
    });
  }

  async overwriteBundled(id: string): Promise<PluginSnapshot> {
    assertBundledId(id);
    return this.applyBundledMutation(id, () => {
      this.prefs.disabledBundled = this.prefs.disabledBundled.filter((item) => item !== id);
    }, new Set([id]));
  }

  async setRecommendedEnabled(name: string, enabled: boolean): Promise<PluginSnapshot> {
    const recommended = RECOMMENDED_PACKAGES.find((item) => item.name === name);
    if (recommended === undefined) throw new AppError("PLUGIN_NOT_FOUND", "插件不存在", 404);
    if (enabled) {
      this.prefs.disabledRecommended = this.prefs.disabledRecommended.filter((item) => item !== name);
      await this.persistPrefs();
      const installed = await this.listInstalled();
      if (!installed.some((item) => packageNameFromSource(item.source) === name)) await this.packages.installAndPersist(recommended.source);
    } else {
      this.prefs.disabledRecommended = [...new Set([...this.prefs.disabledRecommended, name])];
      await this.persistPrefs();
      await this.removeByName(name);
    }
    return this.snapshot();
  }

  async search(query: string): Promise<PluginCatalogItem[]> {
    const text = query.trim() === "" ? "keywords:pi-package" : `keywords:pi-package ${query.trim()}`;
    const url = new URL(SEARCH_URL);
    url.searchParams.set("text", text);
    url.searchParams.set("size", "20");
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AppError("PLUGIN_SEARCH_FAILED", "插件搜索失败", 502);
    const body: unknown = await response.json();
    const objects = isRecord(body) && Array.isArray(body["objects"]) ? body["objects"] : [];
    const installed = new Set((await this.listInstalled()).flatMap((item) => {
      const name = packageNameFromSource(item.source);
      return name === undefined ? [] : [name];
    }));
    return objects.flatMap((entry) => {
      if (!isRecord(entry) || !isRecord(entry["package"])) return [];
      const item = entry["package"];
      const name = typeof item["name"] === "string" ? item["name"] : "";
      const version = typeof item["version"] === "string" ? item["version"] : "";
      const keywords = Array.isArray(item["keywords"]) ? item["keywords"] : [];
      if (name === "" || version === "" || !keywords.includes("pi-package")) return [];
      const links = isRecord(item["links"]) ? item["links"] : {};
      const repository = typeof links["repository"] === "string" ? links["repository"] : undefined;
      const homepage = typeof links["homepage"] === "string" ? links["homepage"] : undefined;
      const npmUrl = typeof links["npm"] === "string" ? links["npm"] : `https://www.npmjs.com/package/${name}`;
      return [{
        name,
        version,
        description: typeof item["description"] === "string" ? item["description"] : "",
        source: `npm:${name}`,
        installed: installed.has(name),
        url: catalogUrl(repository, homepage, npmUrl),
      }];
    });
  }

  async install(source: string): Promise<PluginSnapshot> {
    const normalized = normalizeInstallSource(source);
    await this.packages.installAndPersist(normalized);
    const name = packageNameFromSource(normalized);
    if (name !== undefined && RECOMMENDED_PACKAGES.some((item) => item.name === name)) {
      this.prefs.disabledRecommended = this.prefs.disabledRecommended.filter((item) => item !== name);
      await this.persistPrefs();
    }
    return this.snapshot();
  }

  async remove(source: string): Promise<PluginSnapshot> {
    const normalized = normalizeInstallSource(source);
    await this.removeSource(normalized);
    return this.snapshot();
  }

  async update(source: string): Promise<PluginSnapshot> {
    const normalized = normalizeInstallSource(source);
    await this.packages.update(normalized);
    return this.snapshot();
  }

  /** 推荐包缺了就装，已有则更新。失败只记日志，不挡启动。 */
  async ensureRecommended(): Promise<void> {
    const installed = await this.listInstalled();
    for (const item of RECOMMENDED_PACKAGES) {
      if (this.prefs.disabledRecommended.includes(item.name)) continue;
      const existing = installed.find((entry) => packageNameFromSource(entry.source) === item.name);
      try {
        if (existing === undefined) await this.packages.installAndPersist(item.source);
        else await this.packages.update(existing.source);
      } catch (error) {
        this.log(`Recommended plugin sync failed for ${item.name}: ${asMessage(error)}`);
      }
    }
  }

  private async applyBundledMutation(id: string, mutate: () => void, forceIds?: ReadonlySet<string>): Promise<PluginSnapshot> {
    const previous = this.bundledMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.bundledMutationTail = current;
    await previous;
    try {
      const operation = async (reload: () => Promise<number>): Promise<PluginSnapshot> => {
        const previousPrefs = {
          version: this.prefs.version,
          disabledBundled: [...this.prefs.disabledBundled],
          disabledRecommended: [...this.prefs.disabledRecommended],
        };
        const target = BUNDLED_PLUGINS.find((plugin) => plugin.id === id);
        if (target === undefined) throw new AppError("PLUGIN_NOT_FOUND", "插件不存在", 404);
        const previousFiles = await this.captureBundledFiles();
        try {
          mutate();
          await this.persistPrefs();
          await this.reconcileBundled(forceIds);
          await reload();
          return this.snapshot();
        } catch (error) {
          this.prefs = previousPrefs;
          await this.persistPrefs().catch((rollbackError) => this.log(`Plugin preference rollback failed: ${asMessage(rollbackError)}`));
          try {
            await this.restoreBundledFiles(previousFiles);
            await reload();
          } catch (rollbackError) {
            this.log(`Plugin rollback failed: ${asMessage(rollbackError)}`);
          }
          throw error;
        }
      };
      const reload = this.lifecycle.reload ?? (async () => 0);
      if (this.lifecycle.withReload === undefined) {
        this.lifecycle.assertReady?.();
        return operation(reload);
      }
      return this.lifecycle.withReload(operation);
    } finally {
      release();
      if (this.bundledMutationTail === current) this.bundledMutationTail = Promise.resolve();
    }
  }

  private async captureBundledFiles(): Promise<Map<string, string | undefined>> {
    const files = new Set([
      ...BUNDLED_PLUGINS.map((plugin) => plugin.file),
      ...Object.keys(this.retiredHashes).filter((file) => file === basename(file)),
    ]);
    const snapshots = new Map<string, string | undefined>();
    for (const file of files) snapshots.set(file, await readPluginText(join(this.agentDir, "extensions", file)));
    return snapshots;
  }

  private async restoreBundledFiles(files: ReadonlyMap<string, string | undefined>): Promise<void> {
    for (const [file, content] of files) {
      const path = join(this.agentDir, "extensions", file);
      if (content === undefined) await rm(path, { force: true });
      else await atomicWrite(path, content);
    }
  }

  private async reconcileBundled(forceIds?: ReadonlySet<string>) {
    return reconcileBundledPlugins({
      extensionsDir: join(this.agentDir, "extensions"),
      bundledDir: bundledPluginRoot(),
      knownHashes: this.knownHashes,
      retired: this.retiredHashes,
      disabled: new Set(this.prefs.disabledBundled),
      ...(forceIds === undefined ? {} : { forceIds }),
    });
  }

  private async listInstalled(): Promise<InstalledPluginStatus[]> {
    const configured = this.packages.listConfiguredPackages().filter((item) => item.scope === "user");
    const installed: InstalledPluginStatus[] = [];
    for (const item of configured) {
      const name = packageNameFromSource(item.source) ?? item.source;
      const version = await readInstalledVersion(item.installedPath);
      installed.push({ source: item.source, name, ...(version === undefined ? {} : { version }) });
    }
    return installed.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async removeByName(name: string): Promise<void> {
    const installed = await this.listInstalled();
    const match = installed.find((item) => packageNameFromSource(item.source) === name);
    if (match !== undefined) await this.removeSource(match.source);
  }

  private async removeSource(source: string): Promise<void> {
    await this.packages.removeAndPersist(source);
    const name = packageNameFromSource(source);
    if (name !== undefined && RECOMMENDED_PACKAGES.some((item) => item.name === name)) {
      this.prefs.disabledRecommended = [...new Set([...this.prefs.disabledRecommended, name])];
      await this.persistPrefs();
    }
  }

  private async loadPrefs(): Promise<void> {
    const loaded = await readJsonRecovering(this.prefsPath, (parsed) => {
      if (!isRecord(parsed) || parsed["version"] !== 1) throw new Error("Unsupported plugin prefs");
      return {
        version: 1 as const,
        disabledBundled: stringList(parsed["disabledBundled"]).filter((id) => BUNDLED_PLUGINS.some((plugin) => plugin.id === id)),
        disabledRecommended: stringList(parsed["disabledRecommended"]),
      };
    });
    if (loaded.value !== undefined) this.prefs = loaded.value;
    else await this.persistPrefs();
  }

  private async persistPrefs(): Promise<void> {
    await writeWithBackup(this.prefsPath, `${JSON.stringify(this.prefs, null, 2)}\n`);
  }
}

function createPackageManager(agentDir: string): PackageManager {
  return new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: SettingsManager.create(agentDir, agentDir) });
}

async function readManifest(): Promise<{ plugins: Record<string, string[]>; retired: Record<string, string[]> }> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath(), "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["plugins"])) throw new Error("Unsupported plugin manifest");
  return { plugins: hashMap(parsed["plugins"]), retired: isRecord(parsed["retired"]) ? hashMap(parsed["retired"]) : {} };
}

function hashMap(record: Record<string, unknown>): Record<string, string[]> {
  const hashes: Record<string, string[]> = {};
  for (const [file, value] of Object.entries(record)) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Invalid plugin hash list: ${file}`);
    hashes[file] = value;
  }
  return hashes;
}

async function readInstalledVersion(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    return isRecord(parsed) && typeof parsed["version"] === "string" ? parsed["version"] : undefined;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function assertBundledId(id: string): void {
  if (!BUNDLED_PLUGINS.some((plugin) => plugin.id === id)) throw new AppError("PLUGIN_NOT_FOUND", "插件不存在", 404);
}
