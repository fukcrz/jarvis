import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Workspace } from "../shared/protocol.js";
import { AppError } from "./errors.js";

interface PersistedWorkspaces {
  version: 1;
  workspaces: Workspace[];
}

const MAX_LABEL_LENGTH = 96;

export class WorkspaceStore {
  private readonly filePath: string;
  private workspaces: Workspace[] = [];

  constructor(filePath = join(process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis"), "workspaces.json")) {
    this.filePath = filePath;
  }

  async initialize(defaultCwd: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedWorkspaces;
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces)) throw new Error("Unsupported workspace registry format");
      this.workspaces = parsed.workspaces;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const cwd = await resolveDirectory(defaultCwd);
      const now = new Date().toISOString();
      this.workspaces = [{ id: randomUUID(), cwd, label: defaultLabel(cwd), createdAt: now, updatedAt: now }];
      await this.persist();
    }
  }

  list(): Workspace[] {
    return [...this.workspaces].sort((a, b) => a.label.localeCompare(b.label));
  }

  get(id: string): Workspace {
    const workspace = this.workspaces.find((candidate) => candidate.id === id);
    if (workspace === undefined) throw new AppError("WORKSPACE_NOT_FOUND", "Workspace not found", 404);
    return workspace;
  }

  async add(cwd: string, label?: string): Promise<Workspace> {
    const resolved = await resolveDirectory(cwd);
    const existing = this.workspaces.find((workspace) => workspace.cwd === resolved);
    if (existing !== undefined) return existing;

    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: randomUUID(),
      cwd: resolved,
      label: normalizeLabel(label, resolved),
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.push(workspace);
    await this.persist();
    return workspace;
  }

  async updateLabel(id: string, label: string): Promise<Workspace> {
    const workspace = this.get(id);
    workspace.label = normalizeLabel(label, workspace.cwd);
    workspace.updatedAt = new Date().toISOString();
    await this.persist();
    return workspace;
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    this.workspaces = this.workspaces.filter((workspace) => workspace.id !== id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload: PersistedWorkspaces = { version: 1, workspaces: this.workspaces };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

async function resolveDirectory(value: string): Promise<string> {
  const cwd = value.trim();
  if (cwd === "") throw new AppError("WORKSPACE_PATH_INVALID", "Workspace path is required");
  try {
    const metadata = await stat(cwd);
    if (!metadata.isDirectory()) throw new AppError("WORKSPACE_PATH_INVALID", "Workspace path must be a directory");
    return await import("node:fs/promises").then(({ realpath }) => realpath(cwd));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("WORKSPACE_PATH_INVALID", `Workspace path is unavailable: ${cwd}`);
  }
}

function normalizeLabel(value: string | undefined, cwd: string): string {
  const label = (value ?? defaultLabel(cwd)).trim();
  if (label === "") throw new AppError("WORKSPACE_LABEL_INVALID", "Workspace name is required");
  if (label.length > MAX_LABEL_LENGTH) throw new AppError("WORKSPACE_LABEL_INVALID", `Workspace name must be at most ${String(MAX_LABEL_LENGTH)} characters`);
  return label;
}

function defaultLabel(cwd: string): string {
  return basename(cwd) || cwd;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
