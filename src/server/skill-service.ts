import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager, getAgentDir, loadSkillsFromDir, SettingsManager, type Skill } from "@earendil-works/pi-coding-agent";
import type { SkillDiagnostic, SkillEntry, SkillFileContent, SkillFileListing, SkillOrigin, SkillSnapshot } from "../shared/skills.js";
import { isRecord } from "../shared/protocol.js";
import { AppError } from "./errors.js";
import { atomicWrite, isMissingFile } from "./fs.js";
import { BUNDLED_SKILLS, isDirectChild, isSkillName, reconcileBundledSkills, type BundledSkillStatus } from "./skill-reconcile.js";
import { readWorkspaceFile } from "./workspace-fs.js";

interface SkillPrefs { version: 1; disabledBundled: string[] }

interface SkillSource {
  origin: SkillOrigin;
  source?: string;
  scope: "user" | "project";
}

export interface SkillWorkspaceRef {
  id: string;
  label: string;
  cwd: string;
}

const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function bundledSkillRoot(): string {
  return join(process.cwd(), "skills", "bundled");
}

function manifestPath(): string {
  return join(process.cwd(), "skills", "manifest.json");
}

export class SkillService {
  private prefs: SkillPrefs = { version: 1, disabledBundled: [] };
  private knownHashes: Record<string, string[]> = {};
  private retiredHashes: Record<string, string[]> = {};

