import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { isRecord } from "../shared/protocol.js";

export async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}
