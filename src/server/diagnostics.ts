import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { arch, homedir, platform, release, totalmem, freemem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { listRecoveryNotices } from "./fs.js";
import { defaultLogDirectory, LOG_RETENTION_DAYS } from "./log-files.js";
import { createZip, type ZipInput } from "./zip.js";

const MAX_LOG_BYTES = 40 * 1024 * 1024;
const SECRET_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;

export interface DiagnosticsContext {
  jarvisHome?: string;
  logDirectory?: string;
  agentDir?: string;
  extra?: () => Record<string, unknown>;
}

/** 导出诊断包：最近 7 天日志、版本信息、去掉密码和 token 的配置。 */
export async function buildDiagnosticsZip(context: DiagnosticsContext = {}): Promise<{ fileName: string; data: Buffer }> {
  const jarvisHome = context.jarvisHome ?? process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis");
  const logDirectory = context.logDirectory ?? defaultLogDirectory();
  const agentDir = context.agentDir ?? getAgentDir();
  const now = new Date();
  const entries: ZipInput[] = [];

  const info = {
    generatedAt: now.toISOString(),
    jarvisVersion: await packageVersion(findUp("package.json", (parsed) => parsed["name"] === "jarvis")),
    piVersion: await packageVersion(findUp(join("node_modules", "@earendil-works", "pi-coding-agent", "package.json"))),
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, systemTotal: totalmem(), systemFree: freemem() },
    env: pickEnv(["NODE_ENV", "PORT", "HOST", "JARVIS_DESKTOP", "JARVIS_SELF_RESTART", "LOG_LEVEL"]),
    paths: { jarvisHome, agentDir, logDirectory, cwd: process.cwd() },
    recoveries: listRecoveryNotices(),
    ...(context.extra?.() ?? {}),
  };
  entries.push({ name: "info.json", data: `${JSON.stringify(info, null, 2)}\n` });

  // 日志：从新到旧，总量不超过上限。
  const logs = await listFiles(logDirectory);
  logs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let budget = MAX_LOG_BYTES;
  for (const log of logs) {
    if (!log.name.endsWith(".log")) continue;
    if (now.getTime() - log.mtimeMs > (LOG_RETENTION_DAYS + 1) * 86_400_000) continue;
    if (log.size > budget) continue;
    budget -= log.size;
    entries.push({ name: `logs/${log.name}`, data: await readFile(log.path), date: new Date(log.mtimeMs) });
  }
  // 自重启的输出（Windows）放在程序目录的 logs 下。
  for (const name of ["self-restart.log", "self-restart.error.log"]) {
    const path = join(process.cwd(), "logs", name);
    const content = await readFile(path).catch(() => undefined);
    if (content !== undefined && content.length < 2 * 1024 * 1024) entries.push({ name: `logs/${name}`, data: content });
  }

  // 配置：只放 JSON，敏感字段替换成 ***。
  const homeFiles = await listFiles(jarvisHome);
  entries.push({ name: "config/files.txt", data: homeFiles.map((file) => `${file.name}\t${String(file.size)}\t${new Date(file.mtimeMs).toISOString()}`).join("\n") });
  for (const file of homeFiles) {
    if (!file.name.endsWith(".json")) continue;
    const content = await readFile(file.path, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    entries.push({ name: `config/${file.name}`, data: sanitizeConfig(file.name, content) });
  }
  for (const name of ["models.json", "settings.json", "jarvis-session-attention.json"]) {
    const content = await readFile(join(agentDir, name), "utf8").catch(() => undefined);
    if (content === undefined) continue;
    entries.push({ name: `config/agent-${name}`, data: name === "jarvis-session-attention.json" ? summarizeAttention(content) : sanitizeConfig(name, content) });
  }

  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return { fileName: `jarvis-diagnostics-${stamp}.zip`, data: createZip(entries) };
}

/** 去掉密码、token、key 等字段；auth.json 只保留"是否设置了密码"。解析失败时只给长度。 */
export function sanitizeConfig(name: string, content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content)) as unknown;
  } catch {
    return `${JSON.stringify({ unreadable: true, length: content.length })}\n`;
  }
  if (name === "auth.json" && typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    return `${JSON.stringify({ version: record["version"], passwordSet: record["password"] !== null && record["password"] !== undefined, tokenVersion: record["tokenVersion"] }, null, 2)}\n`;
  }
  return `${JSON.stringify(redact(parsed), null, 2)}\n`;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key) && (typeof item === "string" || typeof item === "number")) next[key] = item === "" ? "" : "***";
    else if (key === "headers" && typeof item === "object" && item !== null) next[key] = Object.fromEntries(Object.keys(item).map((header) => [header, "***"]));
    else next[key] = redact(item);
  }
  return next;
}

function summarizeAttention(content: string): string {
  try {
    const parsed = JSON.parse(content) as { version?: unknown; sessions?: Record<string, unknown>; sideChats?: Record<string, unknown> };
    return `${JSON.stringify({ version: parsed.version, sessions: Object.keys(parsed.sessions ?? {}).length, sideChats: Object.keys(parsed.sideChats ?? {}).length }, null, 2)}\n`;
  } catch {
    return `${JSON.stringify({ unreadable: true, length: content.length })}\n`;
  }
}

function stripJsonComments(content: string): string {
  return content.replace(/^\s*\/\/.*$/gm, "");
}

async function listFiles(directory: string): Promise<{ name: string; path: string; size: number; mtimeMs: number }[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const files: { name: string; path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() === true) files.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

function pickEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name] ?? ""]]));
}

function findUp(relative: string, accept?: (parsed: Record<string, unknown>) => boolean): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) {
      if (accept === undefined) return candidate;
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
        if (accept(parsed)) return candidate;
      } catch {
        // 继续向上找。
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function packageVersion(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
