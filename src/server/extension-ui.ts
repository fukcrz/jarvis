import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiOutcome, ExtensionUiRequest } from "../shared/protocol.js";

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

type ExtensionUiDialogRequest =
  | Omit<Extract<ExtensionUiRequest, { method: "select" }>, "id">
  | Omit<Extract<ExtensionUiRequest, { method: "confirm" }>, "id">
  | Omit<Extract<ExtensionUiRequest, { method: "input" }>, "id">
  | Omit<Extract<ExtensionUiRequest, { method: "editor" }>, "id">;

interface PendingDialog {
  request: ExtensionUiRequest;
  resolve: (value: string | undefined | boolean) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

/**
 * Bridge between extension `ctx.ui.*` calls and the browser. Mirrors the
 * dialog semantics of Pi's RPC `extension_ui_request`/`extension_ui_response`
 * sub-protocol (timeout and abort-signal handling included), but transports
 * over the jarvis EventHub instead of stdio.
 *
 * Dialog methods (select/confirm/input/editor) block until the browser
 * responds via `respondExtensionUi`; `notify`/`setStatus`/`setWidget`/
 * `setTitle`/`set_editor_text` are fire-and-forget. `custom()` resolves
 * `undefined` like RPC mode so extensions fall back to dialog primitives.
 */
export type ExtensionUiMessage =
  | { type: "request"; request: ExtensionUiRequest }
  | { type: "outcome"; id: string; outcome: ExtensionUiOutcome; value?: string; confirmed?: boolean };

export class ExtensionUiBridge {
  private readonly pending = new Map<string, PendingDialog>();

  constructor(private readonly publish: (message: ExtensionUiMessage) => void) {}
  static debugPublish = (message: ExtensionUiMessage) => console.log("[ext-ui-debug]", JSON.stringify(message).slice(0, 200));

  /** Default cap so a request never hangs forever if the browser is gone. */
  private static readonly DEFAULT_TIMEOUT_MS = 5 * 60_000;

  get context(): ExtensionUIContext {
    return {
      select: (title, options, opts) => this.dialog({ method: "select", title, options }, opts, undefined),
      confirm: (title, message, opts) => this.dialog({ method: "confirm", title, message }, opts, false),
      input: (title, placeholder, opts) => this.dialog({ method: "input", title, placeholder }, opts, undefined),
      editor: (title, prefill) => this.dialog({ method: "editor", title, prefill }, undefined, undefined),
      notify: (message, notifyType) => this.publish({ type: "request", request: { id: crypto.randomUUID(), method: "notify", message, notifyType } }),
      setStatus: (statusKey, statusText) => this.publish({ type: "request", request: { id: crypto.randomUUID(), method: "setStatus", statusKey, statusText } }),
      setWidget: (widgetKey, widgetLines, options) => {
        // RPC 语义：只透传字符串数组；组件工厂需要 TUI，忽略。
        if (widgetLines === undefined || Array.isArray(widgetLines)) {
          this.publish({ type: "request", request: { id: crypto.randomUUID(), method: "setWidget", widgetKey, widgetLines, widgetPlacement: options?.placement } });
        }
      },
      setTitle: (title) => this.publish({ type: "request", request: { id: crypto.randomUUID(), method: "setTitle", title } }),

      setEditorText: (text) => this.publish({ type: "request", request: { id: crypto.randomUUID(), method: "set_editor_text", text } }),
      pasteToEditor: (text) => this.publish({ type: "request", request: { id: crypto.randomUUID(), method: "set_editor_text", text } }),
      onTerminalInput: () => () => undefined,
      // TUI-only capabilities degrade to the same no-ops as RPC mode.
      custom: async () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      getEditorText: () => "",
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported" }),
      // jarvis 没有终端主题；扩展不应依赖它（RPC 模式同样退化）。
      theme: undefined as unknown as ExtensionUIContext["theme"],
    } as ExtensionUIContext;
  }

  /** Resolve a dialog from a browser response. Returns false for unknown ids. */
  respond(ref: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
    const pending = this.pending.get(ref.id);
    if (pending === undefined) return false;
    pending.cleanup();
    if (ref.cancelled === true) {
      pending.resolve(undefined);
      this.publishOutcome(ref.id, "cancelled");
    } else if (pending.request.method === "confirm") {
      pending.resolve(ref.confirmed === true);
      this.publishOutcome(ref.id, "answered", undefined, ref.confirmed === true);
    } else {
      const value = typeof ref.value === "string" ? ref.value : undefined;
      pending.resolve(value);
      this.publishOutcome(ref.id, "answered", value);
    }
    return true;
  }

  /** Resolve every pending dialog with its default (used on dispose / browser disconnect). */
  closeAll(): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.resolve(pending.request.method === "confirm" ? false : undefined);
      this.publishOutcome(pending.request.id, "closed");
    }
    this.pending.clear();
  }

  private dialog(
    request: ExtensionUiDialogRequest,
    opts: { timeout?: number; signal?: AbortSignal } | undefined,
    defaultValue: string | undefined | boolean,
  ): Promise<string | undefined | boolean> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    const requestWithId = { ...request, id } as ExtensionUiRequest;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        opts?.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
        this.publishOutcome(id, "closed");
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      const pending = {
        request: requestWithId,
        resolve,
        reject,
        cleanup,
        timeout: setTimeout(() => {
          cleanup();
          resolve(defaultValue);
          this.publishOutcome(id, "timeout");
        }, opts?.timeout ?? ExtensionUiBridge.DEFAULT_TIMEOUT_MS),
      };
      this.pending.set(id, pending);
      this.publish({ type: "request", request: requestWithId });
    });
  }

  private publishOutcome(id: string, outcome: ExtensionUiOutcome, value?: string, confirmed?: boolean): void {
    this.publish({ type: "outcome", id, outcome, value, confirmed });
  }
}
