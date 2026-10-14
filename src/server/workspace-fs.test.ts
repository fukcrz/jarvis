import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const readdirCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (...args: unknown[]) => {
      readdirCalls.count += 1;
      return Reflect.apply(actual.readdir, actual, args);
    },
  };
});

import { fileMatchScore, parseByteRange, readTextFile, resolveFileRequestPath, searchWorkspaceFiles } from "./workspace-fs.js";

describe("parseByteRange", () => {
  it("parses closed, open, and suffix ranges", () => {
    expect(parseByteRange("bytes=0-3", 8)).toEqual({ start: 0, end: 3 });
    expect(parseByteRange("bytes=4-", 8)).toEqual({ start: 4, end: 7 });
    expect(parseByteRange("bytes=-2", 8)).toEqual({ start: 6, end: 7 });
  });

  it("rejects unsatisfiable and multi-range requests", () => {
    expect(parseByteRange("bytes=99-", 8)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-1,3-4", 8)).toBeUndefined();
    expect(parseByteRange(undefined, 8)).toBeUndefined();
    expect(parseByteRange("bytes=-0", 8)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=0-3", 0)).toBe("unsatisfiable");
  });
});

describe("readTextFile", () => {
  it("accepts application text MIME types with charset parameters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-text-file-"));
    const files = [
      ["config.json", "{\"enabled\":true}"],
      ["events.jsonl", "{\"id\":1}\n"],
      ["document.xml", "<root />"],
    ] as const;
    try {
      for (const [name, content] of files) {
        const path = join(directory, name);
        await writeFile(path, content);
        await expect(readTextFile(path, await stat(path))).resolves.toMatchObject({ name, content, truncated: false });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("searchWorkspaceFiles", () => {
  it("skips virtualenv trees but still returns editor-config files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-search-"));
    try {
      await mkdir(join(directory, ".venv", "lib"), { recursive: true });
      await mkdir(join(directory, ".vscode"), { recursive: true });
      await writeFile(join(directory, ".venv", "lib", "site.py"), "x");
      await writeFile(join(directory, ".vscode", "settings.json"), "{}");
      await writeFile(join(directory, "app.ts"), "x");
      const paths = (await searchWorkspaceFiles(directory, "")).map((file) => file.path.replaceAll("\\", "/"));
      expect(paths).toEqual(expect.arrayContaining(["app.ts", ".vscode/settings.json"]));
      expect(paths.some((path) => path.includes(".venv"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies root and nested gitignore rules including negations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-search-ignore-"));
    try {
      await mkdir(join(directory, "deep"), { recursive: true });
      await mkdir(join(directory, "ignored"), { recursive: true });
      await mkdir(join(directory, "src", "generated"), { recursive: true });
      await writeFile(join(directory, ".gitignore"), `*.log
!important.log
/root-only.txt
.tmp-*.png
ignored/
src/generated/
`);
      await writeFile(join(directory, "src", ".gitignore"), `secret.txt
!nested.log
`);
      await writeFile(join(directory, "drop.log"), "x");
      await writeFile(join(directory, ".tmp-room-preview.png"), "x");
      await writeFile(join(directory, "important.log"), "x");
      await writeFile(join(directory, "root-only.txt"), "x");
      await writeFile(join(directory, "deep", "root-only.txt"), "x");
      await writeFile(join(directory, "ignored", "hidden.ts"), "x");
      await writeFile(join(directory, "src", "generated", "hidden.ts"), "x");
      await writeFile(join(directory, "src", "secret.txt"), "x");
      await writeFile(join(directory, "src", "nested.log"), "x");
      await writeFile(join(directory, "src", "visible.ts"), "x");

      const paths = (await searchWorkspaceFiles(directory, "")).map((file) => file.path.replaceAll("\\", "/"));
      expect(paths).toEqual(expect.arrayContaining(["important.log", "deep/root-only.txt", "src/nested.log", "src/visible.ts"]));
      expect(paths).not.toContain("drop.log");
      expect(paths).not.toContain(".tmp-room-preview.png");
      expect(paths).not.toContain("root-only.txt");
      expect(paths).not.toContain("ignored/hidden.ts");
      expect(paths).not.toContain("src/generated/hidden.ts");
      expect(paths).not.toContain("src/secret.txt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares one in-flight index across concurrent searches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-search-concurrent-"));
    try {
      await writeFile(join(directory, "first.ts"), "x");
      await writeFile(join(directory, "second.ts"), "x");
      readdirCalls.count = 0;

      const [first, second] = await Promise.all([
        searchWorkspaceFiles(directory, "first"),
        searchWorkspaceFiles(directory, "second"),
      ]);

      expect(first).toEqual([{ path: "first.ts" }]);
      expect(second).toEqual([{ path: "second.ts" }]);
      expect(readdirCalls.count).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses a recent index then refreshes it after the cache TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const directory = await mkdtemp(join(tmpdir(), "jarvis-search-cache-"));
    try {
      await writeFile(join(directory, "first.ts"), "x");
      await searchWorkspaceFiles(directory, "first");
      await writeFile(join(directory, "second.ts"), "x");

      await expect(searchWorkspaceFiles(directory, "second")).resolves.toEqual([]);
      await expect(searchWorkspaceFiles(directory, "first")).resolves.toEqual([{ path: "first.ts" }]);

      vi.advanceTimersByTime(5_000);
      await expect(searchWorkspaceFiles(directory, "second")).resolves.toEqual([{ path: "second.ts" }]);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("fileMatchScore", () => {
  it("prefers basename prefix over path substring", () => {
    const basenameHit = fileMatchScore("src/app.tsx", "app");
    const pathHit = fileMatchScore("src/app.tsx", "src");
    expect(basenameHit).toBeDefined();
    expect(pathHit).toBeDefined();
    expect(basenameHit!).toBeLessThan(pathHit!);
  });

  it("scores empty queries by path depth", () => {
    expect(fileMatchScore("a/b.ts", "")).toBe(2 * 100 + 6);
  });
});

describe("resolveFileRequestPath", () => {
  it.runIf(platform() === "win32")("opens /D:/ and Git Bash / WSL drive paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-path-"));
    try {
      const file = join(dir, "a.png");
      await writeFile(file, "x");
      const resolved = await realpath(file);
      const posix = file.replaceAll("\\", "/");
      const gitBash = posix.replace(/^([a-zA-Z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
      const wsl = posix.replace(/^([a-zA-Z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`);
      const cygwin = posix.replace(/^([a-zA-Z]):/, (_, drive: string) => `/cygdrive/${drive.toLowerCase()}`);
      expect(await resolveFileRequestPath(`/${posix}`, undefined)).toBe(resolved);
      expect(await resolveFileRequestPath(gitBash, undefined)).toBe(resolved);
      expect(await resolveFileRequestPath(wsl, undefined)).toBe(resolved);
      expect(await resolveFileRequestPath(cygwin, undefined)).toBe(resolved);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
