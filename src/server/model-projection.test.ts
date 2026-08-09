import { describe, expect, it } from "vitest";
import { projectModelSnapshot } from "./model-projection.js";

describe("projectModelSnapshot", () => {
  it("keeps only stable browser fields, deduplicates models, and sorts providers", () => {
    const snapshot = projectModelSnapshot(
      { provider: "relay", id: "terra", name: "Terra", reasoning: true, apiKey: "secret" },
      [
        { provider: "deepseek", id: "pro", name: "Pro", reasoning: true, baseUrl: "https://private.example" },
        { provider: "relay", id: "terra", name: "Terra", reasoning: true },
        { provider: "relay", id: "terra", name: "Duplicate", reasoning: false },
        { provider: "invalid" },
      ],
    );

    expect(snapshot).toEqual({
      current: { provider: "relay", id: "terra", name: "Terra", reasoning: true },
      available: [
        { provider: "deepseek", id: "pro", name: "Pro", reasoning: true },
        { provider: "relay", id: "terra", name: "Terra", reasoning: true },
      ],
    });
  });
});
