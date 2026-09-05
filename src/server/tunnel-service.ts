import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { TunnelEntryConfig, TunnelFrpConfig, TunnelLogEntry, TunnelMethod, TunnelSnapshot, TunnelState } from "../shared/protocol.js";
import { TUNNEL_METHODS } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";

const CONFIG_VERSION = 2;
const MAX_LOG_LINES = 300;
const MAX_LINE_LENGTH = 400;
const RESTART_BASE_DELAY_MS = 3_000;
const RESTART_MAX_DELAY_MS = 30_000;
/** frp 无 URL 日志，进程存活一段时间即视为运行 */
const FRP_READY_DELAY_MS = 2_000;

const URL_PATTERNS: Record<TunnelMethod, RegExp[]> = {
  cloudflared: [/https:\/\/[a-z0-9-]+\.trycloudflare\.com/],
  sish: [/https:\/\/[^\s]+/],
  frp: [/start proxy success/i],
};

const VERSION_FLAGS: Record<string, string[]> = {
  cloudflared: ["--version"],
  frpc: ["-v"],
};

/** 单个穿透条目的运行时状态。 */
interface TunnelInstance {
  config: TunnelEntryConfig;
  state: TunnelState;
  url?: string;
  error?: string;
  startedAt?: number;
  pid?: number;
  logs: TunnelLogEntry[];
  child?: ChildProcess;
  stopping: boolean;
  restartAttempt: number;
  restartTimer?: NodeJS.Timeout;
  urlTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

interface SpawnPlan {
  command: string;
  args: string[];
  /** frp 等无 URL 日志的方式：由配置构造公网地址 */
  constructedUrl?: string;
}

export interface TunnelInput {
  name?: string;
  method: TunnelMethod;
  enabled?: boolean;
  sish?: TunnelFrpServerInput;
  frp?: TunnelFrpConfig;
}
interface TunnelFrpServerInput { server: string; subdomain?: string; sshPort?: number }

/** 内网穿透：多条目（cloudflared/sish/frp），各自独立进程、状态、重连与日志。 */
export class TunnelService {
  private readonly configPath: string;
  private readonly binDir: string;
  private tunnels: TunnelEntryConfig[] = [];
  private readonly instances = new Map<string, TunnelInstance>();
  private defaultPort = 0;

  constructor(private readonly logInfo: (message: string) => void = () => undefined) {
    const home = process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis");
    this.configPath = join(home, "tunnel.json");
    this.binDir = join(home, "bin");
  }

  /** listen 之后调用：注入服务端口；迁移旧配置并拉起自动启动的条目。 */
  async initialize(defaultPort: number): Promise<void> {
    this.defaultPort = defaultPort;
    const envPort = Number(process.env["JARVIS_TUNNEL_PORT"]);
    if (validPort(envPort)) this.defaultPort = envPort;
    await this.loadConfig().catch((error) => this.logInfo(`读取穿透配置失败: ${asMessage(error)}`));
    for (const tunnel of this.tunnels) this.instances.set(tunnel.id, this.createInstance(tunnel));
    for (const tunnel of this.tunnels.filter((item) => item.enabled)) {
      this.logInfo(`自动穿透已开启（${tunnel.method}），正在启动隧道`);
      void this.startTunnel(tunnel.id).catch((error) => this.logInfo(`自动穿透启动失败: ${asMessage(error)}`));
    }
  }

  listTunnels(): TunnelSnapshot[] {
    return this.tunnels.map((config) => this.snapshot(config.id));
  }

  /** 添加条目并持久化；enabled=true 时立即启动。 */
  async addTunnel(input: TunnelInput): Promise<TunnelSnapshot> {
    const method = normalizeMethod(input.method);
    const tunnel: TunnelEntryConfig = {
      id: randomUUID(),
      method,
      enabled: input.enabled === true,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(method === "sish" && input.sish?.server.trim() ? { sish: normalizeSish(input.sish) } : {}),
      ...(method === "frp" && input.frp?.server.trim() ? { frp: normalizeFrp(input.frp) } : {}),
    };
    this.tunnels.push(tunnel);
    await this.persist();
    this.instances.set(tunnel.id, this.createInstance(tunnel));
    if (tunnel.enabled) await this.startTunnel(tunnel.id);
    return this.snapshot(tunnel.id);
  }

