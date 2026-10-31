import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appVersion } from "./build-info.js";

describe("appVersion", () => {
  it("reports the version of the package the service runs from", async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    expect(appVersion()).toBe(manifest.version);
  });

  it("never reports an empty version", () => {
    expect(appVersion().length).toBeGreaterThan(0);
  });
});
