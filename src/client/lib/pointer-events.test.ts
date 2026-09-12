import { describe, expect, it } from "vitest";
import { hasBlockingOverlay, restoreBodyPointerEventsIfIdle } from "./pointer-events";

function fakeDocument(pointerEvents: string, overlay: boolean): Document {
  const overlayNode = overlay ? { className: "dialog-overlay" } : null;
  return {
    body: { style: { pointerEvents } },
    querySelector: (selector: string) => {
      const tokens = selector.split(",").map((part) => part.trim());
      return overlay && tokens.includes(".dialog-overlay") ? overlayNode : null;
    },
  } as unknown as Document;
}

describe("restoreBodyPointerEventsIfIdle", () => {
  it("clears leftover none when no overlay remains", () => {
    const doc = fakeDocument("none", false);
    expect(restoreBodyPointerEventsIfIdle(doc)).toBe(true);
    expect(doc.body.style.pointerEvents).toBe("");
  });

  it("keeps none while a dialog overlay is still open", () => {
    const doc = fakeDocument("none", true);
    expect(hasBlockingOverlay(doc)).toBe(true);
    expect(restoreBodyPointerEventsIfIdle(doc)).toBe(false);
    expect(doc.body.style.pointerEvents).toBe("none");
  });

  it("does not touch other pointer-events values", () => {
    const doc = fakeDocument("auto", false);
    expect(restoreBodyPointerEventsIfIdle(doc)).toBe(false);
    expect(doc.body.style.pointerEvents).toBe("auto");
  });
});
