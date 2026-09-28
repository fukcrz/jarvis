import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type ChildProcessMethod = "spawn" | "spawnSync" | "fork" | "exec" | "execSync" | "execFile" | "execFileSync";
type ChildProcessModule = Record<ChildProcessMethod, (...args: unknown[]) => unknown>;

const guardedModules = new WeakSet<object>();
const methodsWithArgsArray = new Set<ChildProcessMethod>(["spawn", "spawnSync", "fork", "execFile", "execFileSync"]);

function appendPreload(options: string | undefined, preload: string): string {
  if (options?.includes(preload)) return options;
  return [options?.trim(), `--import=${preload}`].filter(Boolean).join(" ");
}

export function withWindowsHiddenOptions(
  method: ChildProcessMethod,
  input: readonly unknown[],
  preload?: string,
): unknown[] {
  const args = [...input];
  const hasOptionalArgs = methodsWithArgsArray.has(method) && (Array.isArray(args[1]) || (args.length >= 3 && args[1] === undefined));
  const optionsIndex = hasOptionalArgs ? 2 : 1;
  const options = args[optionsIndex];
  if (typeof options === "function") {
    args.splice(optionsIndex, 0, { windowsHide: true });
  } else {
    args[optionsIndex] = {
      ...(options !== null && typeof options === "object" ? options : {}),
      windowsHide: true,
    };
  }
  const guardedOptions = args[optionsIndex] as Record<string, unknown>;

  if (preload !== undefined) {
    const env = guardedOptions["env"];
    const childEnv = { ...(env !== null && typeof env === "object" ? env : process.env) } as Record<string, unknown>;
    const nodeOptionsKey = Object.keys(childEnv).find((key) => key.toLowerCase() === "node_options") ?? "NODE_OPTIONS";
    const nodeOptions = childEnv[nodeOptionsKey];
    childEnv[nodeOptionsKey] = appendPreload(typeof nodeOptions === "string" ? nodeOptions : undefined, preload);
    guardedOptions["env"] = childEnv;
  }

  args[optionsIndex] = guardedOptions;
  return args;
}

export function installWindowsChildProcessGuard(
  platform = process.platform,
  module: ChildProcessModule = childProcess as unknown as ChildProcessModule,
  preload: string | null = (() => {
    const url = new URL("./windows-child-process-preload.js", import.meta.url);
    return existsSync(fileURLToPath(url)) ? url.href : null;
  })(),
): void {
  if (platform !== "win32" || guardedModules.has(module)) return;

  const methods: ChildProcessMethod[] = ["spawn", "spawnSync", "fork", "exec", "execSync", "execFile", "execFileSync"];
  for (const method of methods) {
    const original = module[method];
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      return Reflect.apply(original, this, withWindowsHiddenOptions(method, args, preload ?? undefined));
    };
    const nativePromisified = (original as typeof original & { [promisify.custom]?: (...args: unknown[]) => unknown })[promisify.custom];
    if (nativePromisified) {
      Object.defineProperty(wrapped, promisify.custom, {
        value: function (this: unknown, ...args: unknown[]): unknown {
          return Reflect.apply(nativePromisified, this, withWindowsHiddenOptions(method, args, preload ?? undefined));
        },
      });
    }
    module[method] = wrapped;
  }
  guardedModules.add(module);
  syncBuiltinESMExports();
}
