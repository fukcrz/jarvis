import { describe, expect, it } from "vitest";
import { isChatPath, pathParams } from "./app-storage";

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
