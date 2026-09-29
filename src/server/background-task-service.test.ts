import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskService } from "./background-task-service.js";
import { WorkspaceStore } from "./workspace-store.js";

let testRoot: string;
let service: BackgroundTaskService;
let workspaces: WorkspaceStore;
let workspaceId: string;
let secondWorkspaceId: string;

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "jarvis-background-task-test-"));
  workspaces = new WorkspaceStore(join(testRoot, "workspaces.json"));
  await workspaces.initialize(join(testRoot, "workspace-a"), "workspace-a");
  const first = workspaces.list()[0];
  if (first === undefined) throw new Error("Expected first workspace");
  workspaceId = first.id;
  const secondPath = join(testRoot, "workspace-b");
  await mkdir(secondPath);
  const second = await workspaces.add(secondPath, "workspace-b");
  secondWorkspaceId = second.id;
  service = new BackgroundTaskService(workspaces);
});

afterEach(async () => {
  await service.dispose();
  await rm(testRoot, { recursive: true, force: true });
});

describe("BackgroundTaskService", () => {
  it("starts, lists, logs, stops, and isolates tasks by workspace", async () => {
    const command = nodeCommand("console.log('background-task-log'); setInterval(function () {}, 1000)");
    const task = await service.start(workspaceId, command);

    expect(task.workspaceId).toBe(workspaceId);
    expect(task.state).toBe("running");
    expect(service.list(secondWorkspaceId)).toEqual([]);
    await expect(service.start(workspaceId, command)).rejects.toMatchObject({ code: "TASK_ALREADY_RUNNING" });

    await eventually(async () => (await service.logs(workspaceId, task.id)).output.includes("background-task-log") ? true : undefined);
    const stopped = await service.stop(workspaceId, task.id);
    expect(stopped.state).toBe("stopped");
    const taskPid = task.pid;
    if (taskPid !== undefined) await eventually(() => processExists(taskPid) ? undefined : true);

    const logs = await service.logs(workspaceId, task.id);
    expect(logs.output).toContain("background-task-log");
    expect(logs.task.state).toBe("stopped");
  });

  it("restarts a task with the same id and keeps its log", async () => {
    const task = await service.start(workspaceId, nodeCommand("console.log('first-run'); setInterval(function () {}, 1000)"));
    await eventually(async () => (await service.logs(workspaceId, task.id)).output.includes("first-run") ? true : undefined);
    await service.stop(workspaceId, task.id);

    const restarted = await service.restart(workspaceId, task.id);
    expect(restarted.id).toBe(task.id);
    expect(restarted.state).toBe("running");
    await eventually(async () => (await service.logs(workspaceId, task.id)).output.includes("first-run") ? true : undefined);
    await service.stop(workspaceId, task.id);
  });

  it("records a successful natural exit", async () => {
    const output = String.fromCodePoint(0x4efb, 0x52a1, 0x5b8c, 0x6210);
    const task = await service.start(workspaceId, nodeCommand(`console.log(${JSON.stringify(output)})`));
    await eventually(() => service.list(workspaceId)[0]?.state === "exited" ? true : undefined);
    const result = service.list(workspaceId)[0];
    expect(result).toMatchObject({ id: task.id, state: "exited", exitCode: 0 });
    await eventually(async () => (await service.logs(workspaceId, task.id)).output.includes(output) ? true : undefined);
  });

  it("rejects cwd values outside the workspace", async () => {
    await expect(service.start(workspaceId, nodeCommand("setInterval(function () {}, 1000)"), ".."))
      .rejects.toMatchObject({ code: "TASK_CWD_INVALID" });
  });

  it("removes all workspace tasks when the workspace is stopped", async () => {
    const first = await service.start(workspaceId, nodeCommand("setInterval(function () {}, 1000)"));
    const second = await service.start(secondWorkspaceId, nodeCommand("setInterval(function () {}, 1000)"));

    await service.stopWorkspace(workspaceId);
    expect(service.list(workspaceId)).toEqual([]);
    expect(service.list(secondWorkspaceId).map((task) => task.id)).toEqual([second.id]);
    const firstPid = first.pid;
    if (firstPid !== undefined) await eventually(() => processExists(firstPid) ? undefined : true);
    await expect(service.start(workspaceId, nodeCommand("setInterval(function () {}, 1000)")))
      .rejects.toMatchObject({ code: "TASK_WORKSPACE_CLOSING" });
  });

  it("stops all tasks when disposed", async () => {
    const task = await service.start(workspaceId, nodeCommand("setInterval(function () {}, 1000)"));
    const pid = task.pid;
    expect(pid).toEqual(expect.any(Number));

    await service.dispose();
    if (pid !== undefined) await eventually(() => processExists(pid) ? undefined : true);
    expect(service.list(workspaceId)).toEqual([]);
  });

  it("stops a task's child process tree", async () => {
    const marker = join(testRoot, "child-pid.txt");
    const task = await service.start(workspaceId, nodeCommand(`const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)']); writeFileSync(${JSON.stringify(marker)}, String(child.pid)); setInterval(function () {}, 1000);`));
    const childPid = await eventually(async () => {
      try {
        const value = await import("node:fs/promises").then(({ readFile }) => readFile(marker, "utf8"));
        const pid = Number(value.trim());
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined;
      }
    });
    expect(processExists(childPid)).toBe(true);

    await service.stop(workspaceId, task.id);
    await eventually(() => processExists(childPid) ? undefined : true);
  });
});

function nodeCommand(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually<T>(check: () => T | undefined | Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition was not met before timeout");
}
