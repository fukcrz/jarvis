import { afterEach, describe, expect, it } from "vitest";
import { desktopEnabled, formatDesktopEvent } from "./desktop-bridge.js";

const original = process.env["JARVIS_DESKTOP"];

afterEach(() => {
  if (original === undefined) delete process.env["JARVIS_DESKTOP"];
  else process.env["JARVIS_DESKTOP"] = original;
});

describe("desktop-bridge", () => {
  it("only enables when JARVIS_DESKTOP=1", () => {
    delete process.env["JARVIS_DESKTOP"];
    expect(desktopEnabled()).toBe(false);
    process.env["JARVIS_DESKTOP"] = "1";
    expect(desktopEnabled()).toBe(true);
  });

  it("formats a single stdout line", () => {
    expect(formatDesktopEvent({ type: "ready", port: 9528 })).toBe("JARVIS_DESKTOP:{\"type\":\"ready\",\"port\":9528}\n");
  });
});
