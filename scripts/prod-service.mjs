import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const entry = join(root, "dist", "server", "server", "index.js");

export function productionPort() {
  const port = Number(process.env["JARVIS_PORT"] ?? process.env["PORT"] ?? 9528);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`无效端口：${String(process.env["JARVIS_PORT"] ?? process.env["PORT"])}`);
  }
  return port;
}

export function runtimePaths(port) {
  const runtimeDir = join(root, ".runtime");
  return {
    runtimeDir,
    pidFile: join(runtimeDir, `jarvis-production-${port}.pid`),
    logFile: join(root, "logs", `prod-${port}.log`),
  };
}

export function ensureRuntimeDirectories(port) {
  const { runtimeDir } = runtimePaths(port);
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(dirname(runtimePaths(port).logFile), { recursive: true });
}

export function readPidRecord(pidFile) {
  try {
    const lines = readFileSync(pidFile, "utf8").trim().split(/\r?\n/);
    const pid = Number(lines[0]);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return { pid, host: lines[1] || undefined };
  } catch {
    return undefined;
  }
}

export function readPid(pidFile) {
  return readPidRecord(pidFile)?.pid;
}

export function removePidFile(pidFile) {
  try { rmSync(pidFile, { force: true }); } catch { /* best effort */ }
}

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function commandLineFor(pid) {
  if (!processExists(pid)) return undefined;

  try {
    if (process.platform === "win32") {
      const script = `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $process) { [Console]::Out.Write($process.CommandLine) }`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5_000 });
      return stdout.trim() || undefined;
    }

    const procCmdline = `/proc/${pid}/cmdline`;
    if (existsSync(procCmdline)) return readFileSync(procCmdline, "utf8").replaceAll("\0", " ").trim() || undefined;
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="], { timeout: 5_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function isJarvisServerProcess(pid) {
  const commandLine = await commandLineFor(pid);
  return commandLine?.replaceAll("\\", "/").includes("dist/server/server/index.js") ?? false;
}

function listenerPidFromProc(port) {
  const portHex = port.toString(16).padStart(4, "0").toUpperCase();
  const socketInodes = new Set();

  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields[1]?.endsWith(`:${portHex}`) && fields[3] === "0A" && fields[9] !== undefined) {
          socketInodes.add(fields[9]);
        }
      }
    } catch {
      // This procfs table is unavailable on non-Linux platforms.
    }
  }

  if (socketInodes.size === 0) return undefined;
  try {
    for (const directory of readdirSync("/proc", { withFileTypes: true })) {
      if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) continue;
      try {
        for (const fd of readdirSync(`/proc/${directory.name}/fd`)) {
          const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${directory.name}/fd/${fd}`));
          if (match !== null && socketInodes.has(match[1])) return Number(directory.name);
        }
      } catch {
        // Processes can exit or deny fd inspection while we scan.
      }
    }
  } catch {
    // procfs is not mounted or cannot be read.
  }
  return undefined;
}

export async function listenerPid(port) {
  if (process.platform === "win32") {
    try {
      const script = `$connection = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $connection) { [Console]::Out.Write([string]$connection.OwningProcess) }`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5_000 });
      const pid = Number(stdout.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { timeout: 5_000 });
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  } catch {
    // Minimal Linux installations may not ship lsof; use procfs below.
  }
  return listenerPidFromProc(port);
}

export async function isJarvisServerListeningOn(pid, port) {
  return (await listenerPid(port)) === pid && await isJarvisServerProcess(pid);
}

export function healthUrl(port, host = process.env["HOST"]) {
  const effectiveHost = host === undefined || host === "0.0.0.0"
    ? "127.0.0.1"
    : host === "::"
      ? "::1"
      : host;
  const authority = effectiveHost.includes(":") && !effectiveHost.startsWith("[") ? `[${effectiveHost}]` : effectiveHost;
  return `http://${authority}:${port}/api/health`;
}

export async function healthCheck(port, timeoutMs = 1_500, host) {
  const hosts = host === undefined
    ? [process.env["HOST"], "127.0.0.1", "::1", "localhost"]
    : [host];
  for (const candidate of new Set(hosts.filter((value) => value !== undefined && value !== ""))) {
    try {
      const response = await fetch(healthUrl(port, candidate), { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return true;
    } catch {
      // Try the next local address.
    }
  }
  return false;
}

export async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheck(port)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  return false;
}

export async function requestProcessStop(pid) {
  if (process.platform === "win32") {
    // Windows cannot deliver SIGTERM to a detached Node process tree.
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    return;
  }
  process.kill(pid, "SIGTERM");
}

export async function forceProcessStop(pid) {
  if (process.platform === "win32") {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    return;
  }
  process.kill(pid, "SIGKILL");
}

export async function waitForExit(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  return !processExists(pid);
}

export function startServer(port, stdoutFd, stderrFd) {
  return spawn(process.execPath, [entry], {
    cwd: root,
    detached: true,
    windowsHide: true,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOST: process.env["HOST"] ?? "0.0.0.0" },
    stdio: ["ignore", stdoutFd, stderrFd],
  });
}
