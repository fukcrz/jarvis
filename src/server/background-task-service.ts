import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackgroundTaskSnapshot } from "../shared/protocol.js";
import { AppError, asMessage } from "./errors.js";
import type { WorkspaceStore } from "./workspace-store.js";

interface Task extends BackgroundTaskSnapshot {
  runner?: ChildProcess;
  logStream?: WriteStream;
  logPath: string;
  commandScriptPath?: string;
  logClosed?: Promise<void>;
  closePromise?: Promise<void>;
  starting?: Promise<void>;
}

const RUNNER_PATH = fileURLToPath(new URL("./background-task-runner.js", import.meta.url));
const SOURCE_RUNNER_PATH = fileURLToPath(new URL("./background-task-runner.ts", import.meta.url));
const LOG_BYTES = 64 * 1024;

function runnerInvocation(cwd: string, command: string): [string, string[]] {
  if (existsSync(RUNNER_PATH)) return [process.execPath, [RUNNER_PATH, cwd, command]];
  if (!existsSync(SOURCE_RUNNER_PATH)) throw new Error("Background task runner is not installed");
  let tsxCli: string;
  try {
    tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  } catch {
    throw new Error("Source-mode background tasks require the tsx package");
  }
  return [process.execPath, [tsxCli, SOURCE_RUNNER_PATH, cwd, command]];
}

export class BackgroundTaskService {
  private readonly tasks = new Map<string, Task>();
  private readonly closingWorkspaces = new Set<string>();
  private logDirPromise?: Promise<string>;
  private closing = false;

  constructor(private readonly workspaces: WorkspaceStore) {}

  list(workspaceId: string): BackgroundTaskSnapshot[] {
    this.workspaces.get(workspaceId);
    return [...this.tasks.values()].filter((task) => task.workspaceId === workspaceId).map((task) => this.snapshot(task));
  }

  async start(workspaceId: string, command: string, cwd?: string): Promise<BackgroundTaskSnapshot> {
    this.assertAcceptingTasks(workspaceId);
    const value = command.trim();
    if (!value) throw new AppError("TASK_COMMAND_EMPTY", "Command cannot be empty", 400);
    const root = await realpath(this.workspaces.get(workspaceId).cwd);
    const directory = await realpath(resolve(root, cwd ?? ".")).catch(() => {
      throw new AppError("TASK_CWD_INVALID", "Working directory does not exist", 400);
    });
    const subpath = relative(root, directory);
    if (subpath === ".." || subpath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(subpath)) {
      throw new AppError("TASK_CWD_INVALID", "Working directory must be inside the workspace", 400);
    }
    const logDir = await (this.logDirPromise ??= mkdtemp(join(tmpdir(), "jarvis-background-tasks-")));
    this.assertAcceptingTasks(workspaceId);
    if ([...this.tasks.values()].some((task) => task.workspaceId === workspaceId && task.cwd === directory && task.command === value && (task.state === "starting" || task.state === "running" || task.state === "stopping"))) {
      throw new AppError("TASK_ALREADY_RUNNING", "This command is already running in this workspace", 409);
    }
    const id = randomUUID();
    const task: Task = { id, workspaceId, command: value, cwd: directory, state: "starting", startedAt: new Date().toISOString(), logPath: join(logDir, `${id}.log`) };
    this.tasks.set(id, task);
    try {
      await this.launch(task);
    } catch (error) {
      task.state = "failed";
      task.error = asMessage(error);
      task.endedAt = new Date().toISOString();
      throw error;
    }
    return this.snapshot(task);
  }

  async restart(workspaceId: string, taskId: string): Promise<BackgroundTaskSnapshot> {
    this.assertAcceptingTasks(workspaceId);
    const task = this.get(workspaceId, taskId);
    if (task.state === "starting" || task.state === "running" || task.state === "stopping") await this.stop(workspaceId, taskId);
    await task.logClosed;
    this.assertAcceptingTasks(workspaceId);
    task.state = "starting";
    task.startedAt = new Date().toISOString();
    delete task.endedAt;
    delete task.pid;
    delete task.exitCode;
    delete task.error;
    task.runner = undefined;
    task.logStream = undefined;
    task.logClosed = undefined;
    task.closePromise = undefined;
    try {
      await this.launch(task);
    } catch (error) {
      task.state = "failed";
      task.error = asMessage(error);
      task.endedAt = new Date().toISOString();
      throw error;
    }
    return this.snapshot(task);
  }

  async stop(workspaceId: string, taskId: string): Promise<BackgroundTaskSnapshot> {
    const task = this.get(workspaceId, taskId);
    if (task.state !== "starting" && task.state !== "running" && task.state !== "stopping") return this.snapshot(task);
    task.state = "stopping";
    await task.starting?.catch(() => undefined);
    const runner = task.runner;
    if (runner?.exitCode === null && runner.signalCode === null) {
      if (runner.connected) runner.send({ type: "stop" }, (error) => { if (error) this.killRunner(runner); });
      else this.killRunner(runner);
      const closed = task.closePromise;
      if (closed !== undefined) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([closed, new Promise<void>((done) => { timeout = setTimeout(done, 6_000); })]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      }
      if (runner.exitCode === null && runner.signalCode === null) {
        this.killRunner(runner);
        await closed;
      }
    }
    task.state = "stopped";
    task.endedAt ??= new Date().toISOString();
    return this.snapshot(task);
  }