  /** 更新条目（含自动启动开关）；enabled 变化时联动启停。 */
  async updateTunnel(tunnelId: string, input: TunnelInput): Promise<TunnelSnapshot> {
    const tunnel = this.findConfig(tunnelId);
    const method = normalizeMethod(input.method);
    const next: TunnelEntryConfig = {
      id: tunnel.id,
      method,
      enabled: input.enabled === true,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(method === "sish" && input.sish?.server.trim() ? { sish: normalizeSish(input.sish) } : {}),
      ...(method === "frp" && input.frp?.server.trim() ? { frp: normalizeFrp(input.frp) } : {}),
    };
    const wasEnabled = tunnel.enabled;
    Object.assign(tunnel, next);
    await this.persist();
    const instance = this.instance(tunnelId);
    instance.stopping = true;
    clearTimeout(instance.restartTimer);
    clearTimeout(instance.urlTimer);
    await this.stopProcess(instance);
    instance.config = next;
    instance.state = "idle";
    instance.error = undefined;
    instance.url = undefined;
    instance.pid = undefined;
    instance.restartAttempt = 0;
    // 自动启动：开启时启动，关闭时保持停止。手动启动/停止不受影响。
    if (next.enabled && !wasEnabled) await this.startTunnel(tunnelId);
    if (!next.enabled && wasEnabled) this.logInfo(`穿透已停止自动启动（${next.method}）`);
    return this.snapshot(tunnelId);
  }

  async startTunnel(tunnelId: string): Promise<TunnelSnapshot> {
    const instance = this.instance(tunnelId);
    await this.spawnTunnel(instance);
    return this.snapshot(tunnelId);
  }

  async stopTunnel(tunnelId: string): Promise<TunnelSnapshot> {
    const instance = this.instance(tunnelId);
    instance.stopping = true;
    clearTimeout(instance.restartTimer);
    clearTimeout(instance.urlTimer);
    await this.stopProcess(instance);
    instance.state = "idle";
    instance.url = undefined;
    instance.error = undefined;
    instance.pid = undefined;
    return this.snapshot(tunnelId);
  }

  async removeTunnel(tunnelId: string): Promise<void> {
    const tunnel = this.findConfig(tunnelId);
    const instance = this.instance(tunnelId);
    instance.stopping = true;
    clearTimeout(instance.restartTimer);
    clearTimeout(instance.urlTimer);
    clearTimeout(instance.killTimer);
    await this.stopProcess(instance);
    this.instances.delete(tunnelId);
    this.tunnels = this.tunnels.filter((item) => item.id !== tunnel.id);
    await this.persist();
    this.logInfo(`已删除穿透条目（${tunnel.method}）`);
  }

  async dispose(): Promise<void> {
    for (const instance of this.instances.values()) {
      instance.stopping = true;
      clearTimeout(instance.restartTimer);
      clearTimeout(instance.urlTimer);
      clearTimeout(instance.killTimer);
      await this.stopProcess(instance);
    }
  }

  private findConfig(tunnelId: string): TunnelEntryConfig {
    const tunnel = this.tunnels.find((item) => item.id === tunnelId);
    if (tunnel === undefined) throw new AppError("TUNNEL_NOT_FOUND", "穿透条目不存在", 404);
    return tunnel;
  }

  private instance(tunnelId: string): TunnelInstance {
    const instance = this.instances.get(tunnelId);
    if (instance === undefined) throw new AppError("TUNNEL_NOT_FOUND", "穿透条目不存在", 404);
    return instance;
  }

  private createInstance(config: TunnelEntryConfig): TunnelInstance {
    return { config, state: "idle", logs: [], stopping: false, restartAttempt: 0 };
  }

  private snapshot(tunnelId: string): TunnelSnapshot {
    const instance = this.instance(tunnelId);
    return {
      id: instance.config.id,
      ...(instance.config.name === undefined ? {} : { name: instance.config.name }),
      method: instance.config.method,
      enabled: instance.config.enabled,
      ...(instance.config.sish === undefined ? {} : { sish: instance.config.sish }),
      ...(instance.config.frp === undefined ? {} : { frp: instance.config.frp }),
      state: instance.state,
      ...(instance.url === undefined ? {} : { url: instance.url }),
      ...(instance.error === undefined ? {} : { error: instance.error }),
      ...(instance.startedAt === undefined ? {} : { startedAt: instance.startedAt }),
      ...(instance.pid === undefined ? {} : { pid: instance.pid }),
      logs: instance.logs,
    };
  }

