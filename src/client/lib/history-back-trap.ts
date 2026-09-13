import { useEffect, useRef } from "react";

const TRAP_KEY = "jarvisBackTrap";
let nextTrapId = 1;

function trapIdFromState(state: unknown): number | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const id = (state as { [TRAP_KEY]?: unknown })[TRAP_KEY];
  return typeof id === "number" ? id : undefined;
}

export function isHistoryBackTrapState(state: unknown): boolean {
  return trapIdFromState(state) !== undefined;
}

interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
  back(): void;
}

interface TargetLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface Trap {
  id: number;
  onBack: () => void;
  hasMarker: boolean;
}

function asStateRecord(state: unknown): Record<string, unknown> {
  return typeof state === "object" && state !== null ? state as Record<string, unknown> : {};
}

/** 可注入 history / 事件目标，便于单测。默认绑定 window。 */
export function createHistoryBackTrap(bindings?: { history?: HistoryLike; target?: TargetLike }) {
  const historyOf = () => bindings?.history ?? window.history;
  const targetOf = () => bindings?.target ?? window;
  const traps: Trap[] = [];
  let ignorePops = 0;
  let listening = false;

  const ownedTrap = (id: number | undefined, except?: Trap): Trap | undefined => {
    if (id === undefined) return undefined;
    return traps.find((trap) => trap.id === id && trap !== except);
  };

  const pushMarker = (trap: Trap) => {
    const current = historyOf().state;
    const data = { ...asStateRecord(current), [TRAP_KEY]: trap.id };
    if (trapIdFromState(current) !== undefined && ownedTrap(trapIdFromState(current), trap) === undefined) {
      historyOf().replaceState(data, "");
    } else {
      historyOf().pushState(data, "");
    }
    trap.hasMarker = true;
  };

  const onPopState = () => {
    if (ignorePops > 0) {
      ignorePops -= 1;
      const top = traps[traps.length - 1];
      if (top !== undefined && top.hasMarker && trapIdFromState(historyOf().state) !== top.id) pushMarker(top);
      return;
    }
    const top = traps[traps.length - 1];
    if (top === undefined) return;
    top.hasMarker = false;
    top.onBack();
    if (traps[traps.length - 1] === top) pushMarker(top);
  };

  const install = (onBack: () => void): (() => void) => {
    const trap: Trap = { id: nextTrapId, onBack, hasMarker: false };
    nextTrapId += 1;
    traps.push(trap);
    if (!listening) {
      targetOf().addEventListener("popstate", onPopState);
      listening = true;
    }
    pushMarker(trap);
    return () => {
      const index = traps.lastIndexOf(trap);
      if (index < 0) return;
      traps.splice(index, 1);
      if (trap.hasMarker && trapIdFromState(historyOf().state) === trap.id) {
        ignorePops += 1;
        historyOf().back();
      }
      trap.hasMarker = false;
      if (traps.length === 0 && listening) {
        targetOf().removeEventListener("popstate", onPopState);
        listening = false;
      }
    };
  };

  return { install };
}

const shared = createHistoryBackTrap();

export function installHistoryBackTrap(onBack: () => void): (() => void) {
  return shared.install(onBack);
}

/** 激活期间拦截系统/浏览器返回；关闭浮层时自动吃掉占位历史。 */
export function useHistoryBackTrap(active: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!active) return;
    return installHistoryBackTrap(() => {
      onBackRef.current();
    });
  }, [active]);
}
