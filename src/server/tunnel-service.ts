import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TunnelConfig, TunnelFrpConfig, TunnelLogEntry, TunnelMethod, TunnelStatus } from "../shared/protocol.js";
import { TUNNEL_METHODS } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";

const CONFIG_VERSION = 1;
const MAX_LOG_LINES = 300;
const MAX_LINE_LENGTH = 400;
const RESTART_BASE_DELAY_MS = 3_000;
const RESTART_MAX_DELAY_MS = 30_000;
/** frp 无 URL 日志，进程存活一段时间即视为运行 */
const FRP_READY_DELAY_MS = 2_000;

const URL_PATTERNS: Record<TunnelMethod, RegExp[]> = {
  cloudflared: [/https:\/\/[a-z0-9-]+\.trycloudflare\.com/],
  localtunnel: [/https:\/\/[^\s]+\.loca\.lt/],
  ssh: [/https:\/\/[^\s]+\.(?:lhr\.life|lhr\.rocks)/],
  sish: [/https:\/\/[^\s]+/],
  frp: [/start proxy success/i],
};

const VERSION_FLAGS: Record<string, string[]> = {
  cloudflared: ["--version"],
  frpc: ["-v"],
  ssh: ["-V"],
};

interface SpawnPlan {
  command: string;
  args: string[];
  /** frp 等无 URL 日志的方式：由配置构造公网地址 */
  constructedUrl?: string;
}

type TunnelConfigPatch = Partial<Pick<TunnelConfig, "enabled" | "method" | "port" | "sish" | "frp">>;

/** 内网穿透：子进程管理、自动下载二进制、URL 解析、断线重连、配置持久化。 */
export class TunnelService {
  private readonly configPath: string;
  private readonly binDir: string;
  private config: TunnelConfig = { enabled: false, method: "cloudflared", port: 0 };
  private status: TunnelStatus = { state: "idle", logs: [] };
  private defaultPort = 0;
  private child: ChildProcess | undefined;
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private urlTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(private readonly logInfo: (message: string) => void = () => undefined) {
    const home = process.env["JARVIS_HOME"] ?? join(homedir(), ".jarvis");
    this.configPath = join(home, "tunnel.json");
    this.binDir = join(home, "bin");
  }

  /** listen 之后调用：注入服务端口；若开启了自动穿透则直接拉起。 */
  async initialize(defaultPort: number): Promise<void> {
    this.defaultPort = defaultPort;
    const envPort = Number(process.env["JARVIS_TUNNEL_PORT"]);
    if (validPort(envPort)) this.defaultPort = envPort;
    await this.loadConfig().catch((error) => this.logInfo(`读取穿透配置失败: ${asMessage(error)}`));
    if (this.config.enabled) {
      this.logInfo("自动穿透已开启，正在启动隧道");
      void this.start().catch((error) => this.logInfo(`自动穿透启动失败: ${asMessage(error)}`));
    }
  }

  getConfig(): TunnelConfig {
    return { ...this.config, port: this.effectivePort() };
  }

  getStatus(): TunnelStatus {
    return this.status;
  }

  /** 启动穿透并持久化方法/端口配置（不改变 enabled）。 */
  async start(patch?: TunnelConfigPatch): Promise<TunnelStatus> {
    this.applyPatch(patch);
    await this.persist();
    await this.spawnTunnel();
    return this.status;
  }

