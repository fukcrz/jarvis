import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveSubagentTools } from "./tool-pool.ts";
import type { AgentType } from "../types.ts";

function tool(name: string): ToolDefinition {
  return { name } as ToolDefinition;
}

const verifier: AgentType = {
  name: "verifier",
  description: "leaf",
  canSpawn: false,
  tools: { block: ["edit", "write"] },
};

test("a leaf does not inherit delegation tools from the root loadout", () => {
  const pool = resolveSubagentTools({
    declared: [tool("agent_spawn"), tool("agent_wait"), tool("agent_update")],
    type: verifier,
    canSpawnChildren: true,
    inherited: {
      tools: [tool("agent_spawn"), tool("web_search")],
      activeNames: ["agent_spawn", "web_search"],
    },
    filtering: "all-except-blocked",
  });
  assert.equal(pool.canDelegate, false);
  assert.equal(pool.toolNames.includes("agent_spawn"), false);
  assert.equal(pool.toolNames.includes("agent_wait"), false);
  assert.equal(pool.externalTools.some((item) => item.name === "agent_spawn"), false);
  assert.equal(pool.toolNames.includes("web_search"), true);
  assert.equal(pool.toolNames.includes("agent_update"), true);
});

test("a planner keeps its own delegation tools", () => {
  const pool = resolveSubagentTools({
    declared: [tool("agent_spawn"), tool("agent_wait")],
    type: { name: "planner", description: "spawner", canSpawn: true },
    canSpawnChildren: true,
    inherited: { tools: [tool("agent_spawn")], activeNames: ["agent_spawn"] },
    filtering: "all-except-blocked",
  });
  assert.equal(pool.canDelegate, true);
  assert.equal(pool.toolNames.includes("agent_spawn"), true);
  assert.equal(pool.toolNames.includes("agent_wait"), true);
});
