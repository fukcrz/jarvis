import { describe, expect, it, vi } from "vitest";
import { canPopHistory, isSettingsPath, navigateBackOr, parentSettingsRoute, parseSettingsPath, settingsPath, type SettingsRoute } from "./settings-routes";

const routes: SettingsRoute[] = [
  { page: "home" },
  { page: "assistant-name" },
  { page: "providers" },
  { page: "provider-new" },
  { page: "provider", providerId: "openai" },
  { page: "provider-edit", providerId: "local/custom" },
  { page: "provider-override", providerId: "anthropic" },
  { page: "model-scope" },
  { page: "workspaces" },
  { page: "tunnel" },
  { page: "security" },
];

describe("settings routes", () => {
  it("round-trips every settings page through the hash path", () => {
    for (const route of routes) {
      expect(parseSettingsPath(settingsPath(route))).toEqual(route);
    }
  });

  it("encodes provider ids that contain reserved characters", () => {
    expect(settingsPath({ page: "provider", providerId: "local/custom" })).toBe("/settings/providers/local%2Fcustom");
    expect(parseSettingsPath("/settings/providers/local%2Fcustom/edit")).toEqual({ page: "provider-edit", providerId: "local/custom" });
  });

  it("rejects unknown or non-settings paths", () => {
    expect(parseSettingsPath("/projects")).toBeUndefined();
    expect(parseSettingsPath("/settings/unknown")).toBeUndefined();
    expect(parseSettingsPath("/settings/providers/new/edit")).toBeUndefined();
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/workspaces")).toBe(true);
    expect(isSettingsPath("/sessions/abc")).toBe(false);
  });

  it("walks back to the parent page when history cannot pop", () => {
    expect(parentSettingsRoute({ page: "home" })).toBeUndefined();
    expect(parentSettingsRoute({ page: "workspaces" })).toEqual({ page: "home" });
    expect(parentSettingsRoute({ page: "provider", providerId: "openai" })).toEqual({ page: "providers" });
    expect(parentSettingsRoute({ page: "provider-edit", providerId: "openai" })).toEqual({ page: "provider", providerId: "openai" });
    expect(parentSettingsRoute({ page: "provider-edit", providerId: "gone" }, { hasProvider: false })).toEqual({ page: "providers" });
  });

  it("only pops when React Router has a previous index", () => {
    expect(canPopHistory(null)).toBe(false);
    expect(canPopHistory({ idx: 0 })).toBe(false);
    expect(canPopHistory({ idx: 2 })).toBe(true);
    expect(canPopHistory({ idx: 1.5 })).toBe(false);
  });

  it("pops in-app history and otherwise uses the fallback", () => {
    const navigate = vi.fn();
    const fallback = vi.fn();
    navigateBackOr(navigate, fallback, { idx: 3 });
    expect(navigate).toHaveBeenCalledWith(-1);
    expect(fallback).not.toHaveBeenCalled();

    navigate.mockClear();
    navigateBackOr(navigate, fallback, { idx: 0 });
    expect(navigate).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
