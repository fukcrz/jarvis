import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

// This process owns the command tree even if the Jarvis server disappears unexpectedly.
// It is started with IPC and piped stdio; neither it nor its shell inherits a console.
if (process.send === undefined) throw new Error("Background task runner requires IPC");
const [cwd, command] = process.argv.slice(2);
if (!cwd || !command) throw new Error("Background task runner requires cwd and command");

let child: ChildProcess | undefined;
let stopping = false;
let childExited = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  const pid = child?.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000,
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* The process group already exited. */ }
  }
}

process.on("message", (message: unknown) => {
  if (typeof message === "object" && message !== null && "type" in message && message.type === "stop") stop();
});
process.on("disconnect", () => {
  if (childExited) return;
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => { stop(); process.exit(0); });

const shell = process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : "/bin/sh";
// On Windows, command is a private .cmd file. Passing arbitrary quoted command
// text through `cmd /c` changes its argument boundaries before the shell sees it.
const args = process.platform === "win32" ? ["/d", "/c", command] : ["-c", command];
child = spawn(shell, args, {
  cwd,
  detached: process.platform !== "win32",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);
child.on("error", (error) => {
  process.send?.({ type: "error", message: error.message });
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  childExited = true;
  child = undefined;
  process.send?.({ type: "exit", code, signal }, () => { if (process.connected) process.disconnect(); });
  process.exitCode = stopping ? 0 : (code ?? 1);
});
if (child.pid !== undefined) process.send({ type: "started", pid: child.pid });