  private async loadConfig(): Promise<void> {
    const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<{ version: number; tunnels?: unknown[]; enabled?: boolean; method?: unknown }>;
    if (parsed.version === 1 && isTunnelMethod(parsed.method)) {
      // 迁移：旧单例配置 → 单条目，自动启动统一改为手动。
      this.tunnels = [{
        id: randomUUID(),
        method: parsed.method,
        enabled: false,
        ...(legacySish(parsed) === undefined ? {} : { sish: legacySish(parsed) }),
        ...(legacyFrp(parsed) === undefined ? {} : { frp: legacyFrp(parsed) }),
      }];
      await this.persist();
      this.logInfo("已迁移旧穿透配置为条目（自动启动默认关闭）");
      return;
    }
    if (parsed.version !== CONFIG_VERSION || !Array.isArray(parsed.tunnels)) throw new Error("Unsupported tunnel config");
    this.tunnels = parsed.tunnels.flatMap((value): TunnelEntryConfig[] => {
      if (!isEntryConfig(value)) return [];
      return [{ ...value, enabled: value.enabled === true }];
    });
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify({ version: CONFIG_VERSION, tunnels: this.tunnels }, null, 2));
  }

  private async spawnTunnel(instance: TunnelInstance): Promise<void> {
    await this.stopProcess(instance);
    instance.stopping = false;
    instance.restartAttempt = 0;
    const method = instance.config.method;
    const port = this.defaultPort;
    instance.state = "starting";
    instance.startedAt = Date.now();
    instance.error = undefined;
    instance.url = undefined;
    let plan: SpawnPlan;
    try {
      plan = await this.buildPlan(instance.config, port);
    } catch (error) {
      this.fail(instance, asMessage(error));
      return;
    }
    this.logInfo(`启动穿透: ${method} → localhost:${port}`);
    const child = spawn(plan.command, plan.args, { detached: platform() !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    instance.child = child;
    instance.pid = child.pid;
    const splitter = createLineSplitter((line) => this.handleLine(instance, line, plan, child));
    child.stdout?.on("data", splitter);
    child.stderr?.on("data", splitter);
    child.on("error", (error) => {
      if (instance.child !== child) return;
      this.fail(instance, `无法启动 ${plan.command}: ${asMessage(error)}`);
    });
    child.on("exit", (code, signal) => {
      if (instance.child !== child) return;
      this.handleExit(instance, code, signal);
    });
    if (plan.constructedUrl !== undefined) {
      instance.urlTimer = setTimeout(() => {
        if (instance.child === child && instance.state === "starting") this.setRunning(instance, plan.constructedUrl as string);
      }, FRP_READY_DELAY_MS);
    }
  }

  private async buildPlan(config: TunnelEntryConfig, port: number): Promise<SpawnPlan> {
    switch (config.method) {
      case "cloudflared": {
        const binary = await this.ensureBinary("cloudflared");
        return { command: binary, args: ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--metrics", "127.0.0.1:0"] };
      }
      case "sish": {
        const sish = config.sish;
        if (sish === undefined || sish.server.trim() === "") throw new AppError("TUNNEL_SISH_SERVER", "请填写 sish 服务器地址", 400);
        const server = sish.server.trim();
        const subdomain = sish.subdomain?.trim() ?? "";
        const remote = subdomain === "" ? `80:localhost:${port}` : `${subdomain}:80:localhost:${port}`;
        const args = ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes"];
        if (validPort(sish.sshPort)) args.push("-p", String(sish.sshPort));
        args.push("-R", remote, server);
        return { command: "ssh", args };
      }
      case "frp": {
        const frp = config.frp;
        if (frp === undefined || frp.server.trim() === "") throw new AppError("TUNNEL_FRP_SERVER", "请填写 frps 服务器地址", 400);
        const binary = await this.ensureBinary("frpc");
        const configPath = await this.writeFrpcConfig(frp, port);
        const [host] = parseHostPort(frp.server, 7000);
        const remotePort = validPort(frp.remotePort) ? frp.remotePort : port;
        return { command: binary, args: ["-c", configPath], constructedUrl: `http://${host}:${remotePort}` };
      }
    }
  }

  private handleLine(instance: TunnelInstance, line: string, plan: SpawnPlan, child: ChildProcess): void {
    this.appendLog(instance, line);
    if (instance.child !== child || (instance.state === "running" && instance.url !== undefined)) return;
    const url = detectTunnelUrl(instance.config.method, line, plan.constructedUrl);
    if (url !== undefined) this.setRunning(instance, url);
  }

  private setRunning(instance: TunnelInstance, url: string): void {
    instance.restartAttempt = 0;
    if (instance.state !== "running" || instance.url !== url) this.logInfo(`穿透就绪: ${url}`);
    instance.state = "running";
    instance.url = url;
    instance.error = undefined;
  }

  private appendLog(instance: TunnelInstance, line: string): void {
    instance.logs = [...instance.logs.slice(-(MAX_LOG_LINES - 1)), { t: Date.now(), line: line.slice(0, MAX_LINE_LENGTH) }];
  }

  private fail(instance: TunnelInstance, message: string): void {
    this.logInfo(`穿透失败: ${message}`);
    instance.state = "error";
    instance.error = message;
    instance.url = undefined;
    instance.pid = undefined;
    instance.child = undefined;
  }

  private handleExit(instance: TunnelInstance, code: number | null, signal: string | null): void {
    instance.child = undefined;
    clearTimeout(instance.urlTimer);
    if (instance.stopping) {
      instance.state = "idle";
      instance.pid = undefined;
      return;
    }
    const reason = signal !== null ? `信号 ${signal}` : `退出码 ${code ?? "?"}`;
    this.logInfo(`穿透进程退出 (${reason})，自动重连中`);
    instance.state = "error";
    instance.error = `隧道已断开（${reason}），正在自动重连…`;
    instance.url = undefined;
    this.scheduleRestart(instance);
  }

  private scheduleRestart(instance: TunnelInstance): void {
    if (instance.stopping) return;
    const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** instance.restartAttempt, RESTART_MAX_DELAY_MS);
    instance.restartAttempt += 1;
    this.logInfo(`将在 ${Math.round(delay / 1000)}s 后重连`);
    instance.restartTimer = setTimeout(() => {
      if (instance.stopping) return;
      void this.spawnTunnel(instance);
    }, delay);
  }

  private async stopProcess(instance: TunnelInstance): Promise<void> {
    instance.stopping = true;
    clearTimeout(instance.restartTimer);
    clearTimeout(instance.urlTimer);
    const child = instance.child;
    instance.child = undefined;
    if (child === undefined || child.pid === undefined) return;
    this.logInfo("停止穿透进程");
    killProcess(child.pid);
    clearTimeout(instance.killTimer);
    instance.killTimer = setTimeout(() => killProcess(child.pid as number, true), 2_000);
  }

  /** 找到可用二进制：PATH → 本地缓存 → 自动下载。 */
  private async ensureBinary(name: "cloudflared" | "frpc"): Promise<string> {
    const exe = platform() === "win32" ? `${name}.exe` : name;
    const localPath = join(this.binDir, exe);
    if (commandAvailable(name)) return name;
    if (await fileExists(localPath)) return localPath;
    this.logInfo(`未找到 ${name}，开始自动下载…`);
    try {
      if (name === "cloudflared") await this.downloadCloudflared(localPath);
      else await this.downloadFrpc(localPath);
      return localPath;
    } catch (error) {
      throw new AppError("TUNNEL_BINARY_MISSING", `缺少 ${name} 且自动下载失败：${asMessage(error)}`, 500);
    }
  }

  private async downloadCloudflared(localPath: string): Promise<void> {
    const os = platform() === "win32" ? "windows" : platform();
    const asset = platform() === "win32"
      ? `cloudflared-windows-${archName()}.exe`
      : `cloudflared-${os}-${archName()}${platform() === "darwin" ? ".tgz" : ""}`;
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
    await this.downloadTo(url, localPath, asset);
  }

  private async downloadFrpc(localPath: string): Promise<void> {
    const response = await fetch("https://api.github.com/repos/fatedier/frp/releases/latest");
    if (!response.ok) throw new Error(`GitHub API 返回 HTTP ${response.status}`);
    const release = await response.json() as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
    const tag = (release.tag_name ?? "v0.61.2").replace(/^v/, "");
    const os = platform() === "win32" ? "windows" : platform();
    const assetName = `frp_${tag}_${os}_${archName()}.${platform() === "win32" ? "zip" : "tar.gz"}`;
    const asset = release.assets?.find((item) => item.name === assetName);
    if (asset?.browser_download_url === undefined) throw new Error(`找不到发布资产 ${assetName}`);
    await this.downloadTo(asset.browser_download_url, localPath, assetName);
  }

  private async downloadTo(url: string, destPath: string, assetName: string): Promise<void> {
    this.logInfo(`下载 ${assetName} …`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(destPath), { recursive: true });
    if (assetName.endsWith(".tgz") || assetName.endsWith(".tar.gz") || assetName.endsWith(".zip")) {
      const dir = join(this.binDir, "tmp-extract");
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, assetName), data);
      await extractArchiveFile(join(dir, assetName), dir);
      const found = await findFile(dir, basename(destPath));
      if (found === undefined) throw new Error(`解压后未找到 ${basename(destPath)}`);
      await writeFile(destPath, await readFile(found));
      await rm(dir, { recursive: true, force: true });
    } else {
      await writeFile(destPath, data);
    }
    if (platform() !== "win32") await chmod(destPath, 0o755);
    this.logInfo(`${assetName} 就绪`);
  }

