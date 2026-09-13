import { describe, expect, it } from "vitest";
import { extensionToastDuration, extensionToastSourceLabel, mergeExtensionToast, type ExtensionToastInput } from "./extension-notifications";

const info = (id: string, message: string): ExtensionToastInput => ({ id, workspaceId: "workspace", message, tone: "info" });

function toast(message: string, tone: ExtensionToastInput["tone"]): ExtensionToastInput {
  return { id: message, workspaceId: "workspace", message, tone };
}

describe("mergeExtensionToast", () => {
  it("aggregates consecutive info notifications and keeps the latest message", () => {
    const first = mergeExtensionToast(undefined, info("one", "first"));
    const merged = mergeExtensionToast(first, info("two", "latest"));

    expect(merged).toMatchObject({ id: "two", message: "latest", count: 2 });
  });

  it("does not let a lower-priority info notification replace a warning or error", () => {
    const warning = mergeExtensionToast(undefined, toast("warning", "warning"));
    const error = mergeExtensionToast(warning, toast("error", "error"));

    expect(mergeExtensionToast(warning, info("info", "info"))).toBe(warning);
    expect(mergeExtensionToast(error, info("info", "info"))).toBe(error);
  });

  it("lets urgent notifications replace lower-priority feedback", () => {
    const first = mergeExtensionToast(undefined, info("info", "info"));
    const warning = mergeExtensionToast(first, toast("warning", "warning"));
    const error = mergeExtensionToast(warning, toast("error", "error"));

    expect(warning).toMatchObject({ tone: "warning", count: 1 });
    expect(error).toMatchObject({ tone: "error", count: 1 });
  });
});

describe("extensionToastSourceLabel", () => {
  it("only returns a real session name", () => {
    expect(extensionToastSourceLabel("选择文本时，链接无法选择")).toBe("选择文本时，链接无法选择");
    expect(extensionToastSourceLabel("  方案讨论  ")).toBe("方案讨论");
    expect(extensionToastSourceLabel(undefined)).toBeUndefined();
    expect(extensionToastSourceLabel(null)).toBeUndefined();
    expect(extensionToastSourceLabel("   ")).toBeUndefined();
  });
});

describe("extensionToastDuration", () => {
  it("gives ordinary notifications the shortest lifetime", () => {
    expect(extensionToastDuration("info")).toBe(3_000);
    expect(extensionToastDuration("warning")).toBe(5_000);
    expect(extensionToastDuration("error")).toBe(10_000);
  });
});
