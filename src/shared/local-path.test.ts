import { describe, expect, it } from "vitest";
import { canonicalizeLocalPathInput, stripRedundantRootBeforeWindowsDrive, unwrapPathDelimiters } from "./local-path.js";

describe("unwrapPathDelimiters", () => {
  it("strips matching quotes and angle brackets", () => {
    expect(unwrapPathDelimiters('"/D:/work/a.png"')).toBe("/D:/work/a.png");
    expect(unwrapPathDelimiters("'/D:/work/a.png'")).toBe("/D:/work/a.png");
    expect(unwrapPathDelimiters("</D:/work/a.png>")).toBe("/D:/work/a.png");
    expect(unwrapPathDelimiters('"<D:/work/a.png>"')).toBe("D:/work/a.png");
  });

  it("leaves unmatched delimiters alone", () => {
    expect(unwrapPathDelimiters("it's-a-file.ts")).toBe("it's-a-file.ts");
    expect(unwrapPathDelimiters("src/app.ts")).toBe("src/app.ts");
  });
});

describe("stripRedundantRootBeforeWindowsDrive", () => {
  it("strips one or more slashes before a drive letter", () => {
    expect(stripRedundantRootBeforeWindowsDrive("/D:/work/a.png")).toBe("D:/work/a.png");
    expect(stripRedundantRootBeforeWindowsDrive("//D:/work/a.png")).toBe("D:/work/a.png");
    expect(stripRedundantRootBeforeWindowsDrive(String.raw`/D:\work\a.png`)).toBe(String.raw`D:\work\a.png`);
    expect(stripRedundantRootBeforeWindowsDrive("/d:/work/a.png")).toBe("d:/work/a.png");
  });

  it("leaves Unix and ordinary Windows paths unchanged", () => {
    expect(stripRedundantRootBeforeWindowsDrive("/tmp/a.png")).toBe("/tmp/a.png");
    expect(stripRedundantRootBeforeWindowsDrive("D:/work/a.png")).toBe("D:/work/a.png");
    expect(stripRedundantRootBeforeWindowsDrive("src/app.ts")).toBe("src/app.ts");
    expect(stripRedundantRootBeforeWindowsDrive("/mnt/d/work/a.png")).toBe("/mnt/d/work/a.png");
  });
});

describe("canonicalizeLocalPathInput", () => {
  it("unwraps then strips a Unix root before a Windows drive", () => {
    expect(canonicalizeLocalPathInput('  "/D:/work/a.png"  ')).toBe("D:/work/a.png");
    expect(canonicalizeLocalPathInput("<//D:/work/a.png>")).toBe("D:/work/a.png");
  });
});
