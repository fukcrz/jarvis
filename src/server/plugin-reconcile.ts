import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BundledPluginStatus } from "../shared/plugins.js";
import { isMissingFile } from "./fs.js";

/** 换行归一后再哈希，避免同一份插件因 CRLF/LF 被当成改过。 */
export function pluginContentHash(content: string): string {
  return createHash("md5").update(content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8").digest("hex");
}

export type BundledSyncAction = "write" | "skip" | "modified";

/**
 * 没有文件，或哈希落在已发布清单里且不是当前内容：写入自带版本。
 * 与当前内容一致：不动。对不上任何一个已发布哈希：视为改过，不自动覆盖。
 */
export function decideBundledSync(existingHash: string | undefined, currentHash: string, knownHashes: readonly string[]): BundledSyncAction {
  if (existingHash === undefined || existingHash === currentHash) return existingHash === undefined ? "write" : "skip";
  return knownHashes.includes(existingHash) ? "write" : "modified";
}

export interface BundledPluginSpec {
  id: string;
  file: string;
  label: string;
}

export const BUNDLED_PLUGINS: readonly BundledPluginSpec[] = [
  { id: "model-groups-router", file: "model-groups-router.ts", label: "模型组路由" },
  { id: "session-board", file: "session-board.ts", label: "会话互通" },
];

export async function readPluginText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

/** 下线插件的安装文件：对得上已发布哈希就删，改过的留下。 */
export function decideRetiredCleanup(existingHash: string | undefined, publishedHashes: readonly string[]): "delete" | "keep" {
  if (existingHash === undefined || !publishedHashes.includes(existingHash)) return "keep";
  return "delete";
}

export async function reconcileBundledPlugins(input: {
  extensionsDir: string;
  bundledDir: string;
  knownHashes: Readonly<Record<string, readonly string[]>>;
  retired?: Readonly<Record<string, readonly string[]>>;
  disabled: ReadonlySet<string>;
  forceIds?: ReadonlySet<string>;
}): Promise<BundledPluginStatus[]> {
  await mkdir(input.extensionsDir, { recursive: true });
  const statuses: BundledPluginStatus[] = [];
  for (const plugin of BUNDLED_PLUGINS) {
    const destination = join(input.extensionsDir, plugin.file);
    const enabled = !input.disabled.has(plugin.id);
    if (!enabled) {
      await rm(destination, { force: true });
      statuses.push({ id: plugin.id, label: plugin.label, enabled: false, modified: false });
      continue;
    }
    const bundled = await readFile(join(input.bundledDir, plugin.file), "utf8");
    const currentHash = pluginContentHash(bundled);
    const known = input.knownHashes[plugin.file] ?? [];
    const existing = await readPluginText(destination);
    const existingHash = existing === undefined ? undefined : pluginContentHash(existing);
    const forced = input.forceIds?.has(plugin.id) === true;
    const action = forced ? "write" : decideBundledSync(existingHash, currentHash, known);
    if (action === "write") await writeFile(destination, bundled.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
    statuses.push({ id: plugin.id, label: plugin.label, enabled: true, modified: action === "modified" });
  }
  await removeRetiredPlugins(input.extensionsDir, input.retired ?? {});
  return statuses;
}

async function removeRetiredPlugins(extensionsDir: string, retired: Readonly<Record<string, readonly string[]>>): Promise<void> {
  const current = new Set(BUNDLED_PLUGINS.map((plugin) => plugin.file));
  for (const [file, hashes] of Object.entries(retired)) {
    if (file !== basename(file) || current.has(file)) continue;
    const destination = join(extensionsDir, file);
    const existing = await readPluginText(destination);
    const existingHash = existing === undefined ? undefined : pluginContentHash(existing);
    if (decideRetiredCleanup(existingHash, hashes) === "delete") await rm(destination, { force: true });
  }
}

export type LocalPackageSyncResult = "seeded" | "kept" | "missing";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/**
 * 本地插件包的种子逻辑：本地目录一旦存在就是唯一权威，永远不覆盖、不删除、不比对版本。
 * 只复制，且跳过 node_modules（依赖由本地包自己管理）。
 */
export async function ensureLocalPackage(input: { shipped: string; local: string }): Promise<LocalPackageSyncResult> {
  if (await pathExists(input.local)) return "kept";
  if (!(await pathExists(input.shipped))) return "missing";
  await mkdir(dirname(input.local), { recursive: true });
  await cp(input.shipped, input.local, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => basename(source) !== "node_modules",
  });
  return "seeded";
}

async function readJarvisUpstream(packageDir: string): Promise<string | undefined> {
  const text = await readPluginText(join(packageDir, "package.json"));
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const jarvis = (parsed as Record<string, unknown>)["_jarvis"];
    if (typeof jarvis !== "object" || jarvis === null) return undefined;
    const upstream = (jarvis as Record<string, unknown>)["upstream"];
    return typeof upstream === "string" ? upstream : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 只做提示：本地副本与发行版种子记录的上游版本不一致时，界面可以显示「有更新」。
 * 不做自动同步——本地改动是唯一权威。
 */
export async function localPackageUpdate(input: { shipped: string; local: string }): Promise<{ shippedUpstream?: string; localUpstream?: string; updateAvailable: boolean }> {
  const [shippedUpstream, localUpstream] = await Promise.all([
    readJarvisUpstream(input.shipped),
    readJarvisUpstream(input.local),
  ]);
  return {
    ...(shippedUpstream === undefined ? {} : { shippedUpstream }),
    ...(localUpstream === undefined ? {} : { localUpstream }),
    updateAvailable: shippedUpstream !== undefined && localUpstream !== undefined && shippedUpstream !== localUpstream,
  };
}
