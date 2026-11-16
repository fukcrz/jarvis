import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGINS, decideBundledSync, decideRetiredCleanup, ensureLocalPackage, localPackageTreeHash, localPackageUpdate, pluginContentHash, reconcileBundledPlugins, seedLocalPackageDependencies } from "./plugin-reconcile.js";
import { bundledPluginRoot } from "./plugin-service.js";
import { catalogUrl, normalizeInstallSource, packageNameFromSource } from "./plugin-source.js";

describe("bundled plugin sync", () => {
  it("writes a missing file, skips the current hash, updates an old hash, and keeps a local edit", () => {
    expect(decideBundledSync(undefined, "now", ["old", "now"])).toBe("write");
    expect(decideBundledSync("now", "now", ["old", "now"])).toBe("skip");
    expect(decideBundledSync("old", "now", ["old", "now"])).toBe("write");
    expect(decideBundledSync("edited", "now", ["old", "now"])).toBe("modified");
  });

  it("ignores carriage returns when comparing plugin content", () => {
    expect(pluginContentHash("a\r\nb\n")).toBe(pluginContentHash("a\nb\n"));
  });

  it("ships the current bundled file hash in the manifest", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "plugins", "manifest.json"), "utf8")) as { plugins: Record<string, string[]> };
    for (const plugin of BUNDLED_PLUGINS) {
      const content = await readFile(join(bundledPluginRoot(), plugin.file), "utf8");
      expect(manifest.plugins[plugin.file]).toContain(pluginContentHash(content));
    }
  });

  it("does not overwrite a modified copy unless forced", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-plugins-"));
    const extensionsDir = join(root, "extensions");
    const bundledDir = bundledPluginRoot();
    const known = Object.fromEntries(await Promise.all(BUNDLED_PLUGINS.map(async (plugin) => {
      const content = await readFile(join(bundledDir, plugin.file), "utf8");
      return [plugin.file, [pluginContentHash(content)]] as const;
    })));
    await reconcileBundledPlugins({ extensionsDir, bundledDir, knownHashes: known, disabled: new Set() });
    const target = join(extensionsDir, "session-board.ts");
    await writeFile(target, "export default function () {}\n", "utf8");
    const kept = await reconcileBundledPlugins({ extensionsDir, bundledDir, knownHashes: known, disabled: new Set() });
    expect(kept.find((item) => item.id === "session-board")?.modified).toBe(true);
    expect(await readFile(target, "utf8")).toBe("export default function () {}\n");
    await reconcileBundledPlugins({ extensionsDir, bundledDir, knownHashes: known, disabled: new Set(), forceIds: new Set(["session-board"]) });
    expect(pluginContentHash(await readFile(target, "utf8"))).toBe(known["session-board.ts"]?.[0]);
  });

  it("deletes a retired official copy and keeps a local edit", async () => {
    expect(decideRetiredCleanup(undefined, ["old"])).toBe("keep");
    expect(decideRetiredCleanup("old", ["old"])).toBe("delete");
    expect(decideRetiredCleanup("edited", ["old"])).toBe("keep");
    const root = await mkdtemp(join(tmpdir(), "jarvis-plugins-retired-"));
    const extensionsDir = join(root, "extensions");
    const official = join(extensionsDir, "gone.ts");
    const edited = join(extensionsDir, "edited.ts");
    const unrelated = join(extensionsDir, "custom.ts");
    await mkdir(extensionsDir, { recursive: true });
    await writeFile(official, "official\n", "utf8");
    await writeFile(edited, "edited\n", "utf8");
    await writeFile(unrelated, "custom\n", "utf8");
    await reconcileBundledPlugins({
      extensionsDir,
      bundledDir: bundledPluginRoot(),
      knownHashes: {},
      retired: { "gone.ts": [pluginContentHash("official\n")], "edited.ts": [pluginContentHash("official\n")] },
      disabled: new Set(),
    });
    await expect(readFile(official, "utf8")).rejects.toThrow();
    expect(await readFile(edited, "utf8")).toBe("edited\n");
    expect(await readFile(unrelated, "utf8")).toBe("custom\n");
  });
});

