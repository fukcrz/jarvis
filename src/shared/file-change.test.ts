import { describe, expect, it } from "vitest";
import { fileChangeFromCall, fileChangeFromPatch, lineDiff, mergeFileChanges } from "./file-change.js";

describe("file changes", () => {
  it("diffs edit replacements line by line", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
    const change = fileChangeFromCall("edit", { path: "x.ts", edits: [{ oldText: "a\nb", newText: "a\nB\nC" }] });
    expect(change).toMatchObject({ kind: "edit", path: "x.ts", added: 2, removed: 1 });
  });

  it("counts written files as additions", () => {
    expect(fileChangeFromCall("write", { path: "y.ts", content: "1\n2\n" })).toMatchObject({ kind: "write", added: 2, removed: 0, diff: "+1\n+2" });
    expect(fileChangeFromCall("read", { path: "y.ts" })).toBeUndefined();
  });

  it("reads Pi unified patches without file headers", () => {
    const change = fileChangeFromPatch("x.ts", "--- x.ts\n+++ x.ts\n@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+e\n");
    expect(change).toMatchObject({ added: 2, removed: 1, diff: "@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+e" });
  });

  it("merges repeated changes to one file", () => {
    const merged = mergeFileChanges([
      { kind: "edit", path: "a", added: 1, removed: 0, diff: "+x" },
      { kind: "edit", path: "b", added: 2, removed: 2 },
      { kind: "edit", path: "a", added: 3, removed: 1, diff: "-y" },
    ]);
    expect(merged.map((change) => [change.path, change.added, change.removed])).toEqual([["a", 4, 1], ["b", 2, 2]]);
  });
});
