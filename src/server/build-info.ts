import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * 服务自身版本。桌面壳拿它和自己带的版本比对，发现「更新后还在跑旧服务」。
 * 从本文件所在目录往上找最近的 package.json：编译产物是 `<根>/dist/server/server/`，
 * 开发期是 `<根>/src/server/`，两种情况都能落到根目录。
 */
export function appVersion(): string {
  if (cached !== undefined) return cached;
  cached = "unknown";
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string" && version.length > 0) {
        cached = version;
        break;
      }
    } catch {
      // 这一层没有就读上一层。
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return cached;
}