  /** 停止穿透（不改变 enabled，自动穿透开关独立控制）。 */
  async stop(): Promise<TunnelStatus> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.urlTimer);
    await this.stopProcess();
    this.status = { state: "idle", method: this.status.method, port: this.effectivePort(), logs: this.status.logs.slice(-MAX_LOG_LINES) };
    return this.status;
  }

  /** 更新配置并持久化；enabled=true 时按新配置启动/重启，false 时停止。 */
  async updateSettings(patch: TunnelConfigPatch): Promise<TunnelStatus> {
    const next: TunnelConfig = { ...this.config };
    if (patch.method !== undefined) {
      if (!isTunnelMethod(patch.method)) throw new AppError("TUNNEL_INVALID_METHOD", "未知的穿透方式", 400);
      next.method = patch.method;
    }
    if (patch.port !== undefined) {
      if (!validPort(patch.port)) throw new AppError("TUNNEL_INVALID_PORT", "目标端口必须在 1-65535 之间", 400);
      next.port = patch.port;
    }
    if (patch.sish !== undefined) next.sish = patch.sish;
    if (patch.frp !== undefined) next.frp = patch.frp;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    const configChanged = JSON.stringify({ method: next.method, port: next.port, sish: next.sish, frp: next.frp })
      !== JSON.stringify({ method: this.config.method, port: this.config.port, sish: this.config.sish, frp: this.config.frp });
    this.config = next;
    await this.persist();
    if (this.config.enabled) {
      if (this.status.state === "idle" || this.status.state === "error" || configChanged) await this.spawnTunnel();
    } else if (this.status.state !== "idle") {
      this.stopping = true;
      clearTimeout(this.restartTimer);
      clearTimeout(this.urlTimer);
      await this.stopProcess();
      this.status = { state: "idle", method: this.status.method, port: this.effectivePort(), logs: this.status.logs.slice(-MAX_LOG_LINES) };
    }
    return this.status;
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.urlTimer);
    clearTimeout(this.killTimer);
    await this.stopProcess();
  }

  private effectivePort(): number {
    return this.config.port > 0 ? this.config.port : this.defaultPort;
  }

  private applyPatch(patch: TunnelConfigPatch | undefined): void {
    if (patch === undefined) return;
    const next: TunnelConfig = { ...this.config };
    if (patch.method !== undefined && isTunnelMethod(patch.method)) next.method = patch.method;
    if (patch.port !== undefined && validPort(patch.port)) next.port = patch.port;
    if (patch.sish !== undefined) next.sish = patch.sish;
    if (patch.frp !== undefined) next.frp = patch.frp;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    this.config = next;
  }

  private async loadConfig(): Promise<void> {
    const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<TunnelConfig & { version: number }>;
    if (parsed.version !== CONFIG_VERSION || !isTunnelMethod(parsed.method)) throw new Error("Unsupported tunnel config");
    this.config = {
      enabled: parsed.enabled === true,
      method: parsed.method,
      port: validPort(parsed.port) ? parsed.port : 0,
      sish: parsed.sish,
      frp: parsed.frp,
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify({ version: CONFIG_VERSION, ...this.config }, null, 2));
  }

  private async spawnTunnel(): Promise<void> {
    await this.stopProcess();
    this.stopping = false;
    this.restartAttempt = 0;
    const method = this.config.method;
    const port = this.effectivePort();
    if (port <= 0) {
      this.fail("未设置目标端口");
      return;
    }
    this.status = { state: "starting", method, port, startedAt: Date.now(), logs: this.status.logs.slice(-MAX_LOG_LINES) };
    let plan: SpawnPlan;
    try {
      plan = await this.buildPlan(port);
    } catch (error) {
      this.fail(asMessage(error));
      return;
    }
    this.logInfo(`启动穿透: ${method} → localhost:${port}`);
    const child = spawn(plan.command, plan.args, { detached: platform() !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.status = { ...this.status, pid: child.pid };
    const splitter = createLineSplitter((line) => this.handleLine(line, plan, child));
    child.stdout?.on("data", splitter);
    child.stderr?.on("data", splitter);
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.fail(`无法启动 ${plan.command}: ${asMessage(error)}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.handleExit(code, signal);
    });
    if (plan.constructedUrl !== undefined) {
      this.urlTimer = setTimeout(() => {
        if (this.child === child && this.status.state === "starting") this.setRunning(plan.constructedUrl as string);
      }, FRP_READY_DELAY_MS);
    }
  }

  private async buildPlan(port: number): Promise<SpawnPlan> {
    switch (this.config.method) {
      case "cloudflared": {
        const binary = await this.ensureBinary("cloudflared");
        return { command: binary, args: ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--metrics", "127.0.0.1:0"] };
      }
      case "localtunnel": {
        const npx = platform() === "win32" ? "npx.cmd" : "npx";
        return { command: npx, args: ["--yes", "localtunnel", "--port", String(port)] };
      }
      case "ssh": {
        return {
          command: "ssh",
          args: ["-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes", "-R", `80:localhost:${port}`, "nokey@localhost.run"],
        };
      }
      case "sish": {
        const sish = this.config.sish;
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
        const frp = this.config.frp;
        if (frp === undefined || frp.server.trim() === "") throw new AppError("TUNNEL_FRP_SERVER", "请填写 frps 服务器地址", 400);
        const binary = await this.ensureBinary("frpc");
        const configPath = await this.writeFrpcConfig(frp, port);
        const [host] = parseHostPort(frp.server, 7000);
        const remotePort = validPort(frp.remotePort) ? frp.remotePort : port;
        return { command: binary, args: ["-c", configPath], constructedUrl: `http://${host}:${remotePort}` };
      }
    }
  }

  private handleLine(line: string, plan: SpawnPlan, child: ChildProcess): void {
    this.appendLog(line);
    if (this.child !== child || (this.status.state === "running" && this.status.url !== undefined)) return;
    const url = detectTunnelUrl(this.config.method, line, plan.constructedUrl);
    if (url !== undefined) this.setRunning(url);
  }

  private setRunning(url: string): void {
    this.restartAttempt = 0;
    if (this.status.state !== "running" || this.status.url !== url) this.logInfo(`穿透就绪: ${url}`);
    this.status = { ...this.status, state: "running", url, error: undefined };
  }

  private appendLog(line: string): void {
    const entry: TunnelLogEntry = { t: Date.now(), line: line.slice(0, MAX_LINE_LENGTH) };
    this.status = { ...this.status, logs: [...this.status.logs.slice(-(MAX_LOG_LINES - 1)), entry] };
  }

  private fail(message: string): void {
    this.logInfo(`穿透失败: ${message}`);
    this.status = { ...this.status, state: "error", error: message, url: undefined, pid: undefined };
    this.child = undefined;
  }

  private handleExit(code: number | null, signal: string | null): void {
    this.child = undefined;
    clearTimeout(this.urlTimer);
    if (this.stopping) {
      this.status = { state: "idle", method: this.status.method, port: this.effectivePort(), logs: this.status.logs.slice(-MAX_LOG_LINES) };
      return;
    }
    const reason = signal !== null ? `信号 ${signal}` : `退出码 ${code ?? "?"}`;
    this.logInfo(`穿透进程退出 (${reason})，自动重连中`);
    this.status = { ...this.status, state: "error", error: `隧道已断开（${reason}），正在自动重连…`, url: undefined };
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** this.restartAttempt, RESTART_MAX_DELAY_MS);
    this.restartAttempt += 1;
    this.logInfo(`将在 ${Math.round(delay / 1000)}s 后重连`);
    this.restartTimer = setTimeout(() => {
      if (this.stopping) return;
      void this.spawnTunnel();
    }, delay);
  }

  private async stopProcess(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.urlTimer);
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.pid === undefined) return;
    this.logInfo("停止穿透进程");
    killProcess(child.pid);
    clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => killProcess(child.pid as number, true), 2_000);
  }

  /** 找到可用二进制：PATH → 本地缓存 → 自动下载。 */
  private async ensureBinary(name: "cloudflared" | "frpc"): Promise<string> {
    const exe = platform() === "win32" ? `${name}.exe` : name;
    const localPath = join(this.binDir, exe);
    if (commandAvailable(name)) return name;
    if (await fileExists(localPath)) return localPath;
    this.appendLog(`未找到 ${name}，开始自动下载…`);
    try {
      if (name === "cloudflared") await this.downloadCloudflared(localPath);
      else await this.downloadFrpc(localPath);
      return localPath;
    } catch (error) {
      this.appendLog(`自动下载 ${name} 失败: ${asMessage(error)}`);
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
    this.appendLog(`下载 ${assetName} …`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载失败 (HTTP ${response.status})`);
    const data = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(destPath), { recursive: true });
    if (assetName.endsWith(".tgz") || assetName.endsWith(".tar.gz") || assetName.endsWith(".zip")) {
      const dir = join(this.binDir, "tmp-extract");
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, assetName), data);
      const result = spawnSync("tar", ["-xf", assetName, "-C", dir], { cwd: dir, stdio: "ignore", windowsHide: true });
      if (result.error !== undefined || result.status !== 0) throw new Error("解压失败（系统 tar 不可用）");
      const found = await findFile(dir, basename(destPath));
      if (found === undefined) throw new Error(`解压后未找到 ${basename(destPath)}`);
      await writeFile(destPath, await readFile(found));
      await rm(dir, { recursive: true, force: true });
    } else {
      await writeFile(destPath, data);
    }
    if (platform() !== "win32") await chmod(destPath, 0o755);
    this.appendLog(`${assetName} 就绪`);
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
    "name = \"jarvis\"",
    "type = \"tcp\"",
    "localIP = \"127.0.0.1\"",
    `localPort = ${localPort}`,
    `remotePort = ${remotePort}`,
    "",
  ];
  return lines.join("\n");
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

function archName(): string {
  return process.arch === "x64" ? "amd64" : process.arch;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isTunnelMethod(value: unknown): value is TunnelMethod {
  return typeof value === "string" && (TUNNEL_METHODS as readonly string[]).includes(value);
}
