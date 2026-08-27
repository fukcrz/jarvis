import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const codingAgentRoot = join(root, "node_modules/@earendil-works/pi-coding-agent");
const piAiTypePaths = [
  join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts"),
  join(codingAgentRoot, "node_modules/@earendil-works/pi-ai/dist/types.d.ts"),
].filter(existsSync);

async function replaceOnce(path, before, after) {
  const source = await readFile(path, "utf8");
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one patch target in ${path}, found ${count}`);
  await writeFile(path, source.replace(before, after), "utf8");
}

async function replaceOneOf(path, replacements) {
  const source = await readFile(path, "utf8");
  if (replacements.some(({ after }) => source.includes(after))) return;
  const matches = replacements.filter(({ before }) => source.split(before).length - 1 === 1);
  if (matches.length === 0) throw new Error(`Expected one patch target in ${path}, found 0`);
  const longestLength = Math.max(...matches.map(({ before }) => before.length));
  const specificMatches = matches.filter(({ before }) => before.length === longestLength);
  if (specificMatches.length !== 1) throw new Error(`Expected one patch target in ${path}, found ${specificMatches.length}`);
  const [{ before, after }] = specificMatches;
  await writeFile(path, source.replace(before, after), "utf8");
}

for (const piAiTypes of piAiTypePaths) {
  await replaceOneOf(piAiTypes, [
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    reasoning?: ThinkingLevel;",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    reasoning?: ThinkingLevel;",
    },
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */",
    },
    {
      before: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */\n    toolChoice?: ToolChoice;",
      after: "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    /** Provider-neutral tool selection for simple requests. Default: \"auto\". */\n    toolChoice?: ToolChoice;",
    },
  ]);
}

await replaceOnce(
  join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js"),
  "            return modelRuntime.streamSimple(model, context, {\n                ...options,\n                timeoutMs,",
  "            return modelRuntime.streamSimple(model, context, {\n                ...options,\n                // Keep local provider routing tied to this AgentSession even when compaction\n                // replaces sessionId with an isolated UUID for cache/request affinity.\n                ownerSessionId: sessionManager.getSessionId(),\n                timeoutMs,",
);

const codingAgentDist = join(codingAgentRoot, "dist/core");

// The SDK's primary Bash runner already hides its console. Cover its other
// automatic child-process paths too, including extension pi.exec and the
// built-in grep/find tools.
await replaceOnce(
  join(codingAgentDist, "exec.js"),
  "            shell: false,\n            stdio: [\"ignore\", \"pipe\", \"pipe\"],\n        });",
  "            shell: false,\n            stdio: [\"ignore\", \"pipe\", \"pipe\"],\n            windowsHide: true,\n        });",
);

await replaceOnce(
  join(codingAgentDist, "tools", "grep.js"),
  "const child = spawn(rgPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"] });",
  "const child = spawn(rgPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"], windowsHide: true });",
);

await replaceOnce(
  join(codingAgentDist, "tools", "find.js"),
  "const child = spawn(fdPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"] });",
  "const child = spawn(fdPath, args, { stdio: [\"ignore\", \"pipe\", \"pipe\"], windowsHide: true });",
);

console.log("Applied Pi ownerSessionId and Windows hidden-process patches");