  async logs(workspaceId: string, taskId: string): Promise<{ task: BackgroundTaskSnapshot; output: string }> {
    const task = this.get(workspaceId, taskId);
    const file = await open(task.logPath, "r").catch(() => undefined);
    if (!file) return { task: this.snapshot(task), output: "" };
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, LOG_BYTES);
      const bytes = Buffer.alloc(length);
      await file.read(bytes, 0, length, size - length);
      return { task: this.snapshot(task), output: `${size > length ? "[showing last 64KB]\n" : ""}${bytes.toString("utf8")}` };
    } finally {
      await file.close();
    }
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    this.closingWorkspaces.add(workspaceId);
    const tasks = [...this.tasks.values()].filter((task) => task.workspaceId === workspaceId);
    await Promise.all(tasks.map((task) => this.stop(workspaceId, task.id)));
    await Promise.all(tasks.map((task) => task.logClosed));
    await Promise.all(tasks.map(async (task) => {
      if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
      await rm(task.logPath, { force: true });
      if (task.commandScriptPath !== undefined) await rm(task.commandScriptPath, { force: true });
    }));
  }

  resumeWorkspace(workspaceId: string): void {
    this.closingWorkspaces.delete(workspaceId);
  }

  async dispose(): Promise<void> {
    this.closing = true;
    const tasks = [...this.tasks.values()];
    await Promise.all(tasks.map((task) => this.stop(task.workspaceId, task.id)));
    await Promise.all(tasks.map((task) => task.logClosed));
    this.tasks.clear();
    if (this.logDirPromise) await rm(await this.logDirPromise, { recursive: true, force: true });
  }

  private assertAcceptingTasks(workspaceId: string): void {
    if (this.closing) throw new AppError("TASK_CLOSING", "Jarvis is shutting down", 409);
    if (this.closingWorkspaces.has(workspaceId)) throw new AppError("TASK_WORKSPACE_CLOSING", "Workspace is being removed", 409);
  }

  private get(workspaceId: string, taskId: string): Task {
    this.workspaces.get(workspaceId);
    const task = this.tasks.get(taskId);
    if (task?.workspaceId !== workspaceId) throw new AppError("TASK_NOT_FOUND", "Task not found", 404);
    return task;
  }

  private snapshot(task: Task): BackgroundTaskSnapshot {
    return {
      id: task.id, workspaceId: task.workspaceId, cwd: task.cwd, command: task.command,
      state: task.state, startedAt: task.startedAt,
      ...(task.pid === undefined ? {} : { pid: task.pid }),
      ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(task.error === undefined ? {} : { error: task.error }),
    };
  }

  private async launch(task: Task): Promise<void> {
    let started!: () => void;
    let failed!: (error: Error) => void;
    task.starting = new Promise<void>((resolveStart, rejectStart) => { started = resolveStart; failed = rejectStart; });
    void task.starting.catch(() => undefined);
    try {
      const commandArg = await this.prepareCommand(task);
      const [runnerExecutable, runnerArgs] = runnerInvocation(task.cwd, commandArg);
      task.logStream = createWriteStream(task.logPath, { flags: "a" });
      task.logClosed = new Promise<void>((done) => task.logStream?.once("close", done));
      task.logStream.on("error", (error) => { task.error = error.message; });
      const runner = spawn(runnerExecutable, runnerArgs, {
        cwd: task.cwd,
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      task.runner = runner;
      runner.stdout?.pipe(task.logStream, { end: false });
      runner.stderr?.pipe(task.logStream, { end: false });
      task.closePromise = new Promise<void>((done) => {
        runner.once("close", (code) => {
          task.endedAt = new Date().toISOString();
          if (task.state !== "stopping" && task.state !== "stopped") task.state = (task.exitCode ?? code) === 0 ? "exited" : "failed";
          if (task.state === "failed" && task.error === undefined) task.error = `Runner exited with code ${String(code)}`;
          task.logStream?.end();
          failed(new Error(task.error ?? "Background task exited before starting"));
          done();
        });
      });
      runner.on("message", (message: unknown) => {
        if (typeof message !== "object" || message === null || !("type" in message)) return;
        if (message.type === "started" && "pid" in message && typeof message.pid === "number") {
          task.pid = message.pid;
          if (task.state === "starting") task.state = "running";
          started();
        } else if (message.type === "exit" && "code" in message) {
          task.exitCode = typeof message.code === "number" ? message.code : undefined;
        } else if (message.type === "error" && "message" in message && typeof message.message === "string") {
          task.error = message.message;
        }
      });
      runner.once("error", (error) => {
        task.error = error.message;
        task.logStream?.end();
        failed(error);
      });
      const timer = setTimeout(() => {
        failed(new Error("Background task did not start"));
        this.killRunner(runner);
      }, 5_000);
      try { await task.starting; } finally { clearTimeout(timer); }
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async prepareCommand(task: Task): Promise<string> {
    if (process.platform !== "win32") return task.command;
    const commandScriptPath = `${task.logPath}.cmd`;
    await writeFile(commandScriptPath, [
      "@echo off",
      "chcp 65001 >nul",
      "setlocal DisableDelayedExpansion",
      task.command,
      "exit /b %errorlevel%",
    ].join("\r\n") + "\r\n", "utf8");
    task.commandScriptPath = commandScriptPath;
    return commandScriptPath;
  }

  private killRunner(runner: ChildProcess): void {
    if (runner.pid === undefined || runner.exitCode !== null || runner.signalCode !== null) return;
    if (process.platform === "win32") {
      spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(runner.pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true, timeout: 5_000,
      });
    } else {
      runner.kill("SIGTERM");
    }
  }
}
