import { describe, expect, it } from "vitest";
import {
  downloadProgressLabel,
  formatByteSize,
  initialUpdateSession,
  reduceUpdateSession,
  updateCheckDisposition,
  updateErrorMessage,
  runningSessionLabel,
  updateNotes,
  updateVersionLabel,
  type UpdateAction,
  type UpdateOffer,
  type UpdateSession,
} from "./desktop-update";

const offer: UpdateOffer = { version: "0.1.15", currentVersion: "0.1.14", notes: "修复更新" };

function apply(actions: UpdateAction[], start: UpdateSession = initialUpdateSession()): UpdateSession {
  return actions.reduce(reduceUpdateSession, start);
}

describe("desktop update session", () => {
  it("opens a download prompt for a background update and stays quiet when that version was dismissed", () => {
    const found = apply([{ type: "check-found", manual: false, offer, downloaded: false }]);
    expect(found.phase).toEqual({ kind: "available", offer });
    const dismissed = apply([{ type: "dismiss" }], found);
    expect(dismissed.phase.kind).toBe("closed");
    expect(dismissed.dismissed).toEqual(["0.1.15"]);
    expect(apply([{ type: "check-found", manual: false, offer, downloaded: false }], dismissed).phase.kind).toBe("closed");
    expect(apply([{ type: "check-found", manual: true, offer, downloaded: false }], dismissed).phase).toEqual({ kind: "available", offer });
  });

  it("keeps a downloaded package and asks to install on a later manual check", () => {
    const ready = apply([
      { type: "check-found", manual: false, offer, downloaded: false },
      { type: "download-started" },
      { type: "download-progress", received: 20, total: 100 },
      { type: "download-finished" },
    ]);
    expect(ready.phase).toEqual({ kind: "ready", offer });
    expect(ready.held).toEqual({ version: "0.1.15", downloaded: true });
    const dismissed = apply([{ type: "dismiss" }], ready);
    expect(apply([{ type: "check-found", manual: false, offer, downloaded: true }], dismissed).phase.kind).toBe("closed");
    const again = apply([
      { type: "check-started", manual: true },
      { type: "check-found", manual: true, offer, downloaded: true },
    ], dismissed);
    expect(again.phase).toEqual({ kind: "ready", offer });
    expect(again.held?.downloaded).toBe(true);
  });

  it("prompts again when a newer version appears", () => {
    const dismissed = apply([
      { type: "check-found", manual: false, offer, downloaded: false },
      { type: "dismiss" },
    ]);
    const newer = { ...offer, version: "0.1.16" };
    expect(apply([{ type: "check-found", manual: false, offer: newer, downloaded: false }], dismissed).phase).toEqual({ kind: "available", offer: newer });
  });

  it("shows manual check results and swallows background failures", () => {
    expect(apply([{ type: "check-failed", manual: false, error: "offline" }]).phase.kind).toBe("closed");
    expect(apply([{ type: "check-empty", manual: false }]).phase.kind).toBe("closed");
    expect(apply([{ type: "check-failed", manual: true, error: "offline" }]).phase).toEqual({ kind: "check-failed", error: "offline" });
    expect(apply([{ type: "check-started", manual: true }, { type: "check-empty", manual: true }]).phase).toEqual({ kind: "up-to-date" });
  });

  it("keeps the failure on screen and allows another download", () => {
    const failed = apply([
      { type: "check-found", manual: true, offer, downloaded: false },
      { type: "download-started" },
      { type: "download-failed", error: "reset" },
    ]);
    expect(failed.phase).toEqual({ kind: "download-failed", offer, error: "reset" });
    expect(failed.held?.downloaded).toBe(false);
    expect(apply([{ type: "check-found", manual: false, offer, downloaded: false }], failed).phase.kind).toBe("download-failed");
    expect(apply([{ type: "download-started" }, { type: "download-finished" }], failed).phase.kind).toBe("ready");
  });

  it("asks before installing when sessions are running and keeps the package after cancel or failure", () => {
    const ready = apply([
      { type: "check-found", manual: true, offer, downloaded: true },
      { type: "install-confirm", running: 2 },
    ]);
    expect(ready.phase).toEqual({ kind: "confirm-install", offer, running: 2 });
    expect(apply([{ type: "install-cancel" }], ready).phase).toEqual({ kind: "ready", offer });
    const failed = apply([{ type: "install-started" }, { type: "install-failed", error: "denied" }], ready);
    expect(failed.phase).toEqual({ kind: "ready", offer, error: "denied" });
    expect(failed.held).toEqual({ version: "0.1.15", downloaded: true });
  });

  it("ignores dismiss and background checks while downloading", () => {
    const downloading = apply([
      { type: "check-found", manual: false, offer, downloaded: false },
      { type: "download-started" },
    ]);
    expect(apply([{ type: "dismiss" }], downloading)).toBe(downloading);
    expect(apply([{ type: "check-found", manual: true, offer, downloaded: false }], downloading)).toBe(downloading);
    expect(updateCheckDisposition(downloading, true, offer.version)).toBe("drop");
  });
});

describe("desktop update labels", () => {
  it("formats version, notes, progress, and errors", () => {
    expect(updateVersionLabel(offer)).toBe("0.1.14 → 0.1.15");
    expect(updateVersionLabel({ version: "0.1.15", currentVersion: "0.1.15" })).toBe("0.1.15");
    expect(updateNotes("  说明  ")).toBe("说明");
    expect(updateNotes("  ")).toBeUndefined();
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(2_500_000)).toBe("2.4 MB");
    expect(downloadProgressLabel(50, 100)).toBe("50% · 50 B / 100 B");
    expect(downloadProgressLabel(0)).toBe("");
    expect(updateErrorMessage(" reset ")).toBe("reset");
    expect(updateErrorMessage(new Error("boom"))).toBe("boom");
    expect(updateErrorMessage({ code: 1 })).toBe("失败");
    expect(runningSessionLabel(2)).toBe("当前有 2 个正在运行的会话");
  });
});
