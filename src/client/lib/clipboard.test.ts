import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

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

  it("copies with execCommand without using clipboard.writeText", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { execCommand, textarea } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(textarea.value).toBe("hello");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to writeText when execCommand returns false", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubDocument(false);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("throws when both execCommand and writeText fail", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    stubDocument(false);
    await expect(copyText("hello")).rejects.toThrow("denied");
  });

  it("throws when execCommand fails and clipboard is missing", async () => {
    vi.stubGlobal("navigator", {});
    stubDocument(false);
    await expect(copyText("hello")).rejects.toThrow("clipboard");
  });
});
