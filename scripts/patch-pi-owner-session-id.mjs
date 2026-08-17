import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function replaceOnce(path, before, after) {
  const source = await readFile(path, "utf8");
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Expected one patch target in ${path}, found ${count}`);
  await writeFile(path, source.replace(before, after), "utf8");
}

await replaceOnce(
  join(root, "node_modules/@earendil-works/pi-ai/dist/types.d.ts"),
  "export interface SimpleStreamOptions extends StreamOptions {\n    reasoning?: ThinkingLevel;",
  "export interface SimpleStreamOptions extends StreamOptions {\n    /** Stable source session ID for local request routing. Unlike sessionId, this is not replaced for standalone summaries. */\n    ownerSessionId?: string;\n    reasoning?: ThinkingLevel;",
);

await replaceOnce(
  join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js"),
  "            return modelRuntime.streamSimple(model, context, {\n                ...options,\n                timeoutMs,",
  "            return modelRuntime.streamSimple(model, context, {\n                ...options,\n                // Keep local provider routing tied to this AgentSession even when compaction\n                // replaces sessionId with an isolated UUID for cache/request affinity.\n                ownerSessionId: sessionManager.getSessionId(),\n                timeoutMs,",
);

console.log("Applied Pi ownerSessionId routing patch");
