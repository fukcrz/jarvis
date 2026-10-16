import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countJsonlLines } from "./session-files.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-jsonl-lines-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("countJsonlLines", () => {
  it("counts non-empty lines and ignores blank or whitespace-only ones", async () => {
    const path = join(directory, "session.jsonl");
    await writeFile(path, '{"type":"session"}\n{"a":1}\r\n\n  \r\n{"b":2}');
    await expect(countJsonlLines(path)).resolves.toBe(3);
  });

  it("handles lines that span read chunks", async () => {
    const path = join(directory, "big.jsonl");
    const line = `{"data":"${"x".repeat(100_000)}"}`;
    await writeFile(path, `${Array.from({ length: 12 }, () => line).join("\n")}\n\n`);
    await expect(countJsonlLines(path)).resolves.toBe(12);
  });
});
