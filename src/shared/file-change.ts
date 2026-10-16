import type { FileChange } from "./protocol.js";

/** diff 文本最多保留这么多行，避免一次大改动把时间线撑爆。 */
export const FILE_CHANGE_MAX_DIFF_LINES = 400;
/** 逐行比对的规模上限（行数乘积），超出时按整段删除/新增处理。 */
const LCS_MAX_CELLS = 250_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** 简单的逐行最长公共子序列，输出 " "/"-"/"+" 前缀的行。 */
export function lineDiff(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > LCS_MAX_CELLS) return [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)];
  const table: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(` ${a[i]!}`); i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { out.push(`-${a[i]!}`); i += 1; }
    else { out.push(`+${b[j]!}`); j += 1; }
  }
  while (i < a.length) { out.push(`-${a[i]!}`); i += 1; }
  while (j < b.length) { out.push(`+${b[j]!}`); j += 1; }
  return out;
}

function countLines(lines: readonly string[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function capDiff(lines: string[]): { diff: string; truncated?: true } {
  if (lines.length <= FILE_CHANGE_MAX_DIFF_LINES) return { diff: lines.join("\n") };
  return { diff: lines.slice(0, FILE_CHANGE_MAX_DIFF_LINES).join("\n"), truncated: true };
}

/** 从 edit/write 工具的参数推算改动；工具返回真实 patch 后会被 fileChangeFromPatch 覆盖。 */
export function fileChangeFromCall(name: string, args: unknown): FileChange | undefined {
  if (!isRecord(args)) return undefined;
  const path = typeof args["path"] === "string" ? args["path"] : typeof args["file_path"] === "string" ? args["file_path"] : "";
  if (path === "") return undefined;
  if (name === "write") {
    const content = typeof args["content"] === "string" ? args["content"] : undefined;
    if (content === undefined) return undefined;
    const lines = splitLines(content).map((line) => `+${line}`);
    return { kind: "write", path, added: lines.length, removed: 0, ...capDiff(lines) };
  }
  if (name !== "edit") return undefined;
  let edits: unknown = args["edits"];
  if (typeof edits === "string") {
    try { edits = JSON.parse(edits); } catch { edits = undefined; }
  }
  if (isRecord(edits)) edits = [edits];
  if (!Array.isArray(edits) && typeof args["oldText"] === "string" && typeof args["newText"] === "string") edits = [{ oldText: args["oldText"], newText: args["newText"] }];
  if (!Array.isArray(edits)) return undefined;
  const lines: string[] = [];
  for (const edit of edits) {
    if (!isRecord(edit) || typeof edit["oldText"] !== "string" || typeof edit["newText"] !== "string") continue;
    lines.push("@@", ...lineDiff(edit["oldText"], edit["newText"]));
  }
  if (lines.length === 0) return undefined;
  return { kind: "edit", path, ...countLines(lines), ...capDiff(lines) };
}

/** 读取 Pi edit 工具返回的统一 diff（details.patch），去掉文件头，保留 @@ 段。 */
export function fileChangeFromPatch(path: string, patch: string, kind: FileChange["kind"] = "edit"): FileChange | undefined {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  let started = false;
  for (const line of lines) {
    if (!started) {
      if (line.startsWith("@@")) started = true;
      else continue;
    }
    if (line.startsWith("\\")) continue;
    body.push(line);
  }
  while (body.at(-1) === "") body.pop();
  if (body.length === 0) return undefined;
  return { kind, path, ...countLines(body), ...capDiff(body) };
}

/** 同一回合里同一个文件的多次改动合成一条。 */
export function mergeFileChanges(changes: readonly FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of changes) {
    const previous = byPath.get(change.path);
    if (previous === undefined) {
      byPath.set(change.path, { ...change });
      continue;
    }
    const diff = [previous.diff, change.diff].filter((value): value is string => value !== undefined && value !== "").join("\n");
    byPath.set(change.path, {
      kind: previous.kind === "write" || change.kind === "write" ? "write" : "edit",
      path: change.path,
      added: previous.added + change.added,
      removed: previous.removed + change.removed,
      ...(diff === "" ? {} : { diff }),
      ...(previous.truncated === true || change.truncated === true ? { truncated: true } : {}),
    });
  }
  return [...byPath.values()];
}
