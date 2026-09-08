import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMobileExpandedGroups, saveMobileExpandedGroups } from "./mobile-navigation.js";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile session group expansion", () => {
  it("restores persisted group states", () => {
    saveMobileExpandedGroups({ projectA: true, projectB: false });

    expect(readMobileExpandedGroups()).toEqual({ projectA: true, projectB: false });
  });

  it("ignores malformed or invalid persisted state", () => {
    storage.set("jarvis.mobile.projects.expanded", '{"projectA":true,"projectB":"yes"}');
    expect(readMobileExpandedGroups()).toEqual({ projectA: true });

    storage.set("jarvis.mobile.projects.expanded", "invalid-json");
    expect(readMobileExpandedGroups()).toEqual({});
  });
});
