import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { describe, it } from "node:test";
import { createFixtures, PROFILES } from "../lib/fixtures.mjs";

describe("fixtures", () => {
  it("defines increasingly large quick, standard, and stress profiles", () => {
    const profiles = [PROFILES.quick, PROFILES.standard, PROFILES.stress];
    assert.ok(profiles.every((profile) => profile.sessions > 0 && profile.turnsPerSession > 0 && profile.toolsPerTurn > 0));
    assert.ok(PROFILES.quick.sessions < PROFILES.standard.sessions);
    assert.ok(PROFILES.standard.sessions < PROFILES.stress.sessions);
    assert.ok(PROFILES.quick.turnsPerSession < PROFILES.standard.turnsPerSession);
    assert.ok(PROFILES.standard.turnsPerSession < PROFILES.stress.turnsPerSession);
    assert.ok(PROFILES.quick.toolsPerTurn < PROFILES.standard.toolsPerTurn);
    assert.ok(PROFILES.standard.toolsPerTurn < PROFILES.stress.toolsPerTurn);
  });

  it("creates version 3 JSONL sessions with a linear parent chain", async () => {
    const fixtures = await createFixtures({ profile: "quick" });
    try {
      assert.equal(fixtures.profile, "quick");
      assert.equal(fixtures.sessionRefs.length, PROFILES.quick.sessions);
      assert.equal(fixtures.sessions.length, PROFILES.quick.sessions);
      assert.equal(fixtures.fixtureCounts.sessions, PROFILES.quick.sessions);
      assert.equal(fixtures.fixtureCounts.turns, PROFILES.quick.sessions * PROFILES.quick.turnsPerSession);
      assert.equal(fixtures.fixtureCounts.toolCalls, fixtures.fixtureCounts.toolResults);
      await access(fixtures.workspacePath);
      await access(fixtures.sessionDir);

      for (const session of fixtures.sessions) {
        const text = await readFile(session.path, "utf8");
        const records = text.trimEnd().split("\n").map((line) => JSON.parse(line));
        const header = records[0];
        assert.deepEqual(
          { type: header.type, version: header.version, id: header.id, cwd: header.cwd },
          { type: "session", version: 3, id: session.id, cwd: fixtures.workspacePath },
        );
        assert.equal(records[1].type, "session_info");
        assert.equal(records[1].parentId, null);

        let previousId = records[1].id;
        for (const record of records.slice(2)) {
          assert.equal(record.parentId, previousId);
          previousId = record.id;
        }

        const messages = records.filter((record) => record.type === "message").map((record) => record.message);
        assert.equal(messages.filter((message) => message.role === "user").length, PROFILES.quick.turnsPerSession);
        assert.equal(messages.filter((message) => message.role === "assistant").length, PROFILES.quick.turnsPerSession);
        assert.equal(messages.filter((message) => message.role === "toolResult").length, PROFILES.quick.turnsPerSession * PROFILES.quick.toolsPerTurn);
        for (const assistant of messages.filter((message) => message.role === "assistant")) {
          assert.ok(assistant.content.some((part) => part.type === "text"));
          assert.ok(assistant.content.some((part) => part.type === "toolCall"));
        }
      }
    } finally {
      await fixtures.cleanup();
    }

    await assert.rejects(stat(fixtures.rootPath));
    await fixtures.cleanup();
  });

  it("supports profile overrides and reports per-session counts", async () => {
    const fixtures = await createFixtures({ profile: "quick", sessions: 2, turnsPerSession: 2, toolsPerTurn: 2 });
    try {
      assert.equal(fixtures.sessions.length, 2);
      assert.deepEqual(fixtures.profileConfig, {
        sessions: 2,
        turnsPerSession: 2,
        toolsPerTurn: 2,
        workspaceFiles: PROFILES.quick.workspaceFiles,
        wsEvents: PROFILES.quick.wsEvents,
        wsSubscribers: PROFILES.quick.wsSubscribers,
      });
      assert.equal(fixtures.fixtureCounts.turns, 4);
      assert.equal(fixtures.fixtureCounts.toolCalls, 8);
      assert.equal(fixtures.fixtureCounts.jsonlRecords, 2 * (1 + 1 + 2 * (2 + 2)));
      for (const session of fixtures.sessions) {
        assert.equal(session.counts.turns, 2);
        assert.equal(session.counts.toolCalls, 4);
        assert.equal(session.counts.toolResults, 4);
        assert.equal(session.counts.jsonlRecords, 10);
        assert.equal(session.workspaceId, fixtures.workspaceId);
      }
    } finally {
      await fixtures.cleanup();
    }
  });

  it("writes rich fixture content as valid multiline Markdown", async () => {
    const fixtures = await createFixtures({ profile: "quick", richContent: true, sessions: 1, turnsPerSession: 1, toolsPerTurn: 1 });
    try {
      const session = fixtures.sessions[0];
      assert.ok(session !== undefined);
      const records = (await readFile(session.path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      const assistant = records.find((record) => record.message?.role === "assistant");
      const text = assistant.message.content.find((part) => part.type === "text")?.text;
      assert.match(text, /```ts\nexport function benchmark1\(\): string \{ return "ok"; \}\n```/);
      assert.doesNotMatch(text, /\\n/);
      const workspaceSource = await readFile(`${fixtures.workspacePath}/src/benchmark-00001.ts`, "utf8");
      assert.match(workspaceSource, /;\n$/);
    } finally {
      await fixtures.cleanup();
    }
  });

  it("rejects unknown profiles and invalid counts", async () => {
    await assert.rejects(createFixtures({ profile: "missing" }), RangeError);
    await assert.rejects(createFixtures({ sessions: 0 }), RangeError);
    await assert.rejects(createFixtures({ turnsPerSession: 1.5 }), RangeError);
  });
});
