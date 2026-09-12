import { describe, expect, it } from "vitest";
import { composerDraftSyncAction } from "./composer-draft";

describe("composerDraftSyncAction", () => {
  it("ignores parent re-renders that did not bump the draft nonce", () => {
    expect(composerDraftSyncAction({
      nonceChanged: false,
      current: "是否和",
      incoming: "是否",
      composing: true,
    })).toBe("skip");
  });

  it("skips when the editor already matches the restored draft", () => {
    expect(composerDraftSyncAction({
      nonceChanged: true,
      current: "排队消息",
      incoming: "排队消息",
      composing: false,
    })).toBe("skip");
  });

  it("defers an external restore until composition ends", () => {
    expect(composerDraftSyncAction({
      nonceChanged: true,
      current: "是否",
      incoming: "排队消息\n\n是否",
      composing: true,
    })).toBe("defer");
  });

  it("applies an external restore such as queued messages", () => {
    expect(composerDraftSyncAction({
      nonceChanged: true,
      current: "当前草稿",
      incoming: "排队消息\n\n当前草稿",
      composing: false,
    })).toBe("apply");
  });
});
