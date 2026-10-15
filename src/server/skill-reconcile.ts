import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isMissingFile } from "./fs.js";

/** 换行归一后再哈希，避免同一份技能因 CRLF/LF 被当成改过。 */
export function skillContentHash(content: string | Buffer): string {
  const normalized = typeof content === "string"
    ? content.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    : content.includes(0)
      ? content
      : Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  return createHash("md5").update(normalized).digest("hex");
}

export function skillTreeHash(files: ReadonlyArray<{ path: string; hash: string }>): string {
  const body = [...files].sort((left, right) => left.path.localeCompare(right.path)).map((file) => `${file.path}\0${file.hash}`).join("\n");
  return createHash("md5").update(body, "utf8").digest("hex");
}

export type BundledSyncAction = "write" | "skip" | "modified";

export function decideBundledSkillSync(existingHash: string | undefined, currentHash: string, knownHashes: readonly string[]): BundledSyncAction {
  if (existingHash === undefined || existingHash === currentHash) return existingHash === undefined ? "write" : "skip";
  return knownHashes.includes(existingHash) ? "write" : "modified";
}

export interface BundledSkillSpec {
  id: string;
  label: string;
}

export const BUNDLED_SKILLS: readonly BundledSkillSpec[] = [
  { id: "browser-qa", label: "浏览器联调" },
  { id: "ui-prototype", label: "界面原型" },
  { id: "web-research", label: "联网调研" },
];

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSkillName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && SKILL_NAME.test(value);
}

export interface BundledSkillStatus {
  id: string;
  label: string;
  enabled: boolean;
  modified: boolean;
  path?: string;
}

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await visit(root);
  return found;
}

export async function hashSkillTree(root: string): Promise<string | undefined> {
  try {
    const files = await walkFiles(root);
    const hashed = await Promise.all(files.map(async (file) => ({
      path: relative(root, file).replaceAll("\\", "/"),
      hash: skillContentHash(await readFile(file)),
    })));
    return skillTreeHash(hashed);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function writeSkillTree(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of await walkFiles(source)) {
    const relativePath = relative(source, file);
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    const content = await readFile(file);
    if (content.includes(0)) await writeFile(target, content);
    else await writeFile(target, content.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  try {
    await rename(source, destination);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code !== "EXDEV") throw error;
    await writeSkillTree(source, destination);
    await rm(source, { recursive: true, force: true });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/**
 * 没有目录，或哈希落在已发布清单里且不是当前内容：写入自带版本。
 * 与当前内容一致：不动。对不上任何一个已发布哈希：视为改过，不自动覆盖。
 * 关闭时，没改过的删掉副本；改过的挪到 hold，不删。
 */
export async function reconcileBundledSkills(input: {
  skillsDir: string;
  bundledDir: string;
  holdDir: string;
  knownHashes: Readonly<Record<string, readonly string[]>>;
  disabled: ReadonlySet<string>;
  forceIds?: ReadonlySet<string>;
}): Promise<BundledSkillStatus[]> {
  await mkdir(input.skillsDir, { recursive: true });
  const statuses: BundledSkillStatus[] = [];
  for (const skill of BUNDLED_SKILLS) {
    const destination = join(input.skillsDir, skill.id);
    const hold = join(input.holdDir, skill.id);
    const bundledRoot = join(input.bundledDir, skill.id);
    const currentHash = await hashSkillTree(bundledRoot);
    if (currentHash === undefined) throw new Error(`Bundled skill is missing: ${skill.id}`);
    const known = input.knownHashes[skill.id] ?? [];
    const forced = input.forceIds?.has(skill.id) === true;
    const enabled = !input.disabled.has(skill.id);
    if (!enabled) {
      if (forced) {
        await rm(destination, { recursive: true, force: true });
        await rm(hold, { recursive: true, force: true });
        statuses.push({ id: skill.id, label: skill.label, enabled: false, modified: false });
        continue;
      }
      const existingHash = await hashSkillTree(destination);
      const held = await pathExists(hold);
      const action = existingHash === undefined ? undefined : decideBundledSkillSync(existingHash, currentHash, known);
      if (action === "modified") await moveDirectory(destination, hold);
      else if (existingHash !== undefined) await rm(destination, { recursive: true, force: true });
      const modified = action === "modified" || held;
      statuses.push({ id: skill.id, label: skill.label, enabled: false, modified, path: modified ? hold : bundledRoot });
      continue;
    }
    if (forced) {
      await rm(hold, { recursive: true, force: true });
      await writeSkillTree(bundledRoot, destination);
      statuses.push({ id: skill.id, label: skill.label, enabled: true, modified: false, path: destination });
      continue;
    }
    if (await pathExists(hold) && !(await pathExists(destination))) await moveDirectory(hold, destination);
    const existingHash = await hashSkillTree(destination);
    const action = decideBundledSkillSync(existingHash, currentHash, known);
    if (action === "write") await writeSkillTree(bundledRoot, destination);
    statuses.push({ id: skill.id, label: skill.label, enabled: true, modified: action === "modified", path: destination });
  }
  return statuses;
}

export function isDirectChild(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/[\/]+$/, "");
  return dirname(child).toLowerCase() === normalizedParent.toLowerCase();
}