  private async writeFrpcConfig(frp: TunnelFrpConfig, localPort: number): Promise<string> {
    await mkdir(this.binDir, { recursive: true });
    const stale = await readdir(this.binDir).catch(() => [] as string[]);
    await Promise.all(stale.filter((name) => name.startsWith("frpc-") && name.endsWith(".toml"))
      .map((name) => rm(join(this.binDir, name), { force: true })));
    const [host, hostPort] = parseHostPort(frp.server, 7000);
    const remotePort = validPort(frp.remotePort) ? frp.remotePort : localPort;
    const configPath = join(this.binDir, `frpc-${Date.now()}.toml`);
    await writeFile(configPath, buildFrpcToml(host, hostPort, localPort, remotePort, frp.token?.trim() ?? ""));
    return configPath;
  }
}

/** 从一行日志中解析公网 URL；frp 由 constructedUrl 配合成功标记判定。 */
export function detectTunnelUrl(method: TunnelMethod, line: string, constructedUrl?: string): string | undefined {
  const clean = stripAnsi(line);
  if (constructedUrl !== undefined) {
    return URL_PATTERNS[method].some((pattern) => pattern.test(clean)) ? constructedUrl : undefined;
  }
  for (const pattern of URL_PATTERNS[method]) {
    const match = clean.match(pattern);
    if (match !== null && match[0] !== undefined) return cleanUrl(match[0]);
  }
  return undefined;
}

