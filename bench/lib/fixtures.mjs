import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PROFILES = Object.freeze({
  quick: Object.freeze({ sessions: 2, turnsPerSession: 8, toolsPerTurn: 2, workspaceFiles: 40, wsEvents: 64, wsSubscribers: 4 }),
  standard: Object.freeze({ sessions: 10, turnsPerSession: 40, toolsPerTurn: 3, workspaceFiles: 500, wsEvents: 500, wsSubscribers: 20 }),
  stress: Object.freeze({ sessions: 25, turnsPerSession: 120, toolsPerTurn: 4, workspaceFiles: 2_000, wsEvents: 5_000, wsSubscribers: 100 }),
});

const TOOL_NAMES = ["read", "grep", "bash", "find"];

export async function createFixtures(input = {}) {
  const options = typeof input === "string" ? { profile: input } : input;
  const profileName = options.profile ?? "quick";
  const baseProfile = PROFILES[profileName];
  if (baseProfile === undefined) throw new RangeError(`Unknown fixture profile: ${String(profileName)}`);

  const profile = {
    sessions: positiveInteger(options.sessions ?? options.sessionCount ?? baseProfile.sessions, "sessions"),
    turnsPerSession: positiveInteger(options.turnsPerSession ?? options.turns ?? baseProfile.turnsPerSession, "turnsPerSession"),
    toolsPerTurn: positiveInteger(options.toolsPerTurn ?? options.tools ?? baseProfile.toolsPerTurn, "toolsPerTurn"),
    workspaceFiles: positiveInteger(options.workspaceFiles ?? options.files ?? baseProfile.workspaceFiles, "workspaceFiles"),
    wsEvents: positiveInteger(options.wsEvents ?? baseProfile.wsEvents, "wsEvents"),
    wsSubscribers: positiveInteger(options.wsSubscribers ?? baseProfile.wsSubscribers, "wsSubscribers"),
  };
  const rootPath = await mkdtemp(join(tmpdir(), "jarvis-bench-"));
  const workspacePath = resolve(join(rootPath, "workspace"));
  const sessionDir = resolve(join(rootPath, "sessions"));
  const workspaceId = options.workspaceId ?? randomUUID();
  const sessionDetails = [];
  const sessionRefs = [];
  const baseTime = Date.now();

  try {
    await Promise.all([mkdir(workspacePath, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
    await writeWorkspaceFixtures(workspacePath, profile.workspaceFiles);
    for (let sessionIndex = 0; sessionIndex < profile.sessions; sessionIndex += 1) {
      const sessionId = options.sessionIds?.[sessionIndex] ?? randomUUID();
      const session = await writeSessionFixture({
        sessionDir,
        workspacePath,
        workspaceId,
        sessionId,
        sessionIndex,
        profile,
        baseTime,
        richContent: options.richContent === true,
        namePrefix: options.namePrefix ?? "Benchmark session",
      });
      sessionDetails.push(session);
      sessionRefs.push({ workspaceId, sessionId });
    }
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true });
    throw error;
  }

  let cleanupPromise;
  const cleanup = async () => {
    cleanupPromise ??= rm(rootPath, { recursive: true, force: true });
    await cleanupPromise;
  };

  const fixtureCounts = sessionDetails.reduce((total, session) => addCounts(total, session.counts), {
    files: sessionDetails.length,
    workspaceFiles: profile.workspaceFiles,
    sessions: sessionDetails.length,
    turns: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    messageEntries: 0,
    sessionInfoEntries: 0,
    jsonlRecords: 0,
    entries: 0,
  });

  return {
    profile: profileName,
    profileConfig: profile,
    rootPath,
    workspacePath,
    sessionDir,
    workspaceId,
    sessionRefs,
    sessions: sessionDetails,
    sessionFiles: sessionDetails.map(({ path, id, counts }) => ({ path, id, counts })),
    fixtureCounts,
    cleanup,
  };
}

async function writeSessionFixture({ sessionDir, workspacePath, workspaceId, sessionId, sessionIndex, profile, baseTime, richContent, namePrefix }) {
  const sessionStart = new Date(baseTime + sessionIndex * 60_000);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: sessionStart.toISOString(),
    cwd: workspacePath,
  };
  const entries = [];
  let previousId = null;
  const sessionInfo = createEntry("session_info", sessionStart, previousId, { name: `${namePrefix} ${String(sessionIndex + 1)}` });
  entries.push(sessionInfo);
  previousId = sessionInfo.id;

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;

  for (let turnIndex = 0; turnIndex < profile.turnsPerSession; turnIndex += 1) {
    const turnNumber = turnIndex + 1;
    const turnTime = new Date(sessionStart.getTime() + turnNumber * 1_000);
    const user = createMessageEntry(
      turnTime,
      previousId,
      { role: "user", content: [{ type: "text", text: `Benchmark session ${String(sessionIndex + 1)}, turn ${String(turnNumber)}` }] },
    );
    entries.push(user.entry);
    previousId = user.entry.id;
    userMessages += 1;

    const calls = Array.from({ length: profile.toolsPerTurn }, (_, toolIndex) => {
      const name = TOOL_NAMES[toolIndex % TOOL_NAMES.length];
      return {
        type: "toolCall",
        id: randomUUID(),
        name,
        arguments: toolArguments(name, workspacePath, sessionIndex, turnIndex, toolIndex),
      };
    });
    const assistant = createMessageEntry(
      new Date(turnTime.getTime() + 100),
      previousId,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `Preparing fixture tools for turn ${String(turnNumber)}` },
          { type: "text", text: richContent ? richAssistantText(turnNumber) : `Benchmark assistant response for turn ${String(turnNumber)}` },
          ...calls,
        ],
        stopReason: "toolUse",
      },
    );
    entries.push(assistant.entry);
    previousId = assistant.entry.id;
    assistantMessages += 1;
    toolCalls += calls.length;

    for (let toolIndex = 0; toolIndex < calls.length; toolIndex += 1) {
      const call = calls[toolIndex];
      const result = createMessageEntry(
        new Date(turnTime.getTime() + 200 + toolIndex),
        previousId,
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: richContent ? richToolText(call.name, turnNumber) : `Fixture ${call.name} result for turn ${String(turnNumber)}` }],
          isError: false,
        },
      );
      entries.push(result.entry);
      previousId = result.entry.id;
      toolResults += 1;
    }
  }

  const fileName = `session-${String(sessionIndex + 1)}-${sessionId}.jsonl`;
  const path = join(sessionDir, fileName);
  const lines = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(path, lines, "utf8");

  const counts = {
    turns: profile.turnsPerSession,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    messageEntries: userMessages + assistantMessages + toolResults,
    sessionInfoEntries: 1,
    jsonlRecords: 1 + entries.length,
    entries: entries.length,
  };
  return {
    id: sessionId,
    sessionId,
    workspaceId,
    path,
    filePath: path,
    counts,
  };
}

