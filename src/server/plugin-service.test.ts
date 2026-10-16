import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginContentHash } from "./plugin-reconcile.js";
import { PluginService } from "./plugin-service.js";

class FakePackages {
  readonly calls: string[] = [];
  sources: Array<{ source: string; installedPath?: string }> = [];

  listConfiguredPackages() {
    return this.sources.map((item) => ({ source: item.source, scope: "user" as const, filtered: false, installedPath: item.installedPath }));
  }

  async installAndPersist(source: string): Promise<void> {
    this.calls.push(`install:${source}`);
    if (!this.sources.some((item) => item.source === source)) this.sources.push({ source });
  }

  async removeAndPersist(source: string): Promise<boolean> {
    this.calls.push(`remove:${source}`);
    this.sources = this.sources.filter((item) => item.source !== source);
    return true;
  }

  async update(source?: string): Promise<void> {
    this.calls.push(`update:${source ?? ""}`);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("plugin service isolation", () => {
  it("syncs bundled plugins in a temp agent dir and leaves unrelated files alone", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.agentDir, "extensions", "custom.ts"), "export default function () {}\n", "utf8");
    const snapshot = await harness.service.snapshot();
    expect(snapshot.bundled.map((item) => item.id)).toEqual(["model-groups-router", "session-board"]);
    expect(snapshot.bundled.every((item) => item.enabled && !item.modified)).toBe(true);
    expect(await readFile(join(harness.agentDir, "extensions", "custom.ts"), "utf8")).toBe("export default function () {}\n");
    expect(harness.packages.calls).toEqual([]);
  });

  it("keeps a local edit, restores it only on overwrite, and deletes it when disabled", async () => {
    const harness = await createHarness();
    const target = join(harness.agentDir, "extensions", "session-board.ts");
    const official = await readFile(target, "utf8");
    await writeFile(target, "export default function edited() {}\n", "utf8");
    const edited = await harness.service.snapshot();
    expect(edited.bundled.find((item) => item.id === "session-board")).toMatchObject({ enabled: true, modified: true });
    expect(await readFile(target, "utf8")).toBe("export default function edited() {}\n");

    const restored = await harness.service.overwriteBundled("session-board");
    expect(restored.bundled.find((item) => item.id === "session-board")?.modified).toBe(false);
    expect(pluginContentHash(await readFile(target, "utf8"))).toBe(pluginContentHash(official));

    const disabled = await harness.service.setBundledEnabled("session-board", false);
    expect(disabled.bundled.find((item) => item.id === "session-board")).toMatchObject({ enabled: false, modified: false });
    await expect(readFile(target, "utf8")).rejects.toThrow();

    const reloaded = await reload(harness);
    expect(reloaded.bundled.find((item) => item.id === "session-board")?.enabled).toBe(false);
    const enabled = await harness.service.setBundledEnabled("session-board", true);
    expect(enabled.bundled.find((item) => item.id === "session-board")).toMatchObject({ enabled: true, modified: false });
    expect(pluginContentHash(await readFile(target, "utf8"))).toBe(pluginContentHash(official));
  });

  it("does not install or update a recommended package that was turned off", async () => {
    const harness = await createHarness();
    harness.packages.sources.push({ source: "npm:@mjakl/pi-subagent@3.1.0" });
    await harness.service.setRecommendedEnabled("@mjakl/pi-subagent", false);
    expect(harness.packages.calls).toEqual(["remove:npm:@mjakl/pi-subagent@3.1.0"]);
    harness.packages.calls.length = 0;
    await harness.service.ensureRecommended();
    expect(harness.packages.calls).not.toContain("install:npm:@mjakl/pi-subagent");
    expect(harness.packages.calls.some((call) => call.startsWith("update:npm:@mjakl/pi-subagent"))).toBe(false);
    const snapshot = await harness.service.snapshot();
    expect(snapshot.recommended.find((item) => item.name === "@mjakl/pi-subagent")).toMatchObject({ enabled: false, installed: false });
  });

