import assert from "node:assert/strict";
import { test } from "node:test";
import { streamBlockId, streamBlockText } from "./stream-block.ts";

test("stream block ids match persisted projection and survive driver restarts", () => {
  assert.equal(streamBlockId(1000, "text", 0), "message:assistant:1000");
  assert.equal(streamBlockId(1000, "text", 2), "message:assistant:1000:text:2");
  assert.equal(streamBlockId(1000, "thinking", 0), "message:assistant:1000:thinking");
  assert.equal(streamBlockId(1000, "thinking", 2), "message:assistant:1000:thinking:2");
  assert.notEqual(streamBlockId(1000, "text", 0), streamBlockId(2000, "text", 0));
});

test("stream text reads one block and retains long content", () => {
  const long = "x".repeat(5001);
  const blocks = [{ type: "text", text: "first" }, { type: "thinking", thinking: "reason" }, { type: "text", text: long }];
  assert.equal(streamBlockText(blocks, 2, "text"), long);
  assert.equal(streamBlockText(blocks, 1, "text"), "");
  assert.equal(streamBlockText(blocks, 1, "thinking"), "reason");
});
