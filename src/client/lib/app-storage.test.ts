import { describe, expect, it } from "vitest";
import { isChatPath, pathParams, routeSessionMissing, sessionRouteNeedsSync } from "./app-storage";

describe("pathParams", () => {
  it("reads chat workspace and session ids", () => {
    expect(pathParams("/chat/ws-1/session-2")).toEqual({ workspaceId: "ws-1", sessionId: "session-2" });
  });

  it("does not keep a session id on the session list", () => {
    expect(pathParams("/projects")).toEqual({});
    expect(pathParams("/sessions/ws-1")).toEqual({ workspaceId: "ws-1" });
  });
});

describe("isChatPath", () => {
  it("is true only for the transcript route", () => {
    expect(isChatPath("/chat/ws-1/session-2")).toBe(true);
    expect(isChatPath("/projects")).toBe(false);
    expect(isChatPath("/sessions/ws-1")).toBe(false);
    expect(isChatPath("/settings")).toBe(false);
    expect(isChatPath("/chatty")).toBe(false);
  });
});

describe("sessionRouteNeedsSync", () => {
  it("waits when the chat URL points at another workspace", () => {
    expect(sessionRouteNeedsSync("b", "s2", "a", undefined)).toBe(true);
  });

  it("waits when the chat URL session is ahead of state", () => {
    expect(sessionRouteNeedsSync("a", "s2", "a", undefined)).toBe(true);
  });

  it("is ready when path and state match", () => {
    expect(sessionRouteNeedsSync("b", "s2", "b", "s2")).toBe(false);
  });

  it("does not wait on the session list", () => {
    expect(sessionRouteNeedsSync(undefined, undefined, "a", undefined)).toBe(false);
  });
});

describe("routeSessionMissing", () => {
  it("flags a route session that the loaded list no longer has", () => {
    expect(routeSessionMissing("s1", [{ id: "s2" }])).toBe(true);
  });

  it("keeps a session that is still listed", () => {
    expect(routeSessionMissing("s1", [{ id: "s1" }])).toBe(false);
  });

  it("does not judge before the list is loaded", () => {
    expect(routeSessionMissing("s1", undefined)).toBe(false);
  });

  it("ignores routes without a session id", () => {
    expect(routeSessionMissing(undefined, [])).toBe(false);
  });
});
