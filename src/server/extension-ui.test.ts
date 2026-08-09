import { describe, expect, it } from "vitest";
import {
  isUnsupportedExtensionInteraction,
  UNSUPPORTED_EXTENSION_INTERACTION,
  UnsupportedExtensionInteractionError,
  unsupportedExtensionUi,
} from "./extension-ui.js";

describe("unsupported extension UI", () => {
  it("rejects interactive methods with a stable browser-facing code", async () => {
    await expect(unsupportedExtensionUi.confirm("Proceed?", "Continue the task?")).rejects.toMatchObject({
      name: "UnsupportedExtensionInteractionError",
      code: UNSUPPORTED_EXTENSION_INTERACTION,
    });
    await expect(unsupportedExtensionUi.select("Choose", ["one"])).rejects.toBeInstanceOf(UnsupportedExtensionInteractionError);
  });

  it("recognizes Pi-wrapped extension errors", () => {
    const wrapped = { error: `${UNSUPPORTED_EXTENSION_INTERACTION}: This extension interaction is not supported by the Jarvis MVP.` };

    expect(isUnsupportedExtensionInteraction(new UnsupportedExtensionInteractionError())).toBe(true);
    expect(isUnsupportedExtensionInteraction(wrapped)).toBe(true);
    expect(isUnsupportedExtensionInteraction({ cause: wrapped })).toBe(true);
    expect(isUnsupportedExtensionInteraction(new Error("ordinary extension failure"))).toBe(false);
  });
});
