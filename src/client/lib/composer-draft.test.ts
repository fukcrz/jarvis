import { describe, expect, it } from "vitest";
import { composerDraftSyncAction, isComposerCompositionPending, mergeDeferredComposerDraft, mergeQueuedMessagesIntoDraft } from "./composer-draft";

describe("mergeQueuedMessagesIntoDraft", () => {
  it("merges queued text and images before the current draft without deduplicating", () => {
    const duplicate = { mimeType: "image/png", data: "same" };
    expect(mergeQueuedMessagesIntoDraft([
      { text: "第一条", images: [duplicate, duplicate] },
      { text: "第二条", images: [{ mimeType: "image/jpeg", data: "next" }] },
    ], "当前草稿", [{ mimeType: "image/gif", data: "existing" }])).toEqual({
      draft: "第一条\n\n第二条\n\n当前草稿",
      attachments: [duplicate, duplicate, { mimeType: "image/jpeg", data: "next" }, { mimeType: "image/gif", data: "existing" }],
    });
  });

  it("restores image-only messages", () => {
    expect(mergeQueuedMessagesIntoDraft([
      { text: "", images: [{ mimeType: "image/png", data: "only-image" }] },
    ], "", [])).toEqual({
      draft: "",
      attachments: [{ mimeType: "image/png", data: "only-image" }],
    });
  });
});

describe("mergeDeferredComposerDraft", () => {
  it("keeps text committed during IME composition when queue messages are restored", () => {
    expect(mergeDeferredComposerDraft("排队消息\n\n原草稿", "原草稿", "原草稿已确认")).toBe("排队消息\n\n原草稿已确认");
  });

  it("keeps image-only restore text separate from a composition started on an empty draft", () => {
    expect(mergeDeferredComposerDraft("排队消息", "", "已确认")).toBe("排队消息\n\n已确认");
  });

  it("keeps multiple queue restores accumulated during the same composition", () => {
    expect(mergeDeferredComposerDraft("第二条\n\n第一条\n\n原草稿", "原草稿", "原草稿已确认"))
      .toBe("第二条\n\n第一条\n\n原草稿已确认");
  });
});

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

describe("isComposerCompositionPending", () => {
  it("treats an active IME session as pending", () => {
    expect(isComposerCompositionPending({ composing: true, composeTransaction: false })).toBe(true);
  });

  it("treats a compose-tagged commit as pending even after compositionend", () => {
    expect(isComposerCompositionPending({ composing: false, composeTransaction: true })).toBe(true);
  });

  it("allows app draft sync once composition has fully settled", () => {
    expect(isComposerCompositionPending({ composing: false, composeTransaction: false })).toBe(false);
  });
});