/** 生成 frpc.toml 配置内容。 */
export function buildFrpcToml(host: string, hostPort: number, localPort: number, remotePort: number, token: string): string {
  const lines = [
    `serverAddr = "${host}"`,
    `serverPort = ${hostPort}`,
    ...(token === "" ? [] : [`auth.token = "${token.replaceAll("\"", "\\\"")}"`]),
    "",
    "[[proxies]]",
    // 代理名带远程端口后缀：同一 frps 上多实例（多设备/多端口）互不撞名
    `name = "jarvis-${remotePort}"`,
    "type = \"tcp\"",
    "localIP = \"127.0.0.1\"",
    `localPort = ${localPort}`,
    `remotePort = ${remotePort}`,
    "",
  ];
  return lines.join("\n");
}

function normalizeMethod(value: unknown): TunnelMethod {
  if (!isTunnelMethod(value)) throw new AppError("TUNNEL_INVALID_METHOD", "未知的穿透方式", 400);
  return value;
}

function normalizeSish(value: { server: string; subdomain?: string; sshPort?: number }): { server: string; subdomain?: string; sshPort?: number } {
  return {
    server: value.server.trim(),
    ...(value.subdomain?.trim() ? { subdomain: value.subdomain.trim() } : {}),
    ...(validPort(value.sshPort) ? { sshPort: value.sshPort } : {}),
  };
}

function normalizeFrp(value: TunnelFrpConfig): TunnelFrpConfig {
  return {
    server: value.server.trim(),
    ...(value.token?.trim() ? { token: value.token.trim() } : {}),
    ...(validPort(value.remotePort) ? { remotePort: value.remotePort } : {}),
    ...(value.domain?.trim() ? { domain: value.domain.trim() } : {}),
  };
}

function legacySish(value: unknown): { server: string; subdomain?: string; sshPort?: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const parsed = value as Record<string, unknown>;
  if (typeof parsed["sish"] !== "object" || parsed["sish"] === null) return undefined;
  const sish = parsed["sish"] as Record<string, unknown>;
  if (typeof sish["server"] !== "string") return undefined;
  return {
    server: sish["server"],
    ...(typeof sish["subdomain"] === "string" && sish["subdomain"] !== "" ? { subdomain: sish["subdomain"] } : {}),
    ...(validPort(sish["sshPort"]) ? { sshPort: sish["sshPort"] as number } : {}),
  };
}

