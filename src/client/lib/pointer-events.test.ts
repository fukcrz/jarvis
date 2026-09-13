import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTouchFocus, hasBlockingOverlay, installTouchFocusGuard, restoreBodyPointerEventsIfIdle } from "./pointer-events";

function fakeDocument(pointerEvents: string, overlay: boolean, overlayClass = "dialog-overlay"): Document {
  const overlayNode = overlay ? { className: overlayClass } : null;
  return {
    body: { style: { pointerEvents } },
    querySelector: (selector: string) => {
      const tokens = selector.split(",").map((part) => part.trim());
      return overlay && tokens.includes(`.${overlayClass}`) ? overlayNode : null;
    },
  } as unknown as Document;
}

function fakeControl(tagName: string, options?: { overlay?: boolean; active?: object }): { control: { matches: (selector: string) => boolean; blur: () => void; tagName: string; closest: () => unknown }; doc: Document; blurred: () => boolean } {
  let blurred = false;
  const control = {
    tagName,
    matches: (selector: string) => {
      if (selector === "input, textarea, select") return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
      return selector.includes(tagName.toLowerCase()) || selector.includes("[role=\"button\"]");
    },
    closest: () => control,
    blur: () => { blurred = true; },
  };
  const overlayNode = options?.overlay === true ? { className: "dialog-overlay" } : null;
  const doc = {
    activeElement: options?.active ?? control,
    body: { style: { pointerEvents: "" } },
    querySelector: (selector: string) => {
      const tokens = selector.split(",").map((part) => part.trim());
      return overlayNode !== null && tokens.includes(".dialog-overlay") ? overlayNode : null;
    },
  } as unknown as Document;
  return { control, doc, blurred: () => blurred };
}

describe("clearTouchFocus", () => {
  it("blurs the tapped button when it still owns focus", () => {
    const { control, doc, blurred } = fakeControl("BUTTON");
    expect(clearTouchFocus(control as unknown as Element, doc)).toBe(true);
    expect(blurred()).toBe(true);
  });

  it("blurs a tapped link", () => {
    const { control, doc, blurred } = fakeControl("A");
    expect(clearTouchFocus(control as unknown as Element, doc)).toBe(true);
    expect(blurred()).toBe(true);
  });

  it("keeps focus that was moved into an overlay", () => {
    const tapped = fakeControl("BUTTON");
    const dialogClose = fakeControl("BUTTON", { overlay: true });
    expect(clearTouchFocus(tapped.control as unknown as Element, dialogClose.doc)).toBe(false);
    expect(dialogClose.blurred()).toBe(false);
  });

  it("blurs a restored trigger after the overlay has closed", () => {
    const trigger = fakeControl("BUTTON");
    const sheetItem = { ...fakeControl("BUTTON").control };
    expect(clearTouchFocus(sheetItem as unknown as Element, trigger.doc)).toBe(true);
    expect(trigger.blurred()).toBe(true);
  });

  it("does not blur text inputs", () => {
    const { control, doc, blurred } = fakeControl("INPUT");
    expect(clearTouchFocus(control as unknown as Element, doc)).toBe(false);
    expect(blurred()).toBe(false);
  });
});

describe("installTouchFocusGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(overlay = false) {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    const { control, doc, blurred } = fakeControl("BUTTON", { overlay });
    const guarded = {
      ...doc,
      defaultView: globalThis,
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener as (event: Event) => void);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener as (event: Event) => void);
      },
    } as unknown as Document;
    const dispatch = (type: string, event: object) => {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    };
    return { control, dispatch, blurred, uninstall: installTouchFocusGuard(guarded) };
  }

  it("clears focus after a touch click sequence", () => {
    vi.useFakeTimers();
    const { control, dispatch, blurred, uninstall } = harness();
    dispatch("pointerdown", { pointerId: 1, pointerType: "touch", target: control });
    dispatch("pointerup", { pointerId: 1, pointerType: "touch", target: control });
    dispatch("click", {});
    vi.runAllTimers();
    expect(blurred()).toBe(true);
    uninstall();
  });

  it("does not clear focus after a mouse click", () => {
    vi.useFakeTimers();
    const { control, dispatch, blurred, uninstall } = harness();
    dispatch("pointerdown", { pointerId: 1, pointerType: "mouse", target: control });
    dispatch("pointerup", { pointerId: 1, pointerType: "mouse", target: control });
    dispatch("click", {});
    vi.runAllTimers();
    expect(blurred()).toBe(false);
    uninstall();
  });

  it("keeps the first pointer's target when a second finger lands elsewhere", () => {
    vi.useFakeTimers();
    const { control, dispatch, blurred, uninstall } = harness();
    dispatch("pointerdown", { pointerId: 1, pointerType: "touch", target: control });
    dispatch("pointerdown", { pointerId: 2, pointerType: "touch", target: { closest: () => null } });
    dispatch("pointerup", { pointerId: 2, pointerType: "touch", target: null });
    dispatch("pointerup", { pointerId: 1, pointerType: "touch", target: control });
    dispatch("click", {});
    vi.runAllTimers();
    expect(blurred()).toBe(true);
    uninstall();
  });

  it("does not clear focus when the gesture is cancelled", () => {
    vi.useFakeTimers();
    const { control, dispatch, blurred, uninstall } = harness();
    dispatch("pointerdown", { pointerId: 1, pointerType: "touch", target: control });
    dispatch("pointercancel", { pointerId: 1, pointerType: "touch", target: control });
    dispatch("click", {});
    vi.runAllTimers();
    expect(blurred()).toBe(false);
    uninstall();
  });
});

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

  it("keeps none while the file browser overlay is still open", () => {
    const doc = fakeDocument("none", true, "file-browser-overlay");
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
