import { describe, expect, it } from "vitest";
import type { ModelDescriptor, ThinkingLevel } from "../shared/protocol";
import { cycleModelCandidate, cycleThinkingCandidate, modelKey } from "./shortcuts";

function model(provider: string, id: string, inScope = true): ModelDescriptor {
  return { provider, id, name: `${provider}/${id}`, reasoning: true, vision: false, inScope };
}

describe("cycleModelCandidate", () => {
  it("advances to the next enabled model and wraps around", () => {
    const models = [model("a", "m1"), model("a", "m2"), model("a", "m3")];
    expect(cycleModelCandidate(models, models[0], 1)?.id).toBe("m2");
    expect(cycleModelCandidate(models, models[1], 1)?.id).toBe("m3");
    expect(cycleModelCandidate(models, models[2], 1)?.id).toBe("m1");
  });

  it("moves backward when direction is -1", () => {
    const models = [model("a", "m1"), model("a", "m2"), model("a", "m3")];
    expect(cycleModelCandidate(models, models[0], -1)?.id).toBe("m3");
    expect(cycleModelCandidate(models, models[1], -1)?.id).toBe("m1");
  });

  it("skips models outside the enabled scope", () => {
    const models = [model("a", "m1"), model("a", "m2", false), model("a", "m3")];
    expect(cycleModelCandidate(models, models[0], 1)?.id).toBe("m3");
    expect(cycleModelCandidate(models, models[2], 1)?.id).toBe("m1");
  });

  it("starts from the first enabled model when no model is selected", () => {
    const models = [model("a", "m1"), model("a", "m2", false), model("a", "m3")];
    expect(cycleModelCandidate(models, undefined, 1)?.id).toBe("m1");
  });

  it("starts from the last enabled model when current is disabled and cycling backward", () => {
    const models = [model("a", "m1"), model("a", "m2", false), model("a", "m3")];
    expect(cycleModelCandidate(models, models[1], -1)?.id).toBe("m3");
  });

  it("returns undefined when fewer than two models are enabled", () => {
    expect(cycleModelCandidate([model("a", "m1")], undefined, 1)).toBeUndefined();
    expect(cycleModelCandidate([model("a", "m1", false)], undefined, 1)).toBeUndefined();
    expect(cycleModelCandidate([], undefined, 1)).toBeUndefined();
  });
});

describe("cycleThinkingCandidate", () => {
  const levels: ThinkingLevel[] = ["off", "low", "high"];

  it("advances to the next level and wraps around", () => {
    expect(cycleThinkingCandidate(levels, "off")).toBe("low");
    expect(cycleThinkingCandidate(levels, "low")).toBe("high");
    expect(cycleThinkingCandidate(levels, "high")).toBe("off");
  });

  it("starts from the first level when current is not available", () => {
    expect(cycleThinkingCandidate(levels, "medium")).toBe("off");
  });

  it("returns undefined when fewer than two levels are available", () => {
    expect(cycleThinkingCandidate(["off"], "off")).toBeUndefined();
    expect(cycleThinkingCandidate([], "off")).toBeUndefined();
  });
});

describe("modelKey", () => {
  it("combines provider and id with a separator", () => {
    expect(modelKey({ provider: "a", id: "m" })).toBe("a\u0000m");
  });
});
