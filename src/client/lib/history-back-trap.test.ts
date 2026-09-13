import { describe, expect, it } from "vitest";
import { createHistoryBackTrap, isHistoryBackTrapState } from "./history-back-trap";

function fakeEnv(initial: unknown = null, options?: { delayBack?: boolean }) {
  const stack: unknown[] = [initial];
  const listeners = new Set<EventListener>();
  const delayed: Array<() => void> = [];
  const emit = () => {
    for (const listener of [...listeners]) listener(new Event("popstate"));
  };
  const doBack = () => {
    if (stack.length < 2) return;
    stack.pop();
    emit();
  };
  const history = {
    get state() {
      return stack[stack.length - 1];
    },
    pushState(data: unknown) {
      stack.push(data);
    },
    replaceState(data: unknown) {
      stack[stack.length - 1] = data;
    },
    back() {
      if (options?.delayBack === true) delayed.push(doBack);
      else doBack();
    },
  };
  const target = {
    addEventListener: (_type: string, listener: EventListener) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: EventListener) => { listeners.delete(listener); },
  };
  return {
    history,
    target,
    stack,
    listenerCount: () => listeners.size,
    popUser: doBack,
    flush: () => { while (delayed.length > 0) delayed.shift()?.(); },
  };
}

describe("history back trap", () => {
  it("intercepts back and rearms while the overlay stays open", () => {
    const env = fakeEnv({ router: 1 });
    const trap = createHistoryBackTrap(env);
    let backs = 0;
    const uninstall = trap.install(() => { backs += 1; });

    expect(isHistoryBackTrapState(env.history.state)).toBe(true);
    env.popUser();
    expect(backs).toBe(1);
    expect(isHistoryBackTrapState(env.history.state)).toBe(true);

    uninstall();
    expect(backs).toBe(1);
    expect(env.history.state).toEqual({ router: 1 });
    expect(env.listenerCount()).toBe(0);
  });

  it("does not fire onBack when the overlay closes itself", () => {
    const env = fakeEnv();
    const trap = createHistoryBackTrap(env);
    let backs = 0;
    const uninstall = trap.install(() => { backs += 1; });
    uninstall();
    expect(backs).toBe(0);
    expect(isHistoryBackTrapState(env.history.state)).toBe(false);
  });

  it("only the top overlay consumes back", () => {
    const env = fakeEnv();
    const trap = createHistoryBackTrap(env);
    const order: string[] = [];
    const lower = trap.install(() => { order.push("lower"); });
    const upper = trap.install(() => { order.push("upper"); });

    env.popUser();
    expect(order).toEqual(["upper"]);

    upper();
    env.popUser();
    expect(order).toEqual(["upper", "lower"]);
    lower();
  });

  it("ignores a delayed pop from its own uninstall after a remount", () => {
    const env = fakeEnv({ router: 1 }, { delayBack: true });
    const trap = createHistoryBackTrap(env);
    let backs = 0;
    const first = trap.install(() => { backs += 1; });
    first();
    const second = trap.install(() => { backs += 1; });
    env.flush();
    expect(backs).toBe(0);
    expect(isHistoryBackTrapState(env.history.state)).toBe(true);
    env.popUser();
    expect(backs).toBe(1);
    second();
    env.flush();
    expect(env.history.state).toEqual({ router: 1 });
  });

  it("does not rearm when onBack uninstalls the trap", () => {
    const env = fakeEnv({ router: 1 });
    const trap = createHistoryBackTrap(env);
    const holder: { uninstall?: () => void } = {};
    let backs = 0;
    holder.uninstall = trap.install(() => {
      backs += 1;
      holder.uninstall?.();
    });
    env.popUser();
    expect(backs).toBe(1);
    expect(env.history.state).toEqual({ router: 1 });
    expect(env.listenerCount()).toBe(0);
  });
});
