import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installVisualViewportHeight,
  isTextEditingElement,
  isVisualViewportKeyboardInsetLocked,
  lockVisualViewportKeyboardInset,
  resolveVisualViewportHeight,
  unlockVisualViewportKeyboardInset,
} from "./visual-viewport";

describe("isTextEditingElement", () => {
  it("treats contenteditable and text fields as editing", () => {
    expect(isTextEditingElement({ isContentEditable: true })).toBe(true);
    expect(isTextEditingElement({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEditingElement({ tagName: "INPUT" })).toBe(true);
    expect(isTextEditingElement({ tagName: "INPUT", type: "search" })).toBe(true);
  });

  it("ignores file inputs and other non-text controls", () => {
    expect(isTextEditingElement(null)).toBe(false);
    expect(isTextEditingElement({ tagName: "INPUT", type: "file" })).toBe(false);
    expect(isTextEditingElement({ tagName: "INPUT", type: "button" })).toBe(false);
    expect(isTextEditingElement({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEditingElement({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
  });
});

describe("resolveVisualViewportHeight", () => {
  it("uses the visual height while a text field is focused", () => {
    expect(resolveVisualViewportHeight({ visualHeight: 420, innerHeight: 860, editing: true, closedHeight: 860 }).height).toBe(420);
  });

  it("drops a leftover keyboard inset when nothing is editing", () => {
    expect(resolveVisualViewportHeight({ visualHeight: 420, innerHeight: 860, editing: false, closedHeight: 860 }).height).toBe(860);
  });

  it("keeps a small chrome inset when the keyboard is not involved", () => {
    expect(resolveVisualViewportHeight({ visualHeight: 800, innerHeight: 860, editing: false }).height).toBe(800);
  });

  it("falls back to innerHeight when visual height is unusable", () => {
    expect(resolveVisualViewportHeight({ visualHeight: 0, innerHeight: 860, editing: true }).height).toBe(860);
  });

  it("uses the closed height when the picker lock is on and iOS restored editor focus", () => {
    expect(resolveVisualViewportHeight({
      visualHeight: 420,
      innerHeight: 860,
      editing: true,
      locked: true,
      closedHeight: 860,
    }).height).toBe(860);
  });

  it("uses the closed height when innerHeight is also stuck at the keyboard size", () => {
    expect(resolveVisualViewportHeight({
      visualHeight: 420,
      innerHeight: 420,
      editing: true,
      locked: true,
      closedHeight: 860,
    }).height).toBe(860);
  });

  it("remembers the closed height after a recovered viewport", () => {
    expect(resolveVisualViewportHeight({ visualHeight: 860, innerHeight: 860, editing: false, closedHeight: 0 }).closedHeight).toBe(860);
  });
});

describe("installVisualViewportHeight", () => {
  afterEach(() => {
    vi.useRealTimers();
    unlockVisualViewportKeyboardInset();
  });

  function harness(options: {
    visualHeight: number;
    innerHeight: number;
    active?: { isContentEditable?: boolean; tagName?: string; type?: string } | null;
  }) {
    const state = {
      visualHeight: options.visualHeight,
      innerHeight: options.innerHeight,
      active: options.active ?? null as { isContentEditable?: boolean; tagName?: string; type?: string } | null,
    };
    const props = new Map<string, string>();
    const docListeners = new Map<string, Set<() => void>>();
    const viewListeners = new Map<string, Set<() => void>>();
    const vvListeners = new Map<string, Set<() => void>>();
    const add = (store: Map<string, Set<() => void>>) => (type: string, listener: EventListenerOrEventListenerObject) => {
      const set = store.get(type) ?? new Set();
      set.add(listener as () => void);
      store.set(type, set);
    };
    const remove = (store: Map<string, Set<() => void>>) => (type: string, listener: EventListenerOrEventListenerObject) => {
      store.get(type)?.delete(listener as () => void);
    };
    const visualViewport = {
      get height() { return state.visualHeight; },
      addEventListener: add(vvListeners),
      removeEventListener: remove(vvListeners),
    };
    const view = {
      get innerHeight() { return state.innerHeight; },
      visualViewport,
      addEventListener: add(viewListeners),
      removeEventListener: remove(viewListeners),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    const doc = {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => { props.set(name, value); },
        },
      },
      get activeElement() { return state.active; },
      defaultView: view,
      addEventListener: add(docListeners),
      removeEventListener: remove(docListeners),
    } as unknown as Document;
    const dispatch = (store: Map<string, Set<() => void>>, type: string) => {
      for (const listener of store.get(type) ?? []) listener();
    };
    return {
      state,
      vvh: () => props.get("--vvh"),
      dispatchFocusIn: () => dispatch(docListeners, "focusin"),
      dispatchWindowFocus: () => dispatch(viewListeners, "focus"),
      listenerCount: () =>
        [...docListeners.values(), ...viewListeners.values(), ...vvListeners.values()]
          .reduce((sum, set) => sum + set.size, 0),
      uninstall: installVisualViewportHeight(doc),
    };
  }

  it("writes visual height while editing", () => {
    const env = harness({ visualHeight: 420, innerHeight: 860, active: { isContentEditable: true } });
    expect(env.vvh()).toBe("420px");
    env.uninstall();
  });

  it("ignores a leftover keyboard inset for a focused file input", () => {
    const env = harness({ visualHeight: 420, innerHeight: 860, active: { tagName: "INPUT", type: "file" } });
    expect(env.vvh()).toBe("860px");
    env.uninstall();
  });

  it("recomputes after focus moves off the editor", () => {
    const env = harness({ visualHeight: 420, innerHeight: 860, active: { isContentEditable: true } });
    expect(env.vvh()).toBe("420px");
    env.state.active = { tagName: "INPUT", type: "file" };
    env.dispatchFocusIn();
    expect(env.vvh()).toBe("860px");
    env.uninstall();
  });

  it("retries after window focus in case iOS reports the keyboard height late", () => {
    vi.useFakeTimers();
    const env = harness({ visualHeight: 420, innerHeight: 860, active: { isContentEditable: true } });
    env.dispatchWindowFocus();
    expect(env.vvh()).toBe("420px");
    env.state.visualHeight = 860;
    vi.advanceTimersByTime(50);
    expect(env.vvh()).toBe("860px");
    env.uninstall();
    expect(env.listenerCount()).toBe(0);
  });

  it("keeps the closed height after locking even if the editor is focused again", () => {
    const env = harness({ visualHeight: 860, innerHeight: 860, active: null });
    expect(env.vvh()).toBe("860px");
    env.state.visualHeight = 420;
    env.state.innerHeight = 420;
    env.state.active = { isContentEditable: true };
    lockVisualViewportKeyboardInset();
    expect(isVisualViewportKeyboardInsetLocked()).toBe(true);
    expect(env.vvh()).toBe("860px");
    env.uninstall();
  });
});
