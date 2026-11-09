import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("bundled plugin dependencies", () => {
  it("resolves every dependency declared by every bundled plugin", () => {
    const pluginsDir = join(root, "plugins");
    const missing = [];
    for (const entry of readdirSync(pluginsDir)) {
      const manifestPath = join(pluginsDir, entry, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const require = createRequire(manifestPath);
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        try {
          require.resolve(dependency);
        } catch {
          missing.push(`${entry}: ${dependency}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