  it("treats a local package with the same name as the recommended install and drops the npm duplicate", async () => {
    const harness = await createHarness();
    const local = join(harness.agentDir, "vendor", "pi-subagent");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "package.json"), JSON.stringify({ name: "@mjakl/pi-subagent", version: "3.1.0" }), "utf8");
    harness.packages.sources.push(
      { source: "./vendor/pi-subagent", installedPath: local },
      { source: "npm:@mjakl/pi-subagent", installedPath: join(harness.agentDir, "npm", "pi-subagent") },
    );
    await harness.service.ensureRecommended();
    expect(harness.packages.calls).toContain("remove:npm:@mjakl/pi-subagent");
    expect(harness.packages.calls).not.toContain("install:npm:@mjakl/pi-subagent");
    expect(harness.packages.calls.some((call) => call.startsWith("update:"))).toBe(false);
    expect(harness.packages.sources.map((item) => item.source)).not.toContain("npm:@mjakl/pi-subagent");
    expect(harness.packages.sources.map((item) => item.source)).toContain("./vendor/pi-subagent");
    const snapshot = await harness.service.snapshot();
    expect(snapshot.recommended.find((item) => item.name === "@mjakl/pi-subagent")).toMatchObject({
      enabled: true,
      installed: true,
      source: "./vendor/pi-subagent",
    });
    harness.packages.calls.length = 0;
    await harness.service.setRecommendedEnabled("@mjakl/pi-subagent", true);
    expect(harness.packages.calls).toEqual([]);
  });

  it("installs a missing recommended package when turned on, and skips install when it is already present", async () => {
    const harness = await createHarness();
    await harness.service.setRecommendedEnabled("pi-playwright", true);
    expect(harness.packages.calls).toEqual(["install:npm:pi-playwright"]);
    harness.packages.calls.length = 0;
    await harness.service.setRecommendedEnabled("pi-playwright", true);
    expect(harness.packages.calls).toEqual([]);
  });

  it("keeps a removed recommended package disabled after restart", async () => {
    const harness = await createHarness();
    harness.packages.sources.push({ source: "npm:pi-web-access" });
    await harness.service.remove("npm:pi-web-access");
    const restarted = await reload(harness);
    expect(restarted.recommended.find((item) => item.name === "pi-web-access")).toMatchObject({ enabled: false, installed: false });
    await harness.service.ensureRecommended();
    expect(harness.packages.calls).not.toContain("install:npm:pi-web-access");
    expect(harness.packages.calls).toContain("install:npm:pi-playwright");
  });

  it("rejects unsafe install sources before touching the package manager", async () => {
    const harness = await createHarness();
    await expect(harness.service.install("../secrets")).rejects.toThrow(/无法识别/);
    await expect(harness.service.install("https://gitlab.com/example/pi-tools")).rejects.toThrow(/无法识别/);
    expect(harness.packages.calls).toEqual([]);
  });

  it("accepts pasted GitHub addresses and marks catalog results already installed", async () => {
    const harness = await createHarness();
    await harness.service.install("git+https://github.com/example/pi-tools.git");
    await harness.service.install("https://github.com/example/other/tree/main/");
    expect(harness.packages.calls).toEqual([
      "install:https://github.com/example/pi-tools",
      "install:https://github.com/example/other",
    ]);
    harness.packages.sources.push({ source: "npm:pi-web-access" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      objects: [
        { package: { name: "pi-web-access", version: "1.2.3", description: "search", keywords: ["pi-package"], links: { repository: "git+https://github.com/example/pi-web-access.git", npm: "https://www.npmjs.com/package/pi-web-access" } } },
        { package: { name: "not-a-plugin", version: "1.0.0", description: "no", keywords: ["other"], links: {} } },
      ],
    }), { status: 200 })));
    const results = await harness.service.search("web");
    expect(results).toEqual([{
      name: "pi-web-access",
      version: "1.2.3",
      description: "search",
      source: "npm:pi-web-access",
      installed: true,
      url: "https://github.com/example/pi-web-access",
    }]);
  });

  it("reports search failure without installing anything", async () => {
    const harness = await createHarness();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    await expect(harness.service.search("")).rejects.toMatchObject({ code: "PLUGIN_SEARCH_FAILED", statusCode: 502 });
    expect(harness.packages.calls).toEqual([]);
  });
});

async function createHarness(): Promise<{ root: string; agentDir: string; service: PluginService; packages: FakePackages }> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-plugin-service-"));
  const agentDir = join(root, "agent");
  const packages = new FakePackages();
  const service = new PluginService(agentDir, join(root, "plugin-prefs.json"), packages as unknown as PackageManager, () => undefined);
  await service.initialize();
  return { root, agentDir, service, packages };
}

async function reload(harness: { root: string; agentDir: string; service: PluginService; packages: FakePackages }): Promise<Awaited<ReturnType<PluginService["snapshot"]>>> {
  harness.service = new PluginService(harness.agentDir, join(harness.root, "plugin-prefs.json"), harness.packages as unknown as PackageManager, () => undefined);
  await harness.service.initialize();
  return harness.service.snapshot();
}