function legacyFrp(value: unknown): TunnelFrpConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const parsed = value as Record<string, unknown>;
  if (typeof parsed["frp"] !== "object" || parsed["frp"] === null) return undefined;
  const frp = parsed["frp"] as Record<string, unknown>;
  if (typeof frp["server"] !== "string") return undefined;
  return {
    server: frp["server"],
    ...(typeof frp["token"] === "string" && frp["token"] !== "" ? { token: frp["token"] } : {}),
    ...(validPort(frp["remotePort"]) ? { remotePort: frp["remotePort"] as number } : {}),
    ...(typeof frp["domain"] === "string" && frp["domain"] !== "" ? { domain: frp["domain"] } : {}),
  };
}

function isEntryConfig(value: unknown): value is TunnelEntryConfig {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry["id"] === "string" && isTunnelMethod(entry["method"]);
}

function parseHostPort(value: string, defaultPort: number): [string, number] {
  const trimmed = value.trim();
  const index = trimmed.lastIndexOf(":");
  if (index > 0) {
    const port = Number(trimmed.slice(index + 1));
    if (validPort(port)) return [trimmed.slice(0, index), port];
  }
  return [trimmed, defaultPort];
}

function killProcess(pid: number, force = false): void {
  try {
    if (platform() === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", force ? "/F" : "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // 进程可能已退出
  }
}

/** 解压下载的归档：zip 走 PowerShell Expand-Archive（Windows）→ 系统 bsdtar → 通用 tar；tar.gz/tgz 走系统 tar。 */
export async function extractArchiveFile(archivePath: string, destDir: string): Promise<void> {
  const name = basename(archivePath);
  if (name.endsWith(".zip")) {
    if (await extractZipArchive(archivePath, destDir)) return;
    throw new Error("解压失败：PowerShell 与系统 tar 均不可用或解压失败");
  }
  // 全部用相对路径（cwd=归档所在目录）：避免 msys 系 GNU tar 把 "C:\\..." 解析为 rsh 主机
  const result = spawnSync("tar", ["-xf", name, "-C", relative(dirname(archivePath), destDir) || "."], { cwd: dirname(archivePath), stdio: "ignore", windowsHide: true });
  if (result.error !== undefined || result.status !== 0) throw new Error("解压失败（系统 tar 不可用）");
}

/** zip 解压：Windows 上优先 PowerShell Expand-Archive（不受 PATH 中 GNU tar 影响），失败后回退系统 tar。 */
async function extractZipArchive(archivePath: string, destDir: string): Promise<boolean> {
  if (platform() === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      `Expand-Archive -LiteralPath ${quotePs(archivePath)} -DestinationPath ${quotePs(destDir)} -Force -ErrorAction Stop`,
    ], { stdio: "ignore", windowsHide: true });
    if (result.error === undefined && result.status === 0) return true;
  }
  const name = basename(archivePath);
  const systemRoot = process.env["SystemRoot"];
  const candidates = [
    ...(platform() === "win32" && systemRoot !== undefined ? [join(systemRoot, "System32", "tar.exe")] : []),
    "tar",
  ];
  for (const bin of candidates) {
    const result = spawnSync(bin, ["-xf", name, "-C", relative(dirname(archivePath), destDir) || "."], { cwd: dirname(archivePath), stdio: "ignore", windowsHide: true });
    if (result.error === undefined && result.status === 0) return true;
  }
  return false;
}

/** PowerShell 单引号字符串转义。 */
function quotePs(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function commandAvailable(command: string): boolean {
  const flags = VERSION_FLAGS[command];
  if (flags === undefined) return true;
  const result = spawnSync(command, flags, { stdio: "ignore", timeout: 5_000, windowsHide: true });
  return result.error === undefined && result.status === 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile();
  } catch {
    return false;
  }
}

async function findFile(root: string, name: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found !== undefined) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return undefined;
}

function archName(): string {
  return process.arch === "x64" ? "amd64" : process.arch;
}

function createLineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let pending = "";
  return (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "").trimEnd();
      if (trimmed !== "") onLine(trimmed);
    }
  };
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function cleanUrl(value: string): string {
  return value.replace(/[),.;]+$/, "");
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isTunnelMethod(value: unknown): value is TunnelMethod {
  return typeof value === "string" && (TUNNEL_METHODS as readonly string[]).includes(value);
}
