import { describe, expect, it } from "vitest";
import {
  ExtensionUiBridge,
  isUnsupportedExtensionInteraction,
  UNSUPPORTED_EXTENSION_INTERACTION,
  UnsupportedExtensionInteractionError,
  type ExtensionUiMessage,
} from "./extension-ui.js";

describe("unsupported extension UI", () => {
  it("recognizes Pi-wrapped extension errors", () => {
    const wrapped = { error: `${UNSUPPORTED_EXTENSION_INTERACTION}: This extension interaction is not supported by the Jarvis MVP.` };

    expect(isUnsupportedExtensionInteraction(new UnsupportedExtensionInteractionError())).toBe(true);
    expect(isUnsupportedExtensionInteraction(wrapped)).toBe(true);
    expect(isUnsupportedExtensionInteraction({ cause: wrapped })).toBe(true);
    expect(isUnsupportedExtensionInteraction(new Error("ordinary extension failure"))).toBe(false);
  });
});

describe("ExtensionUiBridge", () => {
  function setup() {
    const messages: ExtensionUiMessage[] = [];
    const bridge = new ExtensionUiBridge((message) => messages.push(message));
    return { bridge, messages };
  }

  function dialogRequest(messages: ExtensionUiMessage[]) {
    const request = messages.find((m) => m.type === "request") as { type: "request"; request: Extract<ExtensionUiMessage, { type: "request" }>["request"] } | undefined;
    return request?.request;
  }

  it("publishes select requests and resolves the pending promise on respond", async () => {
    const { bridge, messages } = setup();
    const promise = bridge.context.select("Choose", ["one", "two"]);
    const request = dialogRequest(messages);
    expect(request).toMatchObject({ method: "select", title: "Choose", options: ["one", "two"] });
    expect(typeof request?.id).toBe("string");

    const settled = bridge.respond({ id: request!.id, value: "two" });
    expect(settled).toBe(true);
    await expect(promise).resolves.toBe("two");
    expect(messages.at(-1)).toMatchObject({ type: "outcome", id: request!.id, outcome: "answered", value: "two" });
  });

  it("keeps a reconnectable snapshot for dialogs and extension panels", () => {
    const { bridge } = setup();
    bridge.context.setStatus("review", "Waiting for approval");
    bridge.context.setWidget("review", ["1 change pending"], { placement: "belowEditor" });
    bridge.context.setTitle("Review · Jarvis");
    bridge.context.setEditorText("Draft from extension");
    bridge.context.select("Choose", ["one", "two"], { timeout: 10_000 });

    expect(bridge.snapshot()).toMatchObject({
      dialogs: [{ request: { method: "select", title: "Choose", options: ["one", "two"], timeout: 10_000 } }],
      statuses: { review: "Waiting for approval" },
      widgets: { review: { lines: ["1 change pending"], placement: "belowEditor" } },
      title: "Review · Jarvis",
      editorText: { text: "Draft from extension", revision: 1 },
    });
    bridge.closeAll();
  });

  it("resolves confirm with boolean and retains the settled card in its snapshot", async () => {
    const { bridge, messages } = setup();
    const promise = bridge.context.confirm("Sure?", "Do it?");
    const request = dialogRequest(messages);
    expect(request?.method).toBe("confirm");

    bridge.respond({ id: request!.id, confirmed: true });
    await expect(promise).resolves.toBe(true);
    expect(messages.at(-1)).toMatchObject({ type: "outcome", outcome: "answered", confirmed: true });
    expect(bridge.snapshot().cards).toEqual([expect.objectContaining({
      id: `ext:${request!.id}`,
      request: expect.objectContaining({ method: "confirm", title: "Sure?" }),
      outcome: "answered",
      confirmed: true,
    })]);
  });

  it("maps cancel to undefined and publishes cancelled", async () => {
    const { bridge, messages } = setup();
    const promise = bridge.context.input("Name?", "type here");
    const request = dialogRequest(messages);
    bridge.respond({ id: request!.id, cancelled: true });
    await expect(promise).resolves.toBeUndefined();
    expect(messages.at(-1)).toMatchObject({ type: "outcome", outcome: "cancelled" });
  });

  it("resolves with the default value on timeout", async () => {
    const { bridge, messages } = setup();
    const promise = bridge.context.confirm("Sure?", "Do it?", { timeout: 5 });
    const request = dialogRequest(messages);
    await expect(promise).resolves.toBe(false);
    expect(messages.at(-1)).toMatchObject({ type: "outcome", outcome: "timeout" });
    expect(request?.method).toBe("confirm");
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const { bridge, messages } = setup();
    const signal = AbortSignal.abort();
    await expect(bridge.context.input("Name?", "x", { signal })).resolves.toBeUndefined();
    expect(messages).toHaveLength(0);
  });

  it("resolves with the default when aborted while pending and closes other requests", async () => {
    const { bridge } = setup();
    const controller = new AbortController();
    const promise = bridge.context.select("Choose", ["a"], { signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
  });

  it("ignores responses for unknown ids", () => {
    const { bridge } = setup();
    expect(bridge.respond({ id: crypto.randomUUID(), value: "x" })).toBe(false);
  });

  it("closeAll resolves pending dialogs with defaults and publishes closed", async () => {
    const { bridge, messages } = setup();
    const promise = bridge.context.input("Name?", undefined);
    bridge.closeAll();
    await expect(promise).resolves.toBeUndefined();
    expect(messages.at(-1)).toMatchObject({ type: "outcome", outcome: "closed" });
  });

  it("keeps notify transient while fire-and-forget methods publish requests", async () => {
    const { bridge, messages } = setup();
    bridge.context.notify("Hello", "info");
    bridge.context.setStatus("key", "value");
    bridge.context.setWidget("w", ["line1"], { placement: "aboveEditor" });
    bridge.context.setTitle("title");
    bridge.context.setEditorText("text");
    expect(messages.filter((m) => m.type === "request").map((m) => (m as { request: { method: string } }).request.method)).toEqual([
      "notify", "setStatus", "setWidget", "setTitle", "set_editor_text",
    ]);
    expect(messages.filter((m) => m.type === "outcome")).toHaveLength(0);
    expect(bridge.snapshot().cards).toEqual([]);
  });

  it("custom() resolves undefined like RPC mode", async () => {
    const { bridge } = setup();
    await expect(bridge.context.custom(() => ({}) as never)).resolves.toBeUndefined();
  });
});