function createMessageEntry(date, parentId, message) {
  const entry = createEntry("message", date, parentId, {
    message: {
      ...message,
      timestamp: date.getTime(),
    },
  });
  return { entry };
}

function createEntry(type, date, parentId, fields = {}) {
  return {
    type,
    id: randomUUID(),
    parentId,
    timestamp: date.toISOString(),
    ...fields,
  };
}

async function writeWorkspaceFixtures(workspacePath, count) {
  await Promise.all([
    mkdir(join(workspacePath, "src"), { recursive: true }),
    mkdir(join(workspacePath, "docs"), { recursive: true }),
    mkdir(join(workspacePath, "fixtures"), { recursive: true }),
  ]);
  const batchSize = 128;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(count, start + batchSize);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset + 1;
      const group = index % 3 === 0 ? "docs" : index % 3 === 1 ? "src" : "fixtures";
      const extension = index % 5 === 0 ? "md" : "ts";
      const path = join(workspacePath, group, `benchmark-${String(index).padStart(5, "0")}.${extension}`);
      const content = extension === "md"
        ? `# Benchmark document ${String(index)}\n\nfixture benchmark searchable-token-${String(index % 17)}\n`
        : `export const benchmark${String(index)} = "searchable-token-${String(index % 17)}";\n`;
      return writeFile(path, content, "utf8");
    }));
  }
}

function richAssistantText(turnNumber) {
  return [
    `Benchmark assistant response for turn ${String(turnNumber)}.`,
    "",
    "## Render sample",
    "",
    "- a short list item",
    "- a second list item with **bold** and `inline code`",
    "",
    "| field | value |",
    "| --- | --- |",
    `| turn | ${String(turnNumber)} |`,
    "| state | completed |",
    "",
    "```ts",
    `export function benchmark${String(turnNumber)}(): string { return \"ok\"; }`,
    "```",
  ].join("\n");
}

function richToolText(name, turnNumber) {
  return [
    `Fixture ${name} result for turn ${String(turnNumber)}`,
    "",
    "```text",
    "line 1: benchmark output",
    "line 2: searchable tool payload",
    "```",
  ].join("\n");
}

function toolArguments(name, workspacePath, sessionIndex, turnIndex, toolIndex) {
  if (name === "bash") return { command: `node -e "process.stdout.write(\"fixture\")"` };
  if (name === "grep") return { pattern: "fixture", path: workspacePath };
  if (name === "find") return { path: workspacePath, pattern: "*" };
  return { path: join(workspacePath, `fixture-${String(sessionIndex + 1)}-${String(turnIndex + 1)}-${String(toolIndex + 1)}.txt`) };
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function addCounts(total, counts) {
  for (const key of Object.keys(counts)) total[key] = (total[key] ?? 0) + counts[key];
  return total;
}
