import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const WIN_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const WIN_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_FIREFOX = "Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0";

function stubNavigator(ua: string, platform: string, clipboard?: { writeText?: (text: string) => Promise<void> }) {
  vi.stubGlobal("navigator", { userAgent: ua, platform, clipboard });
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

  it("uses execCommand first on Linux Firefox", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator(LINUX_FIREFOX, "Linux x86_64", { writeText });
    const { execCommand, textarea } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(textarea.value).toBe("hello");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to writeText on Linux Firefox when execCommand fails", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator(LINUX_FIREFOX, "Linux x86_64", { writeText });
    stubDocument(false);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("uses writeText on Chrome and does not call execCommand", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator(WIN_CHROME, "Win32", { writeText });
    const { execCommand } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("uses writeText on Windows Firefox", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator(WIN_FIREFOX, "Win32", { writeText });
    const { execCommand } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("uses writeText on Android Firefox", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator(ANDROID_FIREFOX, "Linux armv81", { writeText });
    const { execCommand } = stubDocument(true);
    await expect(copyText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("throws when Linux Firefox execCommand and writeText both fail", async () => {
    stubNavigator(LINUX_FIREFOX, "Linux x86_64", {
      writeText: vi.fn(async () => { throw new Error("denied"); }),
    });
    stubDocument(false);
    await expect(copyText("hello")).rejects.toThrow("denied");
  });

  it("throws when clipboard is missing", async () => {
    stubNavigator(WIN_CHROME, "Win32");
    stubDocument(false);
    await expect(copyText("hello")).rejects.toThrow("clipboard");
  });
});