  constructor(
    private readonly agentDir = getAgentDir(),
    private readonly prefsPath = join(process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis"), "skill-prefs.json"),
    private readonly workspaces: () => SkillWorkspaceRef[] = () => [],
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  async initialize(): Promise<void> {
    const manifest = await readManifest();
    this.knownHashes = manifest.skills;
    this.retiredHashes = manifest.retired;
    await this.loadPrefs();
    await this.reconcile();
  }

  async snapshot(): Promise<SkillSnapshot> {
    const catalog = await this.catalog(await this.reconcile());
    return {
      bundled: catalog.bundled.map(publicEntry),
      installed: catalog.installed.map(publicEntry),
      diagnostics: catalog.diagnostics,
    };
  }

  async setBundledEnabled(id: string, enabled: boolean): Promise<SkillSnapshot> {
    assertBundledId(id);
    this.prefs.disabledBundled = enabled
      ? this.prefs.disabledBundled.filter((item) => item !== id)
      : [...new Set([...this.prefs.disabledBundled, id])];
    await this.persistPrefs();
    return this.snapshot();
  }

  async overwriteBundled(id: string): Promise<SkillSnapshot> {
    assertBundledId(id);
    this.prefs.disabledBundled = this.prefs.disabledBundled.filter((item) => item !== id);
    await this.persistPrefs();
    await this.reconcile(new Set([id]));
    return this.snapshot();
  }

  async importDirectory(sourcePath: string): Promise<SkillSnapshot> {
    const source = await realpath(sourcePath).catch(() => { throw new AppError("SKILL_IMPORT_INVALID", "无法打开目录", 400); });
    const metadata = await stat(source).catch(() => undefined);
    if (metadata === undefined || !metadata.isDirectory()) throw new AppError("SKILL_IMPORT_INVALID", "无法打开目录", 400);
    const name = source.split(sep).pop() ?? "";
    if (!isSkillName(name)) throw new AppError("SKILL_IMPORT_INVALID", "目录名不可用", 400);
    if (BUNDLED_SKILLS.some((skill) => skill.id === name)) throw new AppError("SKILL_IMPORT_INVALID", "这是自带技能", 400);
    await assertSkillRoot(source);
    const destination = join(this.agentDir, "skills", name);
    if (await exists(destination)) throw new AppError("SKILL_IMPORT_EXISTS", "已存在", 409);
    if (isInside(source, join(this.agentDir, "skills"))) throw new AppError("SKILL_IMPORT_INVALID", "无法导入该目录", 400);
    await assertImportSize(source);
    await mkdir(join(this.agentDir, "skills"), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: true, filter: (path) => !isSkippedImportPath(path) });
    return this.snapshot();
  }

  async remove(id: string): Promise<SkillSnapshot> {
    const snapshot = await this.catalog(await this.reconcile());
    const entry = findEntry(snapshot, id);
    if (entry === undefined || !entry.canDelete || entry.baseDir === undefined) throw new AppError("SKILL_NOT_FOUND", "技能不存在", 404);
    const root = await realpath(entry.baseDir).catch(() => { throw new AppError("SKILL_NOT_FOUND", "技能不存在", 404); });
    const skillsRoot = await realpath(join(this.agentDir, "skills")).catch(() => undefined);
    const agentsRoot = await realpath(join(homedir(), ".agents", "skills")).catch(() => undefined);
    const parent = skillsRoot !== undefined && isInside(root, skillsRoot) ? skillsRoot : agentsRoot !== undefined && isInside(root, agentsRoot) ? agentsRoot : undefined;
    if (parent === undefined || !isDirectChild(parent, root)) throw new AppError("SKILL_DELETE_INVALID", "不能删除", 400);
    const link = await lstat(root);
    if (link.isSymbolicLink()) throw new AppError("SKILL_DELETE_INVALID", "不能删除", 400);
    await rm(root, { recursive: true, force: false });
    return this.snapshot();
  }

  async listFiles(id: string, relativePath = ""): Promise<SkillFileListing> {
    const root = await this.fileRoot(id);
    const directory = await resolveInside(root, relativePath);
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) throw new AppError("SKILL_PATH_INVALID", "无法读取", 400);
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = entries
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({
        name: entry.name,
        path: posixRelative(root, join(directory, entry.name)),
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
      }))
      .sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name));
    const current = posixRelative(root, directory);
    const parent = current === "" ? undefined : current.split("/").slice(0, -1).join("/");
    return { path: current, ...(parent === undefined && current === "" ? {} : { parent: parent ?? "" }), entries: visible };
  }

  async readFile(id: string, relativePath: string): Promise<SkillFileContent> {
    const root = await this.fileRoot(id);
    const filePath = await resolveInside(root, relativePath);
    const content = await readWorkspaceFile(root, filePath);
    return { path: posixRelative(root, filePath), name: content.name, content: content.content, truncated: content.truncated };
  }

  private async fileRoot(id: string): Promise<string> {
    const snapshot = await this.catalog(await this.reconcile());
    const entry = findEntry(snapshot, id);
    if (entry?.baseDir === undefined) throw new AppError("SKILL_NOT_FOUND", "技能不存在", 404);
    return realpath(entry.baseDir);
  }

  private async reconcile(forceIds?: ReadonlySet<string>): Promise<BundledSkillStatus[]> {
    return reconcileBundledSkills({
      skillsDir: join(this.agentDir, "skills"),
      bundledDir: bundledSkillRoot(),
      holdDir: join(dirname(this.prefsPath), "skill-hold"),
      knownHashes: this.knownHashes,
      retiredHashes: this.retiredHashes,
      disabled: new Set(this.prefs.disabledBundled),
      ...(forceIds === undefined ? {} : { forceIds }),
    });
  }

  private async catalog(bundledStatus: BundledSkillStatus[]): Promise<CatalogSnapshot> {
    const discovered = await this.discover(bundledStatus);
    const bundledIds = new Set(BUNDLED_SKILLS.map((skill) => skill.id));
    const bundled = BUNDLED_SKILLS.map((skill) => {
      const status = bundledStatus.find((item) => item.id === skill.id);
      const loaded = discovered.find((item) => item.id === skill.id);
      return {
        id: skill.id,
        name: loaded?.name ?? skill.id,
        label: skill.label,
        ...(loaded?.description === undefined ? {} : { description: loaded.description }),
        origin: "bundled" as const,
        enabled: status?.enabled ?? true,
        modified: status?.modified ?? false,
        loaded: loaded?.loaded === true,
        manualOnly: loaded?.manualOnly ?? false,
        canDelete: false,
        ...(status?.path === undefined && loaded?.baseDir === undefined ? {} : { baseDir: status?.path ?? loaded?.baseDir }),
      };
    });
    const installed = discovered.filter((item) => !bundledIds.has(item.id) && item.origin !== "bundled");
    return { bundled, installed, diagnostics: discovered.flatMap((item) => item.diagnostic === undefined ? [] : [item.diagnostic]) };
  }

  private async discover(bundledStatus: BundledSkillStatus[]): Promise<DiscoveredSkill[]> {
    const skills: DiscoveredSkill[] = [];
    const seen = new Set<string>();
    const add = (skill: Skill, source: SkillSource, loaded: boolean, diagnostic?: SkillDiagnostic) => {
      const id = source.origin === "bundled" ? basenameId(skill.baseDir) : skill.name;
      const key = `${id}\0${skill.filePath}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (loaded && source.origin !== "project" && skills.some((item) => item.loaded && item.name === skill.name && item.origin !== "project")) {
        skills.push(toDiscovered(skill, source, false, { message: "名称冲突，未加载", path: skill.filePath }, `lost-${shortHash(skill.filePath)}`));
        return;
      }
      skills.push(toDiscovered(skill, source, loaded, diagnostic, id));
    };
    const userDir = join(this.agentDir, "skills");
    for (const skill of loadSkillsFromDir({ dir: userDir, source: "user" }).skills) {
      const id = basenameId(skill.baseDir);
      add(skill, { origin: BUNDLED_SKILLS.some((item) => item.id === id) ? "bundled" : "user", scope: "user" }, true);
    }
    const agentsDir = join(homedir(), ".agents", "skills");
    if (await exists(agentsDir)) {
      for (const skill of loadSkillsFromDir({ dir: agentsDir, source: "user" }).skills) add(skill, { origin: "user", scope: "user" }, true);
    }
    for (const workspace of this.workspaces()) {
      for (const dir of [join(workspace.cwd, ".pi", "skills"), join(workspace.cwd, ".agents", "skills")]) {
        if (!(await exists(dir))) continue;
        for (const skill of loadSkillsFromDir({ dir, source: "project" }).skills) {
          add(skill, { origin: "project", source: workspace.label, scope: "project" }, true);
        }
      }
    }
    try {
      const resolved = await createPackageManager(this.agentDir).resolve(async () => "skip");
      for (const resource of resolved.skills) {
        if (!resource.enabled || resource.metadata.origin !== "package") continue;
        const loaded = loadSkillsFromDir({ dir: dirname(resource.path), source: "path" });
        for (const skill of loaded.skills) {
          if (skill.filePath !== resource.path && dirname(skill.filePath) !== dirname(resource.path)) continue;
          add(skill, { origin: "package", source: resource.metadata.source, scope: resource.metadata.scope === "project" ? "project" : "user" }, true);
        }
      }
    } catch (error) {
      this.log(error instanceof Error ? error.message : "无法读取已安装技能包");
    }
    for (const status of bundledStatus) {
      if (status.enabled || status.path === undefined) continue;
      if (skills.some((item) => item.id === status.id)) continue;
      const loaded = loadSkillsFromDir({ dir: status.path, source: "user" });
      for (const skill of loaded.skills) add(skill, { origin: "bundled", scope: "user" }, false);
    }
    return skills;
  }

  private async loadPrefs(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.prefsPath, "utf8"));
      if (!isRecord(parsed)) throw new Error("Unsupported skill prefs");
      const disabled = Array.isArray(parsed["disabledBundled"]) ? parsed["disabledBundled"].filter((item): item is string => typeof item === "string") : [];
      this.prefs = { version: 1, disabledBundled: disabled.filter((id) => BUNDLED_SKILLS.some((skill) => skill.id === id)) };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await this.persistPrefs();
    }
  }

  private async persistPrefs(): Promise<void> {
    await mkdir(dirname(this.prefsPath), { recursive: true });
    await atomicWrite(this.prefsPath, `${JSON.stringify(this.prefs, null, 2)}\n`);
  }
}

interface DiscoveredSkill extends SkillEntry {
  baseDir?: string;
  diagnostic?: SkillDiagnostic;
}

interface CatalogSnapshot extends SkillSnapshot {
  bundled: Array<SkillEntry & { baseDir?: string }>;
  installed: Array<SkillEntry & { baseDir?: string }>;
}

function toDiscovered(skill: Skill, source: SkillSource, loaded: boolean, diagnostic: SkillDiagnostic | undefined, id: string): DiscoveredSkill {
  const bundled = BUNDLED_SKILLS.find((item) => item.id === id);
  return {
    id,
    name: skill.name,
    label: bundled?.label ?? skill.name,
    ...(skill.description === "" ? {} : { description: skill.description }),
    origin: source.origin,
    ...(source.source === undefined ? {} : { source: source.source }),
    enabled: loaded || source.origin !== "bundled",
    modified: false,
    loaded,
    manualOnly: skill.disableModelInvocation,
    canDelete: source.origin === "user" && isSkillName(id),
    baseDir: skill.baseDir,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function publicEntry(entry: SkillEntry): SkillEntry {
  return {
    id: entry.id,
    name: entry.name,
    label: entry.label,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    origin: entry.origin,
    ...(entry.source === undefined ? {} : { source: entry.source }),
    enabled: entry.enabled,
    modified: entry.modified,
    loaded: entry.loaded,
    manualOnly: entry.manualOnly,
    canDelete: entry.canDelete,
  };
}

function findEntry(snapshot: CatalogSnapshot, id: string): (SkillEntry & { baseDir?: string }) | undefined {
  return [...snapshot.bundled, ...snapshot.installed].find((item) => item.id === id);
}

function basenameId(baseDir: string): string {
  const name = baseDir.split(/[\\/]/).pop() ?? "";
  return isSkillName(name) ? name : `lost-${shortHash(baseDir)}`;
}

function shortHash(value: string): string {
  return createHash("md5").update(value).digest("hex").slice(0, 8);
}

function assertBundledId(id: string): void {
  if (!BUNDLED_SKILLS.some((skill) => skill.id === id)) throw new AppError("SKILL_NOT_FOUND", "技能不存在", 404);
}

async function assertSkillRoot(directory: string): Promise<void> {
  try {
    const metadata = await stat(join(directory, "SKILL.md"));
    if (!metadata.isFile()) throw new AppError("SKILL_IMPORT_INVALID", "没有 SKILL.md", 400);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isMissingFile(error)) throw new AppError("SKILL_IMPORT_INVALID", "没有 SKILL.md", 400);
    throw error;
  }
}

async function assertImportSize(directory: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(path)).size;
        if (files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES) throw new AppError("SKILL_IMPORT_INVALID", "文件夹过大", 400);
      }
    }
  };
  await visit(directory);
}

function isSkippedImportPath(path: string): boolean {
  return path.split(sep).some((part) => part === "node_modules" || part === ".git");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isInside(path: string, root: string): boolean {
  const left = path.toLowerCase();
  const right = root.toLowerCase().replace(/[\\/]+$/, "");
  return left === right || left.startsWith(`${right}${sep}`) || left.startsWith(`${right}/`);
}

async function resolveInside(root: string, relativePath: string): Promise<string> {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.split("/").includes("..")) throw new AppError("SKILL_PATH_INVALID", "无法读取", 400);
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(resolve(resolvedRoot, normalized)).catch(() => { throw new AppError("SKILL_PATH_INVALID", "无法读取", 400); });
  if (!isInside(resolved, resolvedRoot)) throw new AppError("SKILL_PATH_INVALID", "无法读取", 400);
  return resolved;
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function createPackageManager(agentDir: string): DefaultPackageManager {
  return new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: SettingsManager.create(agentDir, agentDir) });
}

function readHashMap(value: unknown, label: string): Record<string, string[]> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`Unsupported skill manifest ${label}`);
  const hashes: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) throw new Error(`Invalid skill hash list: ${id}`);
    hashes[id] = entry;
  }
  return hashes;
}

async function readManifest(): Promise<{ skills: Record<string, string[]>; retired: Record<string, string[]> }> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath(), "utf8"));
  if (!isRecord(parsed)) throw new Error("Unsupported skill manifest");
  return { skills: readHashMap(parsed["skills"], "skills"), retired: readHashMap(parsed["retired"], "retired") };
}
