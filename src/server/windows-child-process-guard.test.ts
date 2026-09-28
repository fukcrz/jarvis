import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { installWindowsChildProcessGuard, withWindowsHiddenOptions } from "./windows-child-process-guard.js";

const methods = ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"] as const;

describe("withWindowsHiddenOptions", () => {
  it.each(methods)("sets windowsHide for %s", (method) => {
    const args = method === "exec" || method === "execSync"
      ? ["command", { cwd: "C:/repo" }]
      : ["command", ["--version"], { cwd: "C:/repo" }];
    const optionsIndex = method === "exec" || method === "execSync" ? 1 : 2;

    const guarded = withWindowsHiddenOptions(method, args);

    expect(guarded[optionsIndex]).toMatchObject({ cwd: "C:/repo", windowsHide: true });
  });

  it("preserves the exec options overload", () => {
    const guarded = withWindowsHiddenOptions("exec", ["git status", { cwd: "C:/repo" }]);
    expect(guarded[1]).toMatchObject({ cwd: "C:/repo", windowsHide: true });
  });

  it.each(["exec", "execFile"] as const)("inserts options before a %s callback", (method) => {
    const callback = vi.fn();
    const input = method === "exec" ? ["git status", callback] : ["git", ["status"], callback];
    const optionsIndex = method === "exec" ? 1 : 2;
    const guarded = withWindowsHiddenOptions(method, input);

    expect(guarded[optionsIndex]).toEqual({ windowsHide: true });
    expect(guarded[optionsIndex + 1]).toBe(callback);
  });

  it("does not mutate existing options", () => {
    const options = { cwd: "C:/repo" };
    withWindowsHiddenOptions("spawn", ["git", ["status"], options]);
    expect(options).toEqual({ cwd: "C:/repo" });
  });

  it("preserves options after omitted argv", () => {
    const guarded = withWindowsHiddenOptions("spawn", ["git", undefined, { cwd: "C:/repo" }]);
    expect(guarded[2]).toMatchObject({ cwd: "C:/repo", windowsHide: true });
  });

  it("propagates preload into an explicit child environment", () => {
    const guarded = withWindowsHiddenOptions("spawn", ["git", [], { env: { PATH: "test" } }], "file:///guard.js");
    expect(guarded[2]).toMatchObject({ env: { PATH: "test", NODE_OPTIONS: "--import=file:///guard.js" } });
  });
});

describe("installWindowsChildProcessGuard", () => {
  it("wraps every child-process API once on Windows", () => {
    const originals = Object.fromEntries(methods.map((method) => [method, vi.fn(() => method)]));
    const fakeModule = { ...originals } as unknown as Record<typeof methods[number], (...args: unknown[]) => unknown>;

    installWindowsChildProcessGuard("win32", fakeModule, null);
    installWindowsChildProcessGuard("win32", fakeModule, null);
    for (const method of methods) {
      const original = originals[method]!;
      const args: unknown[] = method === "exec" || method === "execSync"
        ? ["git status", { windowsHide: false }]
        : ["git", ["status"], { windowsHide: false }];
      fakeModule[method](...args);
      expect(original).toHaveBeenCalledTimes(1);
      const lastCall = original.mock.lastCall as unknown[] | undefined;
      expect(lastCall?.[method === "exec" || method === "execSync" ? 1 : 2]).toMatchObject({ windowsHide: true });
    }
  });

  it("preserves native promisify hooks for exec and execFile", () => {
    for (const method of ["exec", "execFile"] as const) {
      const original = vi.fn();
      const promisified = vi.fn(() => Promise.resolve({ stdout: "ok", stderr: "" }));
      Object.defineProperty(original, promisify.custom, { value: promisified });
      const fakeModule = { ...Object.fromEntries(methods.map((name) => [name, name === method ? original : vi.fn()])) } as unknown as Record<typeof methods[number], (...args: unknown[]) => unknown>;
      installWindowsChildProcessGuard("win32", fakeModule, null);
      const wrapped = fakeModule[method];
      const custom = (wrapped as typeof wrapped & { [promisify.custom]?: (...args: unknown[]) => unknown })[promisify.custom];
      expect(custom).toBeTypeOf("function");
      custom?.("git", { windowsHide: false });
      expect(promisified).toHaveBeenCalledWith("git", { windowsHide: true });
    }
  });

  it("leaves APIs unchanged on non-Windows platforms", () => {
    const original = vi.fn();
    const fakeModule = { ...Object.fromEntries(methods.map((method) => [method, original])) } as unknown as Record<typeof methods[number], (...args: unknown[]) => unknown>;

    installWindowsChildProcessGuard("linux", fakeModule);
    expect(fakeModule.spawn).toBe(original);
  });
});
