import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_TOUCH_MCP_PORT, DesktopTouchService } from "./desktop-touch-service.js";

function fakeChild(pid = 1234): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    connected: true,
    disconnect: vi.fn(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function healthyResponse(ok = true): Response {
  return new Response(JSON.stringify({ status: "ok", name: "desktop-touch-mcp", version: "2.0.0" }), { status: ok ? 200 : 503 });
}

describe("DesktopTouchService", () => {
  it("starts one hidden HTTP runtime and stops its process tree on dispose", async () => {
    const child = fakeChild();
    const forkProcess = vi.fn(() => child);
    const fetchHealth = vi.fn().mockResolvedValueOnce(healthyResponse(false)).mockResolvedValue(healthyResponse());
    const stopWindowsProcessTree = vi.fn(async () => undefined);
    const service = new DesktopTouchService({
      platform: "win32",
      executablePath: "node.exe",
      locateRuntime: async () => ({ entry: "C:/desktop-touch/dist/index.js", cwd: "C:/desktop-touch" }),
      forkProcess,
      fetchHealth,
      stopWindowsProcessTree,
      pollIntervalMs: 1,
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1,
    });

    await Promise.all([service.start(), service.start()]);

    expect(forkProcess).toHaveBeenCalledTimes(1);
    expect(forkProcess).toHaveBeenCalledWith(
      "C:/desktop-touch/dist/index.js",
      ["--http", "--port", String(DESKTOP_TOUCH_MCP_PORT)],
      expect.objectContaining({
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: expect.objectContaining({
          DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE: "1",
          DESKTOP_TOUCH_REQUIRE_DESTINATION: "1",
          NODE_OPTIONS: expect.stringContaining("windows-child-process-preload.js"),
        }),
      }),
    );
    await service.dispose();
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(stopWindowsProcessTree).toHaveBeenCalledExactlyOnceWith(child.pid);
  });

  it("reuses a healthy service without taking ownership", async () => {
    const forkProcess = vi.fn(() => fakeChild());
    const stopWindowsProcessTree = vi.fn(async () => undefined);
    const service = new DesktopTouchService({
      platform: "win32",
      locateRuntime: async () => undefined,
      forkProcess,
      fetchHealth: vi.fn().mockResolvedValue(healthyResponse()),
      stopWindowsProcessTree,
    });

    await service.start();
    await service.dispose();

    expect(forkProcess).not.toHaveBeenCalled();
    expect(stopWindowsProcessTree).not.toHaveBeenCalled();
  });

  it("cleans up an owned process when startup times out", async () => {
    const child = fakeChild();
    const stopWindowsProcessTree = vi.fn(async () => undefined);
    const service = new DesktopTouchService({
      platform: "win32",
      locateRuntime: async () => ({ entry: "C:/desktop-touch/dist/index.js", cwd: "C:/desktop-touch" }),
      forkProcess: vi.fn(() => child),
      fetchHealth: vi.fn().mockResolvedValue(healthyResponse(false)),
      stopWindowsProcessTree,
      pollIntervalMs: 1,
      startupTimeoutMs: 5,
      shutdownTimeoutMs: 1,
    });

    await expect(service.start()).rejects.toThrow("did not become healthy");
    expect(stopWindowsProcessTree).toHaveBeenCalledExactlyOnceWith(child.pid);
  });
});
