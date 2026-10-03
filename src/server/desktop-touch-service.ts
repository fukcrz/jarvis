import { execFile, fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DESKTOP_TOUCH_MCP_PORT = 23_847;
const STARTUP_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

type ServiceLogger = (message: string, error?: unknown) => void;
type HealthFetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface DesktopTouchServiceOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  locateRuntime?: (env: NodeJS.ProcessEnv) => Promise<{ entry: string; cwd: string } | undefined>;
  forkProcess?: (modulePath: string, args: readonly string[], options: ForkOptions) => ChildProcess;
  fetchHealth?: HealthFetcher;
  stopWindowsProcessTree?: (pid: number) => Promise<void>;
  port?: number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  logger?: ServiceLogger;
}

export class DesktopTouchService {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly executablePath: string;
  private readonly locateRuntime: NonNullable<DesktopTouchServiceOptions["locateRuntime"]>;
  private readonly forkProcess: NonNullable<DesktopTouchServiceOptions["forkProcess"]>;
  private readonly fetchHealth: HealthFetcher;
  private readonly stopWindowsProcessTree: (pid: number) => Promise<void>;
  private readonly port: number;
  private readonly healthUrl: string;
  private readonly mcpUrl: string;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger: ServiceLogger;
  private child: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private owned = false;

  constructor(options: DesktopTouchServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.executablePath = options.executablePath ?? process.execPath;
    this.locateRuntime = options.locateRuntime ?? locateDesktopTouchRuntime;
    this.forkProcess = options.forkProcess ?? fork;
    this.fetchHealth = options.fetchHealth ?? fetch;
    this.stopWindowsProcessTree = options.stopWindowsProcessTree ?? stopWindowsProcessTree;
    this.port = options.port ?? DESKTOP_TOUCH_MCP_PORT;
    this.healthUrl = `http://127.0.0.1:${this.port}/health`;
    this.mcpUrl = `http://127.0.0.1:${this.port}/mcp`;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.logger = options.logger ?? (() => undefined);
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    return this.startPromise;
  }

  async dispose(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    await this.stopOwnedProcess();
  }

  private async startOnce(): Promise<void> {
    if (this.platform !== "win32") return;
    if (await this.isHealthy()) {
      this.logger(`Using existing desktop-touch MCP service at ${this.mcpUrl}`);
      return;
    }

    const runtime = await this.locateRuntime(this.env);
    if (!runtime) {
      this.logger("desktop-touch runtime was not found; desktop tools are unavailable");
      return;
    }

    const preload = childProcessPreload();
    const child = this.forkProcess(runtime.entry, ["--http", "--port", String(this.port)], {
      cwd: runtime.cwd,
      env: {
        ...this.env,
        ...(preload === undefined ? {} : {
          NODE_OPTIONS: appendNodeOption(this.env["NODE_OPTIONS"], preload),
        }),
        DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE: "1",
        DESKTOP_TOUCH_REQUIRE_DESTINATION: "1",
      },
      execPath: this.executablePath,
      execArgv: [],
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child = child;
    this.owned = true;
    let processError: Error | undefined;
    child.on("error", (error) => { processError = error; });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.logger(String(chunk).trim());
    });

    const deadline = Date.now() + this.startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        if (processError) throw new Error(`Could not start desktop-touch MCP: ${processError.message}`);
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`desktop-touch MCP exited before becoming ready (code ${String(child.exitCode)})`);
        }
        if (await this.isHealthy()) {
          this.logger(`Started shared desktop-touch MCP service at ${this.mcpUrl}`);
          return;
        }
        await delay(this.pollIntervalMs);
      }
      throw new Error(`desktop-touch MCP did not become healthy at ${this.healthUrl}`);
    } catch (error) {
      await this.stopOwnedProcess();
      throw error;
    }
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetchHealth(this.healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return typeof body === "object" && body !== null && "name" in body && body.name === "desktop-touch-mcp";
    } catch {
      return false;
    }
  }

  private async stopOwnedProcess(): Promise<void> {
    const child = this.child;
    if (!this.owned || child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    this.owned = false;

    if (child.connected) child.disconnect();
    else child.kill("SIGTERM");
    await waitForChildExit(child, this.shutdownTimeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) return;

    if (this.platform === "win32") {
      await this.stopWindowsProcessTree(child.pid).catch((error: unknown) => {
        this.logger("Could not stop the desktop-touch process tree", error);
      });
      return;
    }
    child.kill("SIGKILL");
  }
}

export async function locateDesktopTouchRuntime(env: NodeJS.ProcessEnv = process.env): Promise<{ entry: string; cwd: string } | undefined> {
  const configuredPath = env["DESKTOP_TOUCH_RUNTIME_PATH"]?.trim();
  if (configuredPath) {
    const candidate = resolve(configuredPath);
    const entry = candidate.toLowerCase().endsWith(".js") ? candidate : join(candidate, "dist", "index.js");
    return existsSync(entry) ? { entry, cwd: dirname(dirname(entry)) } : undefined;
  }

  const localAppData = env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const installRoot = join(localAppData, "pi-desktop-touch");
  let directories: string[];
  try {
    directories = (await readdir(installRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^runtime-v.+-complete$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return undefined;
  }

  for (const directory of directories) {
    const cwd = join(installRoot, directory);
    const entry = join(cwd, "dist", "index.js");
    if (existsSync(entry)) return { entry, cwd };
  }
  return undefined;
}

function childProcessPreload(): string | undefined {
  const adjacent = new URL("./windows-child-process-preload.js", import.meta.url);
  if (existsSync(fileURLToPath(adjacent))) return adjacent.href;
  const built = new URL("../../dist/server/server/windows-child-process-preload.js", import.meta.url);
  return existsSync(fileURLToPath(built)) ? built.href : undefined;
}

function appendNodeOption(options: string | undefined, preload: string): string {
  const option = `--import=${preload}`;
  if (options?.includes(preload)) return options;
  return [options?.trim(), option].filter(Boolean).join(" ");
}

async function stopWindowsProcessTree(pid: number): Promise<void> {
  await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    timeout: 10_000,
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
