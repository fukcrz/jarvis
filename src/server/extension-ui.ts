import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export const UNSUPPORTED_EXTENSION_INTERACTION = "UNSUPPORTED_EXTENSION_INTERACTION";

export class UnsupportedExtensionInteractionError extends Error {
  readonly code = UNSUPPORTED_EXTENSION_INTERACTION;

  constructor() {
    super(`${UNSUPPORTED_EXTENSION_INTERACTION}: This extension interaction is not supported by the Jarvis MVP.`);
    this.name = "UnsupportedExtensionInteractionError";
  }
}

/**
 * Extension callbacks are sometimes wrapped by Pi before they reach the
 * session runtime. Keep the marker in the message as well as on the Error so
 * the browser-facing failure code survives that boundary.
 */
export function isUnsupportedExtensionInteraction(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate = error;

  for (let depth = 0; depth < 8; depth += 1) {
    if (candidate instanceof UnsupportedExtensionInteractionError) return true;
    if (typeof candidate !== "object" || candidate === null) return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);

    const record = candidate as Record<string, unknown>;
    if (record["code"] === UNSUPPORTED_EXTENSION_INTERACTION) return true;
    const message = typeof record["message"] === "string"
      ? record["message"]
      : typeof record["error"] === "string" ? record["error"] : "";
    if (message.startsWith(`${UNSUPPORTED_EXTENSION_INTERACTION}:`)) return true;
    candidate = record["cause"];
  }

  return false;
}

const interactiveMethods = new Set(["select", "confirm", "input", "editor", "custom"]);

export const unsupportedExtensionUi = new Proxy({}, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    if (interactiveMethods.has(property)) {
      return async () => { throw new UnsupportedExtensionInteractionError(); };
    }
    if (property === "notify") return () => undefined;
    if (property === "onTerminalInput") return () => () => undefined;
    return () => undefined;
  },
}) as ExtensionUIContext;
