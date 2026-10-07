import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_EVENT } from "../api";
import { subscribeEventSocket } from "./event-socket";
import { SOCKET_CLIENT_PING_INTERVAL_MS, SOCKET_PING_TYPE, SOCKET_PONG_TYPE, SOCKET_STALE_MS, SOCKET_WATCHDOG_INTERVAL_MS } from "./socket-sync";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(payload: string): void { this.sent.push(payload); }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: string): void { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
}

let browser: EventTarget;
let page: EventTarget & { hidden: boolean; visibilityState: string };
let network: { onLine: boolean };
let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  FakeSocket.instances = [];
  browser = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval });
  page = Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible" });
  network = { onLine: true };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", network);
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function currentSocket(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) throw new Error("Expected a socket");
  return socket;
}

describe("event socket subscriptions", () => {
  it("resyncs on the first connection and every reconnect, and filters heartbeats", () => {
    const onMessage = vi.fn();
    const onResync = vi.fn();
    cleanup = subscribeEventSocket("ws://localhost/api/events", { onMessage, onResync });
    const first = currentSocket();
    first.open();
    expect(onResync).toHaveBeenCalledOnce();
    first.receive(JSON.stringify({ version: 1, type: SOCKET_PING_TYPE }));
    expect(first.sent.map((value) => JSON.parse(value).type)).toEqual([SOCKET_PONG_TYPE]);
    expect(onMessage).not.toHaveBeenCalled();
    first.receive("malformed");
    first.receive(JSON.stringify({ version: 1, type: "workspaces.changed" }));
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ version: 1, type: "workspaces.changed" });
    first.close(1006);
    vi.advanceTimersByTime(1_500);
    const second = currentSocket();
    expect(second).not.toBe(first);
    second.open();
    expect(onResync).toHaveBeenCalledTimes(2);
    first.receive(JSON.stringify({ version: 1, type: "settings.changed" }));
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("refreshes a healthy socket's snapshot on foreground, online and restored pages", () => {
    const onResync = vi.fn();
    cleanup = subscribeEventSocket("ws://localhost/api/events", { onMessage: vi.fn(), onResync });
    currentSocket().open();
    page.hidden = true;
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(onResync).toHaveBeenCalledOnce();
    page.hidden = false;
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    browser.dispatchEvent(new Event("online"));
    browser.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    expect(onResync).toHaveBeenCalledTimes(4);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects a stale connection and sends application pings while visible", () => {
    cleanup = subscribeEventSocket("ws://localhost/api/events", { onMessage: vi.fn(), onResync: vi.fn() });
    const first = currentSocket();
    first.open();
    vi.advanceTimersByTime(SOCKET_CLIENT_PING_INTERVAL_MS);
    expect(first.sent.map((value) => JSON.parse(value).type)).toContain(SOCKET_PING_TYPE);
    vi.advanceTimersByTime(SOCKET_STALE_MS);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(first.readyState).toBe(3);
  });

  it("stops timers and foreground reconnects after 4401", () => {
    const unauthorized = vi.fn();
    browser.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    const onResync = vi.fn();
    cleanup = subscribeEventSocket("ws://localhost/api/events", { onMessage: vi.fn(), onResync });
    const first = currentSocket();
    first.open();
    first.close(4401);
    expect(unauthorized).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(SOCKET_STALE_MS * 2);
    page.dispatchEvent(new Event("visibilitychange"));
    browser.dispatchEvent(new Event("online"));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(onResync).toHaveBeenCalledOnce();
  });

  it("removes listeners and prevents pending reconnects after cleanup", () => {
    const onResync = vi.fn();
    cleanup = subscribeEventSocket("ws://localhost/api/events", { onMessage: vi.fn(), onResync });
    currentSocket().open();
    currentSocket().close(1006);
    cleanup();
    cleanup = undefined;
    vi.advanceTimersByTime(SOCKET_STALE_MS + SOCKET_WATCHDOG_INTERVAL_MS);
    page.dispatchEvent(new Event("visibilitychange"));
    browser.dispatchEvent(new Event("online"));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(onResync).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