describe("local plugin package seeding", () => {
  it("copies the shipped package once and adopts the copy as its own baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-local-package-"));
    const shipped = join(root, "shipped");
    const local = join(root, "agent", "plugins", "demo");
    await mkdir(join(shipped, "src"), { recursive: true });
    await mkdir(join(shipped, "node_modules", "dep"), { recursive: true });
    await writeFile(join(shipped, "package.json"), JSON.stringify({ name: "demo", _jarvis: { upstream: "demo@2.0.0" } }), "utf8");
    await writeFile(join(shipped, "src", "index.ts"), "export const shipped = true;\n", "utf8");
    await writeFile(join(shipped, "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf8");

    const seeded = await ensureLocalPackage({ shipped, local });
    expect(seeded.result).toBe("seeded");
    expect(seeded.modified).toBe(false);
    expect(seeded.baselineHash).toBe(await localPackageTreeHash(local));
    expect(await readFile(join(local, "src", "index.ts"), "utf8")).toBe("export const shipped = true;\n");
    await expect(readFile(join(local, "node_modules", "dep", "index.js"), "utf8")).rejects.toThrow();
  });

  it("upgrades an untouched copy and keeps a locally edited one", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-local-package-upgrade-"));
    const shipped = join(root, "shipped");
    const local = join(root, "agent", "plugins", "demo");
    await mkdir(join(shipped, "src"), { recursive: true });
    await writeFile(join(shipped, "src", "index.ts"), "export const version = 1;\n", "utf8");
    await writeFile(join(shipped, "src", "legacy.ts"), "export const legacy = true;\n", "utf8");

    const seeded = await ensureLocalPackage({ shipped, local });
    expect(seeded.result).toBe("seeded");

    // 发行版变了、本地仍等于播种基线：按新种子替换，并删掉新种子不再包含的文件。
    await rm(join(shipped, "src", "legacy.ts"));
    await writeFile(join(shipped, "src", "index.ts"), "export const version = 2;\n", "utf8");
    const upgraded = await ensureLocalPackage({ shipped, local, baselineHash: seeded.baselineHash });
    expect(upgraded.result).toBe("upgraded");
    expect(upgraded.modified).toBe(false);
    expect(await readFile(join(local, "src", "index.ts"), "utf8")).toBe("export const version = 2;\n");
    await expect(readFile(join(local, "src", "legacy.ts"), "utf8")).rejects.toThrow();

    // 本地改过：不自动覆盖，只报 modified。
    await writeFile(join(local, "src", "index.ts"), "export const local = true;\n", "utf8");
    await writeFile(join(shipped, "src", "index.ts"), "export const version = 3;\n", "utf8");
    const kept = await ensureLocalPackage({ shipped, local, baselineHash: upgraded.baselineHash });
    expect(kept.result).toBe("kept");
    expect(kept.modified).toBe(true);
    expect(kept.baselineHash).toBeUndefined();
    expect(await readFile(join(local, "src", "index.ts"), "utf8")).toBe("export const local = true;\n");
  });

  it("does not upgrade a copy with no recorded baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-local-package-nobaseline-"));
    const shipped = join(root, "shipped");
    const local = join(root, "local");
    await mkdir(join(shipped, "src"), { recursive: true });
    await mkdir(join(local, "src"), { recursive: true });
    await writeFile(join(shipped, "src", "index.ts"), "export const version = 2;\n", "utf8");
    await writeFile(join(local, "src", "index.ts"), "export const version = 1;\n", "utf8");

    const outcome = await ensureLocalPackage({ shipped, local });
    expect(outcome.result).toBe("kept");
    expect(outcome.modified).toBe(true);
    expect(await readFile(join(local, "src", "index.ts"), "utf8")).toBe("export const version = 1;\n");
  });

  it("copies missing runtime dependencies from the host node_modules only", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-local-package-deps-"));
    const shipped = join(root, "shipped");
    const local = join(root, "local");
    const hostModules = join(root, "host", "node_modules");
    await mkdir(shipped, { recursive: true });
    await mkdir(join(local, "node_modules", "kept"), { recursive: true });
    await mkdir(join(hostModules, "yaml", "dist"), { recursive: true });
    await writeFile(join(shipped, "package.json"), JSON.stringify({ dependencies: { yaml: "2.8.1", missing: "1.0.0" } }), "utf8");
    await writeFile(join(hostModules, "yaml", "dist", "index.js"), "export {};\n", "utf8");
    await writeFile(join(local, "node_modules", "kept", "index.js"), "keep\n", "utf8");

    expect(await seedLocalPackageDependencies({ shipped, local, sourceRoot: hostModules })).toEqual(["yaml"]);
    expect(await readFile(join(local, "node_modules", "yaml", "dist", "index.js"), "utf8")).toBe("export {};\n");
    expect(await readFile(join(local, "node_modules", "kept", "index.js"), "utf8")).toBe("keep\n");
    expect(await seedLocalPackageDependencies({ shipped, local, sourceRoot: hostModules })).toEqual([]);
  });

  it("reports missing when neither copy exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-local-package-missing-"));
    expect((await ensureLocalPackage({ shipped: join(root, "shipped"), local: join(root, "local") })).result).toBe("missing");
    await expect(readFile(join(root, "local", "package.json"), "utf8")).rejects.toThrow();
  });

  it("flags an update only when both copies declare a different upstream", async () => {
    const root = await mkdtemp(join(tmpdir(), "jarvis-local-package-update-"));
    const shipped = join(root, "shipped");
    const local = join(root, "local");
    await mkdir(shipped, { recursive: true });
    await mkdir(local, { recursive: true });
    await writeFile(join(shipped, "package.json"), JSON.stringify({ _jarvis: { upstream: "demo@2.0.0" } }), "utf8");
    await writeFile(join(local, "package.json"), JSON.stringify({ _jarvis: { upstream: "demo@1.0.0" } }), "utf8");
    expect(await localPackageUpdate({ shipped, local })).toEqual({ shippedUpstream: "demo@2.0.0", localUpstream: "demo@1.0.0", updateAvailable: true });

    await writeFile(join(local, "package.json"), JSON.stringify({ _jarvis: { upstream: "demo@2.0.0" } }), "utf8");
    expect((await localPackageUpdate({ shipped, local })).updateAvailable).toBe(false);

    await writeFile(join(local, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    expect((await localPackageUpdate({ shipped, local })).updateAvailable).toBe(false);

    await writeFile(join(shipped, "package.json"), "not json", "utf8");
    expect((await localPackageUpdate({ shipped, local })).updateAvailable).toBe(false);
  });
});

describe("plugin install sources", () => {
  it("accepts npm names and GitHub addresses, and rejects local paths", () => {
    expect(normalizeInstallSource("pi-fovea")).toBe("npm:pi-fovea");
    expect(normalizeInstallSource("npm:@parke.dev/pi-subagent@0.8.0")).toBe("npm:@parke.dev/pi-subagent@0.8.0");
    expect(normalizeInstallSource("https://github.com/example/pi-tools")).toBe("https://github.com/example/pi-tools");
    expect(normalizeInstallSource("git:github.com/example/pi-tools@v1")).toBe("git:github.com/example/pi-tools@v1");
    expect(packageNameFromSource("npm:@parke.dev/pi-subagent@0.8.0")).toBe("@parke.dev/pi-subagent");
    expect(() => normalizeInstallSource("./local-package")).toThrow(/无法识别/);
    expect(() => normalizeInstallSource("https://gitlab.com/example/pi-tools")).toThrow(/无法识别/);
    expect(catalogUrl("git+https://github.com/example/pi-tools.git", undefined, "https://www.npmjs.com/package/pi-tools")).toBe("https://github.com/example/pi-tools");
  });
});
