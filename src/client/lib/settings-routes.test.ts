import { describe, expect, it, vi } from "vitest";
import { canPopHistory, categoryRoute, isSettingsPath, legacySettingsRedirect, navigateBackOr, parentSettingsRoute, parseSettingsPath, settingsCategoryOf, settingsPath, type SettingsRoute } from "./settings-routes";

const routes: SettingsRoute[] = [
  { page: "home" },
  { page: "general" },
  { page: "notifications" },
  { page: "models" },
  { page: "provider-new" },
  { page: "provider", providerId: "openai" },
  { page: "provider", providerId: "local/custom" },
  { page: "model-groups" },
  { page: "plugins" },
  { page: "skills" },
  { page: "skill-files", skillId: "browser-qa" },
  { page: "workspaces" },
  { page: "remote" },
  { page: "about" },
];

describe("settings routes", () => {
  it("round-trips every settings page through the hash path", () => {
    for (const route of routes) {
      expect(parseSettingsPath(settingsPath(route))).toEqual(route);
    }
  });

  it("encodes provider ids that contain reserved characters", () => {
    expect(settingsPath({ page: "provider", providerId: "local/custom" })).toBe("/settings/models/local%2Fcustom");
    expect(parseSettingsPath("/settings/models/local%2Fcustom")).toEqual({ page: "provider", providerId: "local/custom" });
  });

  it("rejects unknown or non-settings paths", () => {
    expect(parseSettingsPath("/projects")).toBeUndefined();
    expect(parseSettingsPath("/settings/unknown")).toBeUndefined();
    expect(parseSettingsPath("/settings/models/new/edit")).toBeUndefined();
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/workspaces")).toBe(true);
    expect(isSettingsPath("/sessions/abc")).toBe(false);
  });

  it("redirects every pre-redesign settings address to its new home", () => {
    expect(legacySettingsRedirect("/settings/assistant-name")).toEqual({ route: { page: "general" }, focus: "assistant-name" });
    expect(legacySettingsRedirect("/settings/appearance")).toEqual({ route: { page: "general" } });
    expect(legacySettingsRedirect("/settings/providers")).toEqual({ route: { page: "models" } });
    expect(legacySettingsRedirect("/settings/providers/new")).toEqual({ route: { page: "provider-new" } });
    expect(legacySettingsRedirect("/settings/providers/openai")).toEqual({ route: { page: "provider", providerId: "openai" } });
    expect(legacySettingsRedirect("/settings/providers/local%2Fcustom/edit")).toEqual({ route: { page: "provider", providerId: "local/custom" }, focus: "connection" });
    expect(legacySettingsRedirect("/settings/providers/anthropic/override")).toEqual({ route: { page: "provider", providerId: "anthropic" }, focus: "connection" });
    expect(legacySettingsRedirect("/settings/model-scope")).toEqual({ route: { page: "models" }, focus: "enabled-models" });
    expect(legacySettingsRedirect("/settings/tunnel")).toEqual({ route: { page: "remote" }, focus: "tunnels" });
    expect(legacySettingsRedirect("/settings/security")).toEqual({ route: { page: "remote" }, focus: "password" });
    expect(parseSettingsPath("/settings/plugins")).toEqual({ page: "plugins" });
    expect(parseSettingsPath("/settings/skills")).toEqual({ page: "skills" });
    expect(parseSettingsPath("/settings/skills/browser-qa")).toEqual({ page: "skill-files", skillId: "browser-qa" });
    expect(legacySettingsRedirect("/settings/plugins/install")).toEqual({ route: { page: "plugins" }, openInstall: true });
    expect(legacySettingsRedirect("/settings/plugins/model-groups")).toEqual({ route: { page: "model-groups" } });
    expect(legacySettingsRedirect("/settings/data")).toEqual({ route: { page: "about" }, focus: "diagnostics" });
    expect(legacySettingsRedirect("/settings/workspaces")).toBeUndefined();
    expect(legacySettingsRedirect("/settings/nope")).toBeUndefined();
  });

  it("maps pages to their category and back", () => {
    expect(settingsCategoryOf({ page: "provider", providerId: "x" })).toBe("models");
    expect(settingsCategoryOf({ page: "plugins" })).toBe("plugins");
    expect(settingsCategoryOf({ page: "skill-files", skillId: "x" })).toBe("skills");
    expect(settingsCategoryOf({ page: "home" })).toBeUndefined();
    expect(categoryRoute("plugins")).toEqual({ page: "plugins" });
    expect(categoryRoute("skills")).toEqual({ page: "skills" });
    expect(categoryRoute("remote")).toEqual({ page: "remote" });
  });

  it("walks back to the parent page when history cannot pop", () => {
    expect(parentSettingsRoute({ page: "home" })).toBeUndefined();
    expect(parentSettingsRoute({ page: "workspaces" })).toEqual({ page: "home" });
    expect(parentSettingsRoute({ page: "skill-files", skillId: "browser-qa" })).toEqual({ page: "skills" });
    expect(parentSettingsRoute({ page: "provider", providerId: "openai" })).toEqual({ page: "models" });
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
