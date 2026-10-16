import { describe, expect, it } from "vitest";
import { BETA_MANIFEST_URL, buildManifest, compareVersions, isPrerelease, parseVersion, planManifests } from "./desktop-release.mjs";

describe("desktop release versions", () => {
  it("orders prereleases before the matching stable release", () => {
    const ordered = ["0.1.27", "0.1.28-alpha.1", "0.1.28-beta.1", "0.1.28-beta.2", "0.1.28-beta.10", "0.1.28-rc.1", "0.1.28", "0.1.29-beta.1", "0.2.0"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(compareVersions(ordered[index - 1], ordered[index]), `${ordered[index - 1]} < ${ordered[index]}`).toBe(-1);
      expect(compareVersions(ordered[index], ordered[index - 1])).toBe(1);
    }
    expect(compareVersions("v0.1.28", "0.1.28")).toBe(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBe(-1);
  });

  it("accepts stable and prerelease versions but rejects build metadata", () => {
    expect(isPrerelease("0.1.28-beta.1")).toBe(true);
    expect(isPrerelease("0.1.28")).toBe(false);
    expect(parseVersion("v1.2.3").patch).toBe(3);
    expect(() => parseVersion("0.1.28+build.5")).toThrow();
    expect(() => parseVersion("0.1")).toThrow();
    expect(() => parseVersion("01.1.1")).toThrow();
  });
});

describe("desktop release manifests", () => {
  it("writes stable releases to both channels unless beta is already ahead", () => {
    expect(planManifests("0.1.28", "0.1.28-beta.2")).toEqual({ prerelease: false, latest: true, beta: true });
    expect(planManifests("0.1.28", undefined)).toEqual({ prerelease: false, latest: true, beta: true });
    expect(planManifests("0.1.28", "0.1.29-beta.1")).toEqual({ prerelease: false, latest: true, beta: false });
  });

  it("writes prereleases only to the beta channel", () => {
    expect(planManifests("0.1.29-beta.1", "0.1.28")).toEqual({ prerelease: true, latest: false, beta: true });
    expect(planManifests("0.1.29-beta.1", "0.1.29-beta.2")).toEqual({ prerelease: true, latest: false, beta: false });
  });

  it("points the installer URL at the version tag", () => {
    const manifest = buildManifest({ version: "0.1.28-beta.1", exe: "Jarvis_0.1.28-beta.1_x64-setup.exe", signature: "sig", pubDate: "2026-10-16T00:00:00.000Z" });
    expect(manifest.platforms["windows-x86_64"].url).toBe("https://github.com/fukcrz/jarvis/releases/download/v0.1.28-beta.1/Jarvis_0.1.28-beta.1_x64-setup.exe");
    expect(BETA_MANIFEST_URL).toBe("https://github.com/fukcrz/jarvis/releases/download/updater-beta/beta.json");
  });
});
