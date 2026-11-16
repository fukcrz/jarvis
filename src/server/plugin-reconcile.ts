import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

export interface LocalPackageSeedOutcome {
  result: "seeded" | "upgraded" | "kept" | "missing";
  /** 本地内容与上次播种一致（或刚播种完成）：记录为下次自动升级的基线。 */
  baselineHash?: string;
  /** 本地存在与基线不同的改动，因此没有自动升级。 */
  modified: boolean;
}

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
 * 目录内容指纹：按相对路径排序后哈希文件内容，换行归一，跳过 node_modules 与 .git。
 * 用来判断本地副本是否仍是上次播种的样子。
 */
export async function localPackageTreeHash(dir: string): Promise<string | undefined> {
  if (!(await pathExists(dir))) return undefined;
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) files.push(next);
    }
  };
  await walk("");
  files.sort();
  const hash = createHash("md5");
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf8");
    hash.update(file, "utf8");
    hash.update("\0");
    hash.update(content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 用发行版种子替换本地副本，保留本地 node_modules（依赖单独播种）。 */
async function replaceLocalPackageTree(shipped: string, local: string): Promise<void> {
  for (const entry of await readdir(local)) {
    if (entry === "node_modules") continue;
    await rm(join(local, entry), { recursive: true, force: true });
  }
  await cp(shipped, local, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => basename(source) !== "node_modules",
  });
}

/**
 * 本地插件包的种子与升级：本地目录是权威，只有「与上次播种完全一致」时才自动升级。
 * - 本地不存在：从发行版种子播种。
 * - 本地内容等于基线、种子已变：按新种子替换，旧文件一并删除。
 * - 本地内容不等于基线（有人改过）或没有基线记录：保留本地，只报告 modified。
 * 复制与替换都跳过 node_modules，依赖由 {@link seedLocalPackageDependencies} 负责。
 */
export async function ensureLocalPackage(input: { shipped: string; local: string; baselineHash?: string }): Promise<LocalPackageSeedOutcome> {
  if (!(await pathExists(input.shipped))) return { result: "missing", modified: false };
  if (!(await pathExists(input.local))) {
    await mkdir(dirname(input.local), { recursive: true });
    await cp(input.shipped, input.local, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (source) => basename(source) !== "node_modules",
    });
    const hash = await localPackageTreeHash(input.local);
    return { result: "seeded", ...(hash === undefined ? {} : { baselineHash: hash }), modified: false };
  }
  const [shippedHash, localHash] = await Promise.all([
    localPackageTreeHash(input.shipped),
    localPackageTreeHash(input.local),
  ]);
  if (localHash !== undefined && localHash === shippedHash) {
    return { result: "kept", baselineHash: localHash, modified: false };
  }
  if (localHash !== undefined && input.baselineHash !== undefined && localHash === input.baselineHash) {
    await replaceLocalPackageTree(input.shipped, input.local);
    const hash = await localPackageTreeHash(input.local);
    return { result: "upgraded", ...(hash === undefined ? {} : { baselineHash: hash }), modified: false };
  }
  return { result: "kept", modified: true };
}

/**
 * 播种运行依赖：本地 node_modules 缺哪个，就从 Jarvis 自己的 node_modules 复制哪个。
 * 依赖名取自种子的 package.json；Jarvis 已依赖这些包，版本因此与发行版一致。
 */
export async function seedLocalPackageDependencies(input: {
  shipped: string;
  local: string;
  sourceRoot: string;
}): Promise<string[]> {
  const manifest = await readPluginText(join(input.shipped, "package.json"));
  if (manifest === undefined) return [];
  let names: string[];
  try {
    const parsed: unknown = JSON.parse(manifest);
    const dependencies = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["dependencies"] : undefined;
    if (typeof dependencies !== "object" || dependencies === null) return [];
    names = Object.keys(dependencies).filter((name) => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name));
  } catch {
    return [];
  }
  const copied: string[] = [];
  for (const name of names) {
    const source = join(input.sourceRoot, name);
    const destination = join(input.local, "node_modules", name);
    if ((await pathExists(destination)) || !(await pathExists(source))) continue;
    await mkdir(dirname(destination), { recursive: true });
    // 开发树里的依赖可能是符号链接，解引用后复制成普通目录。
    await cp(source, destination, { recursive: true, force: true, dereference: true });
    copied.push(name);
  }
  return copied;
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
 * 版本提示：本地副本与发行版种子的上游版本不一致时，界面可以显示「有更新」。
 * 自动升级只在本地内容等于播种基线时发生（见 {@link ensureLocalPackage}）。
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
