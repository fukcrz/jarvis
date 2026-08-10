import { describe, expect, it } from "vitest";
import type { ComposerCommand } from "../shared/protocol";
import { completionContextFor, completionReplacement, matchingComposerCommands } from "./composer-completion";

const commands: ComposerCommand[] = [
  { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
  { name: "review", description: "Review the current change", source: "extension" },
];

describe("composer completion", () => {
  it("derives token ranges from the current cursor", () => {
    expect(completionContextFor("/fi", 3)).toEqual({ trigger: "/", query: "fi", from: 0, to: 3 });
    expect(completionContextFor("Review @src/client", 18)).toEqual({ trigger: "@", query: "src/client", from: 7, to: 18 });
    expect(completionContextFor("/review later", 3)).toEqual({ trigger: "/", query: "re", from: 0, to: 7 });
    expect(completionContextFor("/review", 0)).toBeUndefined();
  });

  it("does not offer a command completion after ordinary message text", () => {
    expect(completionContextFor("Explain /fi", 11)).toBeUndefined();
  });

  it("matches an already typed slash query after commands arrive", () => {
    expect(matchingComposerCommands([], "fi")).toEqual([]);
    expect(matchingComposerCommands(commands, "fi")).toEqual([commands[0]]);
  });

  it("preserves an existing argument delimiter when applying a completion", () => {
    const withArgument = completionContextFor("/ret existing", 4);
    const withoutArgument = completionContextFor("/ret", 4);
    if (withArgument === undefined || withoutArgument === undefined) throw new Error("Expected completion contexts");

    expect(completionReplacement("/ret existing", withArgument, "/retry-command")).toEqual({
      from: 0,
      to: 4,
      insert: "/retry-command",
      cursor: 15,
    });
    expect(completionReplacement("/ret", withoutArgument, "/retry-command")).toEqual({
      from: 0,
      to: 4,
      insert: "/retry-command ",
      cursor: 15,
    });
  });
});
