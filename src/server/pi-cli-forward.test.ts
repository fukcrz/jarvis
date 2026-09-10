import { existsSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { isPiCliInvocation, resolvePiCliEntry } from "./pi-cli-forward.js";

describe("isPiCliInvocation", () => {
  it("detects every Pi CLI mode flag", () => {
    expect(isPiCliInvocation(["--mode", "rpc", "--no-session"])).toBe(true);
    expect(isPiCliInvocation(["--mode", "json", "-p", "--no-session"])).toBe(true);
    expect(isPiCliInvocation(["--mode", "text"])).toBe(true);
  });

  it("detects the --mode=<value> form", () => {
    expect(isPiCliInvocation(["--mode=rpc"])).toBe(true);
  });

  it("ignores unknown mode values and unrelated flags", () => {
    expect(isPiCliInvocation(["--mode", "server"])).toBe(false);
    expect(isPiCliInvocation(["--mode"])).toBe(false);
    expect(isPiCliInvocation(["--port", "9528", "--host", "0.0.0.0"])).toBe(false);
    expect(isPiCliInvocation([])).toBe(false);
  });

  it("stops parsing at --", () => {
    expect(isPiCliInvocation(["--", "--mode", "rpc"])).toBe(false);
  });
});

describe("resolvePiCliEntry", () => {
  it("resolves the Pi CLI entry shipped with the hosting Pi package", () => {
    const entry = resolvePiCliEntry();
    expect(entry).toBeDefined();
    expect(entry === undefined ? false : existsSync(entry)).toBe(true);
    expect(entry === undefined ? "" : basename(entry)).toBe("cli.js");
  });
});
