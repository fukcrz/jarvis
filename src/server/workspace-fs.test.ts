import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileMatchScore, parseByteRange, resolveFileRequestPath, searchWorkspaceFiles } from "./workspace-fs.js";

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
