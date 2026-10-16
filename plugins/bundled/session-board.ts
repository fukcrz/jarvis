/**
 * 项目内会话互通：列出同项目其他会话，并让模型改自己的标题 / 上报当前步骤。
 *
 * 标题走 Pi 的 setSessionName（Jarvis 侧栏会跟着变）。
 * 摘要和心跳只写在绝对路径的会话目录 `.session-board/`，不进 git、不进对话。
 * 会话目录为空、相对路径，或等于当前项目目录时不写。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BOARD_DIRNAME = ".session-board";
const HEARTBEAT_MS = 20_000;
const HEARTBEAT_TTL_MS = 75_000;
const LIST_WINDOW_MS = 6 * 60 * 60 * 1000;
const TITLE_LIMIT = 120;
const SUMMARY_LIMIT = 120;

interface BoardRecord {
  summary?: string;
  heartbeatAt?: string;
  updatedAt: string;
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function limitCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function writableSessionDir(sessionDir: string | undefined, cwd = process.cwd()): string | undefined {
  if (!sessionDir || !isAbsolute(sessionDir) || samePath(sessionDir, cwd)) return undefined;
  return sessionDir;
}

function boardDir(sessionDir: string): string {
  return join(sessionDir, BOARD_DIRNAME);
}

function boardFile(sessionDir: string, sessionId: string): string {
  return join(boardDir(sessionDir), `${sessionId}.json`);
}

function isFreshHeartbeat(record: BoardRecord | undefined, now: number): boolean {
  if (!record?.heartbeatAt) return false;
  const at = Date.parse(record.heartbeatAt);
  return Number.isFinite(at) && now - at <= HEARTBEAT_TTL_MS;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data)}\n`, "utf8");
  await rename(tmp, path);
}

async function readBoardFile(path: string): Promise<BoardRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const summary = trimText(record.summary);
    const heartbeatAt = trimText(record.heartbeatAt);
    const updatedAt = trimText(record.updatedAt);
    return {
      ...(summary ? { summary } : {}),
      ...(heartbeatAt ? { heartbeatAt } : {}),
      updatedAt: updatedAt || new Date().toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function mergeBoard(sessionDir: string, sessionId: string, patch: Partial<BoardRecord>): Promise<BoardRecord | undefined> {
  const dir = writableSessionDir(sessionDir);
  if (!dir) return undefined;
  const path = boardFile(dir, sessionId);
  const current = (await readBoardFile(path)) ?? { updatedAt: new Date().toISOString() };
  const next: BoardRecord = { updatedAt: new Date().toISOString() };
  const summary = patch.summary === undefined ? current.summary : patch.summary;
  const heartbeatAt = patch.heartbeatAt === undefined ? current.heartbeatAt : patch.heartbeatAt;
  if (summary) next.summary = summary;
  if (heartbeatAt) next.heartbeatAt = heartbeatAt;
  if (!next.summary && !next.heartbeatAt) {
    await rm(path, { force: true });
    return next;
  }
  await atomicWriteJson(path, next);
  return next;
}

async function clearBoard(sessionDir: string | undefined, sessionId: string | undefined): Promise<void> {
  const dir = writableSessionDir(sessionDir);
  if (!dir || !sessionId) return;
  await rm(boardFile(dir, sessionId), { force: true });
}

async function loadBoardMap(sessionDir: string, cwd = process.cwd()): Promise<Map<string, BoardRecord>> {
  const map = new Map<string, BoardRecord>();
  const dir = writableSessionDir(sessionDir, cwd);
  if (!dir) return map;
  let names: string[];
  try {
    names = await readdir(boardDir(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return map;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readBoardFile(join(boardDir(dir), name));
    if (record) map.set(name.slice(0, -".json".length), record);
  }
  return map;
}

export default function (pi: ExtensionAPI) {
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatActive = false;
  let sessionDir: string | undefined;
  let sessionId: string | undefined;
  let writeChain = Promise.resolve();

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const next = writeChain.then(op, op);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const stopHeartbeat = () => {
    heartbeatActive = false;
    if (heartbeatTimer === undefined) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const writeHeartbeat = () => {
    const dir = sessionDir;
    const id = sessionId;
    if (!heartbeatActive || !dir || !id) return;
    void enqueue(async () => {
      if (!heartbeatActive) return;
      await mergeBoard(dir, id, { heartbeatAt: new Date().toISOString() });
    });
  };

  const startHeartbeat = () => {
    heartbeatActive = true;
    writeHeartbeat();
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };

  const dropHeartbeat = () =>
    enqueue(async () => {
      const dir = sessionDir;
      const id = sessionId;
      if (!dir || !id) return;
      await mergeBoard(dir, id, { heartbeatAt: "" });
    });

  const clearOwnBoard = () => {
    const dir = sessionDir;
    const id = sessionId;
    return enqueue(async () => {
      await clearBoard(dir, id);
    });
  };

  pi.on("session_start", (_event, ctx) => {
    sessionDir = ctx.sessionManager.getSessionDir();
    sessionId = ctx.sessionManager.getSessionId();
  });

  pi.on("agent_start", () => {
    startHeartbeat();
  });

  pi.on("agent_settled", async () => {
    stopHeartbeat();
    await dropHeartbeat();
  });

  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    await clearOwnBoard();
    sessionDir = undefined;
    sessionId = undefined;
  });

  pi.registerTool({
    name: "session_list",
    label: "Session List",
    description:
      "List other sessions in the current project that are running or updated in the last 6 hours: id, title, running, optional current-step summary. Older idle sessions are omitted (count only). Does not include conversation text.",
    promptSnippet: "List other sessions in this project (running or last 6 hours)",
    promptGuidelines: [
      "Use session_list only when you need to avoid colliding with other sessions in this project. Do not call session_list every turn.",
      "Results include running sessions and sessions updated in the last 6 hours. Older idle sessions appear only as omitted count.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const dir = ctx.sessionManager.getSessionDir();
      const selfId = ctx.sessionManager.getSessionId();
      const listed = await SessionManager.list(ctx.cwd, dir);
      const board = await loadBoardMap(dir, ctx.cwd);
      const now = Date.now();
      const cutoff = now - LIST_WINDOW_MS;
      const others: Array<{
        id: string;
        title: string | null;
        running: boolean;
        summary?: string;
        updatedAt: string;
      }> = [];
      let omitted = 0;
      for (const entry of listed) {
        if (entry.id === selfId) continue;
        const record = board.get(entry.id);
        const running = isFreshHeartbeat(record, now);
        if (!running && entry.modified.getTime() < cutoff) {
          omitted += 1;
          continue;
        }
        others.push({
          id: entry.id,
          title: entry.name?.trim() || null,
          running,
          ...(running && record?.summary ? { summary: record.summary } : {}),
          updatedAt: entry.modified.toISOString(),
        });
      }
      others.sort((left, right) => {
        if (left.running !== right.running) return left.running ? -1 : 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              self: {
                id: selfId,
                title: pi.getSessionName()?.trim() || null,
              },
              others,
              ...(omitted > 0 ? { omitted } : {}),
            }),
          },
        ],
        details: { count: others.length, omitted },
      };
    },
  });

  pi.registerTool({
    name: "session_update",
    label: "Session Update",
    description:
      "Update this session's title and/or current-step summary. Summary is visible to other sessions via session_list while this session is running; it is not shown in the sidebar.",
    promptSnippet: "Set this session's title and/or current-step summary",
    promptGuidelines: [
      "Use session_update when the session title is still the first user message or otherwise inaccurate, or when a short current-step summary would help other sessions avoid colliding. Do not call session_update every turn.",
    ],
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({ description: "New session title. Concise; no quotes or trailing punctuation." }),
      ),
      summary: Type.Optional(
        Type.String({
          description: "Current step for other sessions. Empty string clears it. Omit to leave unchanged.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const titleInput = params.title === undefined ? undefined : trimText(params.title);
      const summaryInput = params.summary === undefined ? undefined : trimText(params.summary);
      if (titleInput === undefined && params.summary === undefined) {
        throw new Error("Provide title and/or summary");
      }
      if (params.title !== undefined && !titleInput) {
        throw new Error("title must not be empty");
      }

      const changed: string[] = [];
      if (titleInput) {
        pi.setSessionName(limitCharacters(titleInput, TITLE_LIMIT));
        changed.push(`title=${pi.getSessionName() ?? titleInput}`);
      }

      if (params.summary !== undefined) {
        const dir = writableSessionDir(ctx.sessionManager.getSessionDir(), ctx.cwd);
        if (!dir) {
          changed.push("summary skipped");
        } else {
          const id = ctx.sessionManager.getSessionId();
          await enqueue(async () => {
            await mergeBoard(dir, id, {
              summary: summaryInput ? limitCharacters(summaryInput, SUMMARY_LIMIT) : "",
            });
          });
          changed.push(summaryInput ? `summary=${limitCharacters(summaryInput, SUMMARY_LIMIT)}` : "summary=cleared");
        }
      }

      return {
        content: [{ type: "text", text: changed.join("; ") }],
        details: {
          title: pi.getSessionName() ?? null,
          summary: summaryInput || null,
        },
      };
    },
  });
}
