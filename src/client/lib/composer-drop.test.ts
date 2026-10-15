import { describe, expect, it } from "vitest";
import { collectBrowserDrop, insertionForDropReferences, parseFileUriList, plainTextDropPath } from "./composer-drop";

describe("composer drop parsing", () => {
  it("turns file URIs into local paths and ignores comments", () => {
    expect(parseFileUriList("# comment\r\nfile:///D:/notes/a%20b.md\nfile:///home/proj/src")).toEqual([
      "D:/notes/a b.md",
      "/home/proj/src",
    ]);
    expect(plainTextDropPath("D:\\notes\\a.txt")).toBe("D:\\notes\\a.txt");
    expect(plainTextDropPath("readme.md")).toBeUndefined();
  });

  it("inserts references at the cursor with separating spaces", () => {
    expect(insertionForDropReferences("看这个", 3, ["@src/app.ts", "@notes/"])).toEqual({
      from: 3,
      insert: " @src/app.ts @notes/ ",
      cursor: 24,
    });
    expect(insertionForDropReferences("已有 ", 3, ["@src/app.ts"])).toEqual({
      from: 3,
      insert: "@src/app.ts ",
      cursor: 15,
    });
    expect(insertionForDropReferences("", 0, [])).toBeUndefined();
  });

  it("attaches images, fingerprints other files and folders, and prefers real paths", () => {
    const collected = collectBrowserDrop({
      uriList: "",
      plainText: "",
      items: [
        { kind: "file", type: "image/png", file: { name: "shot.png", type: "image/png", size: 4, lastModified: 1 } },
        { kind: "file", type: "", file: { name: "app.ts", type: "", size: 8, lastModified: 2 } },
        { kind: "file", type: "", directoryName: "src" },
      ],
    }, true);
    expect(collected.images.map((file) => file.name)).toEqual(["shot.png"]);
    expect(collected.entries).toEqual([
      { name: "app.ts", kind: "file", size: 8, mtimeMs: 2 },
      { name: "src", kind: "directory" },
    ]);

    const withPaths = collectBrowserDrop({
      uriList: "file:///D:/proj/src/app.ts\r\nfile:///D:/proj/shot.png",
      plainText: "D:\\ignored.txt",
      items: [{ kind: "file", type: "", file: { name: "app.ts", type: "", size: 8, lastModified: 2 } }],
    }, true);
    expect(withPaths.paths).toEqual(["D:/proj/src/app.ts"]);
    expect(withPaths.entries).toEqual([]);
  });
});
