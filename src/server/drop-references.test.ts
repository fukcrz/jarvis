import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatExternalDropReference, formatWorkspaceDropReference, MAX_DROPPED_IMAGE_BYTES, shouldAttachDroppedImage } from "../shared/drop-reference.js";
import { resolveDroppedReferences, workspaceRelativePosix } from "./drop-references.js";

describe("drop reference formatting", () => {
  it("quotes workspace paths only when they contain spaces and marks directories", () => {
    expect(formatWorkspaceDropReference("src/app.ts", false)).toBe("@src/app.ts");
    expect(formatWorkspaceDropReference("src/my folder", true)).toBe("@\"src/my folder/\"");
    expect(formatWorkspaceDropReference("", true)).toBe("@./");
  });

  it("normalizes external paths and keeps a directory slash outside the quote escape", () => {
    expect(formatExternalDropReference("D:\\notes\\a b.md", false)).toBe("\"D:/notes/a b.md\"");
    expect(formatExternalDropReference("D:\\notes\\folder", true)).toBe("D:/notes/folder/");
  });

  it("rejects paths that leave the workspace", () => {
    expect(workspaceRelativePosix("/work/app", "/work/app/src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelativePosix("/work/app", "/work/app")).toBe("");
    expect(workspaceRelativePosix("/work/app", "/work/other")).toBeUndefined();
  });
});

describe("resolveDroppedReferences", () => {
  it("inserts workspace paths, external paths, and leaves missing paths unmatched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-drop-"));
    const outside = await mkdtemp(join(tmpdir(), "jarvis-drop-out-"));
    try {
      await mkdir(join(directory, "src"));
      await writeFile(join(directory, "src", "app.ts"), "export {};\n");
      await mkdir(join(directory, "notes"));
      const outsideFile = join(outside, "memo.txt");
      await writeFile(outsideFile, "hi");
      const resolved = await resolveDroppedReferences(directory, {
        paths: [join(directory, "src", "app.ts"), join(directory, "notes"), outsideFile, join(directory, "missing.ts")],
      });
      expect(resolved.references).toEqual(["@src/app.ts", "@notes/", formatExternalDropReference(outsideFile, false)]);
      expect(resolved.imagePaths).toEqual([]);
      expect(resolved.unmatched).toEqual([join(directory, "missing.ts")]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("returns attachable images separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-drop-img-"));
    try {
      const image = join(directory, "shot.png");
      const text = join(directory, "notes.txt");
      await writeFile(image, "png");
      await writeFile(text, "hi");
      const resolved = await resolveDroppedReferences(directory, {
        paths: [image, text],
        attachImages: true,
      });
      expect(resolved.imagePaths).toEqual([await realpathOr(image)]);
      expect(resolved.references).toEqual(["@notes.txt"]);
      expect(shouldAttachDroppedImage(image, MAX_DROPPED_IMAGE_BYTES + 1, true)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("matches a unique workspace file or folder and rejects ambiguous names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jarvis-drop-match-"));
    try {
      await mkdir(join(directory, "src"));
      await mkdir(join(directory, "other"));
      const file = join(directory, "src", "app.ts");
      await writeFile(file, "one");
      await writeFile(join(directory, "other", "app.ts"), "two");
      await mkdir(join(directory, "src", "components"));
      await mkdir(join(directory, "other", "components"));
      await mkdir(join(directory, "notes"));
      const metadata = await stat(file);
      const resolved = await resolveDroppedReferences(directory, {
        entries: [
          { name: "app.ts", kind: "file", size: metadata.size, mtimeMs: metadata.mtimeMs },
          { name: "components", kind: "directory" },
          { name: "notes", kind: "directory" },
          { name: "missing.ts", kind: "file", size: 1 },
        ],
      });
      expect(resolved.references).toEqual(["@notes/"]);
      expect(resolved.unmatched).toEqual(["app.ts", "components", "missing.ts"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a symlink out of the workspace as a workspace file", async () => {
    if (platform() === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "jarvis-drop-link-"));
    const outside = await mkdtemp(join(tmpdir(), "jarvis-drop-link-out-"));
    try {
      const target = join(outside, "secret.txt");
      await writeFile(target, "secret");
      const link = join(directory, "secret.txt");
      await symlink(target, link);
      const resolved = await resolveDroppedReferences(directory, { paths: [link] });
      expect(resolved.references).toEqual([formatExternalDropReference(link, false)]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

async function realpathOr(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
