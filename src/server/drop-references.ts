import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { formatExternalDropReference, formatWorkspaceDropReference, shouldAttachDroppedImage } from "../shared/drop-reference.js";
import { canonicalizeLocalPathInput } from "../shared/local-path.js";
import type { DroppedPathEntry, DroppedPathResolution } from "../shared/protocol.js";
import { matchDroppedEntries } from "./workspace-fs.js";

export async function resolveDroppedReferences(cwd: string, input: { paths?: string[]; entries?: DroppedPathEntry[]; attachImages?: boolean }): Promise<DroppedPathResolution> {
  const fromPaths = input.paths === undefined || input.paths.length === 0
    ? { references: [], imagePaths: [], unmatched: [] }
    : await referencesForAbsolutePaths(cwd, input.paths, input.attachImages === true);
  const fromEntries = input.entries === undefined || input.entries.length === 0
    ? { references: [], unmatched: [] }
    : await matchDroppedEntries(cwd, input.entries);
  return {
    references: [...fromPaths.references, ...fromEntries.references],
    imagePaths: fromPaths.imagePaths,
    unmatched: [...fromPaths.unmatched, ...fromEntries.unmatched],
  };
}

export function workspaceRelativePosix(cwd: string, target: string): string | undefined {
  const value = relative(resolve(cwd), resolve(target)).replaceAll("\\", "/");
  if (value === "") return "";
  if (value === ".." || value.startsWith("../") || value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return undefined;
  return value;
}

async function referencesForAbsolutePaths(cwd: string, paths: string[], attachImages: boolean): Promise<DroppedPathResolution> {
  const cwdReal = await realpath(cwd).catch(() => resolve(cwd));
  const references: string[] = [];
  const imagePaths: string[] = [];
  const unmatched: string[] = [];
  for (const raw of paths) {
    const path = canonicalizeLocalPathInput(raw);
    if (path === "") {
      unmatched.push(raw);
      continue;
    }
    const metadata = await stat(path).catch(() => undefined);
    if (metadata === undefined) {
      unmatched.push(path);
      continue;
    }
    const real = await realpath(path).catch(() => path);
    if (attachImages && shouldAttachDroppedImage(real, metadata.size, metadata.isFile())) {
      imagePaths.push(real);
      continue;
    }
    const relativePosix = workspaceRelativePosix(cwdReal, real);
    references.push(relativePosix === undefined
      ? formatExternalDropReference(path, metadata.isDirectory())
      : formatWorkspaceDropReference(relativePosix, metadata.isDirectory()));
  }
  return { references, imagePaths, unmatched };
}
