import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ISSUE_DETAIL_MAX,
  CLIENT_ISSUE_MESSAGE_MAX,
  createIssueThrottle,
  installClientErrorReporting,
  normalizeClientIssue,
  selectionIssueDetail,
} from "./client-diagnostics";

let sent: unknown[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) as unknown });
    return Promise.resolve(new Response("{}"));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeClientIssue", () => {
  it("trims and caps the fields", () => {
    const issue = normalizeClientIssue("  window-error  ", `  ${"m".repeat(CLIENT_ISSUE_MESSAGE_MAX + 10)}  `, "d".repeat(CLIENT_ISSUE_DETAIL_MAX + 10));
    expect(issue?.kind).toBe("window-error");
    expect(issue?.message).toHaveLength(CLIENT_ISSUE_MESSAGE_MAX);
    expect(issue?.detail).toHaveLength(CLIENT_ISSUE_DETAIL_MAX);
  });

  it("drops empty kinds and messages", () => {
    expect(normalizeClientIssue(" ", "boom")).toBeUndefined();
    expect(normalizeClientIssue("window-error", "   ")).toBeUndefined();
  });

  it("omits a blank detail", () => {
    expect(normalizeClientIssue("window-error", "boom", "   ")).toEqual({ kind: "window-error", message: "boom" });
  });
});

describe("createIssueThrottle", () => {
  it("dedupes the same issue inside the window", () => {
    let now = 1_000;
    const throttle = createIssueThrottle({ now: () => now, windowMs: 60_000, limit: 10 });
    const issue = { kind: "api-network", message: "GET /api/workspaces" };
    expect(throttle.accept(issue)).toBe(true);
    expect(throttle.accept(issue)).toBe(false);
    now += 60_000;
    expect(throttle.accept(issue)).toBe(true);
  });

  it("limits reports per window, not per page", () => {
    let now = 0;
    const throttle = createIssueThrottle({ now: () => now, windowMs: 60_000, limit: 2 });
    expect(throttle.accept({ kind: "a", message: "1" })).toBe(true);
    expect(throttle.accept({ kind: "a", message: "2" })).toBe(true);
    expect(throttle.accept({ kind: "a", message: "3" })).toBe(false);
    now += 60_000;
    expect(throttle.accept({ kind: "a", message: "3" })).toBe(true);
  });
});

describe("selectionIssueDetail", () => {
  it("reports whether the clicked session is in the loaded list", () => {
    expect(selectionIssueDetail({
      targetWorkspaceId: "w1",
      targetSessionId: "s1",
      path: "/chat/w1/s1",
      listedSessionIds: ["s2", "s3"],
    })).toBe("target=w1:s1 selected=-:- path=/chat/w1/s1 listed=2 inList=否");
    expect(selectionIssueDetail({
      targetWorkspaceId: "w1",
      targetSessionId: "s1",
      selectedWorkspaceId: "w1",
      selectedSessionId: "s1",
      path: "/chat/w1/s1",
      listedSessionIds: ["s1"],
    })).toBe("target=w1:s1 selected=w1:s1 path=/chat/w1/s1 listed=1 inList=是");
    expect(selectionIssueDetail({
      targetWorkspaceId: "w1",
      targetSessionId: "s1",
      path: "/chat/w1/s1",
    })).toBe("target=w1:s1 selected=-:- path=/chat/w1/s1 listed=未加载 inList=未知");
  });
});

describe("installClientErrorReporting", () => {
  it("reports window errors and unhandled rejections", () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const target = {
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(handler);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, handler: (event: unknown) => void) => {
        listeners.get(type)?.delete(handler);
      },
    };
    const dispatch = (type: string, event: unknown) => {
      for (const handler of listeners.get(type) ?? []) handler(event);
    };
    const stop = installClientErrorReporting(target as unknown as Window);
    dispatch("error", { message: "boom", filename: "app.js", lineno: 12, colno: 3, error: new Error("kaboom") });
    dispatch("unhandledrejection", { reason: "nope" });
    expect(sent).toEqual([
      { url: "/api/system/client-log", body: { kind: "window-error", message: "boom (app.js:12:3)", detail: expect.stringContaining("kaboom") as unknown } },
      { url: "/api/system/client-log", body: { kind: "unhandled-rejection", message: "nope" } },
    ]);
    stop();
    expect(listeners.get("error")?.size).toBe(0);
  });
});
