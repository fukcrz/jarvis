import { describe, expect, it } from "vitest";
import { isMissingFile } from "./fs.js";
import { numberValue, stringValue, toIso } from "./values.js";

describe("stringValue", () => {
  it("returns strings unchanged and everything else as empty", () => {
    expect(stringValue("ok")).toBe("ok");
    expect(stringValue("")).toBe("");
    expect(stringValue(1)).toBe("");
    expect(stringValue(undefined)).toBe("");
    expect(stringValue(null)).toBe("");
  });
});

describe("numberValue", () => {
  it("returns finite numbers only", () => {
    expect(numberValue(3)).toBe(3);
    expect(numberValue(Number.NaN)).toBeUndefined();
    expect(numberValue("3")).toBeUndefined();
  });
});

describe("toIso", () => {
  it("accepts epoch millis and parseable date strings", () => {
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIso("2026-08-09T00:00:00.000Z")).toBe("2026-08-09T00:00:00.000Z");
  });
});

describe("isMissingFile", () => {
  it("detects ENOENT and rejects other failures", () => {
    expect(isMissingFile({ code: "ENOENT" })).toBe(true);
    expect(isMissingFile({ code: "EACCES" })).toBe(false);
    expect(isMissingFile(new Error("missing"))).toBe(false);
    expect(isMissingFile(undefined)).toBe(false);
  });
});
