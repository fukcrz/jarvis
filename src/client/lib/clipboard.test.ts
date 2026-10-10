import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

function stubNavigator(clipboard?: { writeText?: (text: string) => Promise<void> }) {
  vi.stubGlobal("navigator", { clipboard });
}

function stubDocument(execResult: boolean) {
  const execCommand = vi.fn(() => execResult);
  const textarea = {
    value: "",
    style: { cssText: "" },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  vi.stubGlobal("document", {
    execCommand,
    body: { append: vi.fn() },
    createElement: vi.fn(() => textarea),
  });
  return { execCommand, textarea };
}

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses Clipboard API when available", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ writeText });
    const { execCommand } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when Clipboard API rejects", async () => {
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    stubNavigator({ writeText });
    const { execCommand, textarea } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.value).toBe("hello");
    expect(textarea.style.cssText).toContain("left:0");
  });

  it("uses execCommand when Clipboard API is unavailable", async () => {
    stubNavigator();
    const { execCommand } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("throws when both Clipboard API and execCommand fail", async () => {
    stubNavigator({ writeText: vi.fn(async () => { throw new Error("denied"); }) });
    const { execCommand } = stubDocument(false);
    await expect(copyText("hello")).rejects.toThrow("denied");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("throws when clipboard is missing and execCommand is unavailable", async () => {
    stubNavigator();
    vi.stubGlobal("document", undefined);
    await expect(copyText("hello")).rejects.toThrow("clipboard");
  });
});
