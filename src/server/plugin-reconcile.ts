import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
