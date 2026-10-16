import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDiagnosticsZip, sanitizeConfig } from "./diagnostics.js";
import { createZip } from "./zip.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jarvis-diag-test-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

/** 读出 zip 里每个文件的名字和内容（只支持 createZip 产出的格式）。 */
function readZip(data: Buffer): Map<string, string> {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = data.readUInt16LE(local + 26);
    const body = data.subarray(local + 30 + localNameLength, local + 30 + localNameLength + compressedSize);
    files.set(name, inflateRawSync(body).toString("utf8"));
    offset += 46 + nameLength;
  }
  return files;
}

describe("createZip", () => {
  it("produces an archive whose entries round-trip", () => {
    const zip = createZip([{ name: "a.txt", data: "hello" }, { name: "目录/b.json", data: "{\"x\":1}" }]);
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(readZip(zip)).toEqual(new Map([["a.txt", "hello"], ["目录/b.json", "{\"x\":1}"]]));
  });
});

describe("sanitizeConfig", () => {
  it("masks secrets but keeps structure", () => {
    const sanitized = JSON.parse(sanitizeConfig("tunnel.json", JSON.stringify({ version: 2, tunnels: [{ id: "t", frp: { server: "1.2.3.4:7000", token: "s3cret" } }] }))) as unknown;
    expect(sanitized).toEqual({ version: 2, tunnels: [{ id: "t", frp: { server: "1.2.3.4:7000", token: "***" } }] });
    const models = JSON.parse(sanitizeConfig("models.json", JSON.stringify({ providers: { x: { apiKey: "sk-1", baseUrl: "https://a", headers: { "X-Auth": "y" } } } }))) as unknown;
    expect(models).toEqual({ providers: { x: { apiKey: "***", baseUrl: "https://a", headers: { "X-Auth": "***" } } } });
  });

  it("reduces auth.json to whether a password is set", () => {
    const sanitized = JSON.parse(sanitizeConfig("auth.json", JSON.stringify({ version: 1, secret: "abc", tokenVersion: 3, password: { hash: "h", salt: "s" } }))) as unknown;
    expect(sanitized).toEqual({ version: 1, passwordSet: true, tokenVersion: 3 });
  });

  it("does not leak unreadable files", () => {
    expect(JSON.parse(sanitizeConfig("x.json", "{\"token\": \"abc"))).toEqual({ unreadable: true, length: 14 });
  });
});

describe("buildDiagnosticsZip", () => {
  it("bundles info, recent logs and sanitized config", async () => {
    const home = join(directory, "home");
    const logs = join(home, "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "server-2026-10-16.log"), "{\"msg\":\"hi\"}\n");
    await writeFile(join(home, "auth.json"), JSON.stringify({ version: 1, secret: "SECRET", tokenVersion: 1, password: null }));
    await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, assistantName: "J" }));

    const { fileName, data } = await buildDiagnosticsZip({ jarvisHome: home, logDirectory: logs, agentDir: join(directory, "agent") });
    expect(fileName).toMatch(/^jarvis-diagnostics-\d{8}T\d{6}\.zip$/);
    const files = readZip(data);
    expect(files.get("logs/server-2026-10-16.log")).toContain("hi");
    expect(JSON.parse(files.get("info.json") ?? "{}")).toMatchObject({ node: process.version, jarvisVersion: expect.any(String) as unknown });
    expect(files.get("config/auth.json")).not.toContain("SECRET");
    expect(files.get("config/settings.json")).toContain("\"J\"");
  });
});
