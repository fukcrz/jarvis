import { describe, expect, it } from "vitest";
import { displayModelName } from "./model-display";

describe("displayModelName", () => {
  it("removes a trailing provider suffix from Pi display names", () => {
    expect(displayModelName("GPT-5.6 Luna (Anzhiyu)")).toBe("GPT-5.6 Luna");
    expect(displayModelName("GPT-5.6 Sol (Relay)")).toBe("GPT-5.6 Sol");
  });

  it("leaves names without a trailing parenthetical unchanged", () => {
    expect(displayModelName("DeepSeek V4 Flash")).toBe("DeepSeek V4 Flash");
  });
});
