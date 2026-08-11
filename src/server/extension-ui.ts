import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiOutcome, ExtensionUiRequest, ExtensionUiSnapshot, ExtensionUiTimelineItem } from "../shared/protocol.js";

export const UNSUPPORTED_EXTENSION_INTERACTION = "UNSUPPORTED_EXTENSION_INTERACTION";

export class UnsupportedExtensionInteractionError extends Error {
  readonly code = UNSUPPORTED_EXTENSION_INTERACTION;

  constructor() {
    super(`${UNSUPPORTED_EXTENSION_INTERACTION}: This extension interaction is not supported by the Jarvis MVP.`);
    this.name = "UnsupportedExtensionInteractionError";
  }
}

/** Recognize errors originating from the old unsupported UI adapter. */
export function isUnsupportedExtensionInteraction(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (candidate instanceof UnsupportedExtensionInteractionError) return true;
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return false;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (record["code"] === UNSUPPORTED_EXTENSION_INTERACTION) return true;
    const message = typeof record["message"] === "string" ? record["message"] : typeof record["error"] === "string" ? record["error"] : "";
    if (message.startsWith(`${UNSUPPORTED_EXTENSION_INTERACTION}:`)) return true;
    candidate = record["cause"];
  }
  return false;
}

type DialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type DialogRequestInput =
  | Omit<Extract<DialogRequest, { method: "select" }>, "id">
  | Omit<Extract<DialogRequest, { method: "confirm" }>, "id">
  | Omit<Extract<DialogRequest, { method: "input" }>, "id">
  | Omit<Extract<DialogRequest, { method: "editor" }>, "id">;
type DialogValue = string | undefined | boolean;

interface PendingDialog {
  request: DialogRequest;
  createdAt: string;
  resolve: (value: DialogValue) => void;
  cleanup: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type ExtensionUiMessage =
  | { type: "request"; request: ExtensionUiRequest }
  | { type: "outcome"; id: string; outcome: ExtensionUiOutcome; value?: string; confirmed?: boolean };

/**
 * Stateful RPC-compatible bridge between `ctx.ui` and a browser session.
 * The snapshot is intentionally ephemeral: Pi JSONL remains conversation history,
 * while reconnecting browsers still recover current dialogs and extension panels.
 */
export class ExtensionUiBridge {
  private readonly pending = new Map<string, PendingDialog>();
  /** Ephemeral browser-facing history, retained while this session is active. */
  private readonly cards = new Map<string, ExtensionUiTimelineItem>();
  private readonly statuses: Record<string, string> = {};
  private readonly widgets: ExtensionUiSnapshot["widgets"] = {};
  private title: string | undefined;
  private editorText: ExtensionUiSnapshot["editorText"];
  private editorRevision = 0;

  constructor(private readonly publish: (message: ExtensionUiMessage) => void) {}

  private static readonly DEFAULT_TIMEOUT_MS = 5 * 60_000;

  get context(): ExtensionUIContext {
    return {
      select: (title, options, opts) => this.dialog({ method: "select", title, options, timeout: opts?.timeout }, opts, undefined),
      confirm: (title, message, opts) => this.dialog({ method: "confirm", title, message, timeout: opts?.timeout }, opts, false),
      input: (title, placeholder, opts) => this.dialog({ method: "input", title, placeholder, timeout: opts?.timeout }, opts, undefined),
      editor: (title, prefill) => this.dialog({ method: "editor", title, prefill }, undefined, undefined),
      notify: (message, notifyType) => this.request({ id: crypto.randomUUID(), method: "notify", message, notifyType }),
      setStatus: (statusKey, statusText) => {
        if (statusText === undefined) delete this.statuses[statusKey];
        else this.statuses[statusKey] = statusText;
        this.request({ id: crypto.randomUUID(), method: "setStatus", statusKey, statusText });
      },
      setWidget: (widgetKey, widgetLines, options) => {
        if (widgetLines !== undefined && !Array.isArray(widgetLines)) return;
        if (widgetLines === undefined) delete this.widgets[widgetKey];
        else this.widgets[widgetKey] = { lines: [...widgetLines], placement: options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor" };
        this.request({ id: crypto.randomUUID(), method: "setWidget", widgetKey, widgetLines, widgetPlacement: options?.placement });
      },
      setTitle: (title) => {
        this.title = title;
        this.request({ id: crypto.randomUUID(), method: "setTitle", title });
      },
      setEditorText: (text) => this.setEditorText(text),
      pasteToEditor: (text) => this.setEditorText(text),
      onTerminalInput: () => () => undefined,
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
      theme: undefined as unknown as ExtensionUIContext["theme"],
    } as ExtensionUIContext;
  }

  snapshot(): ExtensionUiSnapshot {
    return {
      dialogs: [...this.pending.values()].map(({ request, createdAt }) => ({ request: cloneDialogRequest(request), createdAt })),
      cards: [...this.cards.values()].map(cloneCard),
      statuses: { ...this.statuses },
      widgets: Object.fromEntries(Object.entries(this.widgets).map(([key, widget]) => [key, { ...widget, lines: [...widget.lines] }])),
      ...(this.title === undefined ? {} : { title: this.title }),
      ...(this.editorText === undefined ? {} : { editorText: { ...this.editorText } }),
    };
  }

  respond(response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }): boolean {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return false;
    const request = pending.request;
    const hasOnlyCancel = response.cancelled === true && response.value === undefined && response.confirmed === undefined;
    const valid = hasOnlyCancel
      || (request.method === "confirm" && response.cancelled !== true && typeof response.confirmed === "boolean" && response.value === undefined)
      || (request.method !== "confirm" && response.cancelled !== true && typeof response.value === "string" && response.confirmed === undefined && (request.method !== "select" || request.options.includes(response.value)));
    if (!valid) return false;

    pending.cleanup();
    if (hasOnlyCancel) {
      const defaultValue = request.method === "confirm" ? false : undefined;
      this.settleCard(request.id, "cancelled", undefined, request.method === "confirm" ? false : undefined);
      pending.resolve(defaultValue);
      this.publishOutcome(request.id, "cancelled", undefined, request.method === "confirm" ? false : undefined);
    } else if (request.method === "confirm") {
      this.settleCard(request.id, "answered", undefined, response.confirmed);
      pending.resolve(response.confirmed!);
      this.publishOutcome(request.id, "answered", undefined, response.confirmed);
    } else {
      this.settleCard(request.id, "answered", response.value);
      pending.resolve(response.value!);
      this.publishOutcome(request.id, "answered", response.value);
    }
    return true;
  }

  closeAll(): void {
    for (const pending of [...this.pending.values()]) {
      pending.cleanup();
      const confirmed = pending.request.method === "confirm" ? false : undefined;
      this.settleCard(pending.request.id, "closed", undefined, confirmed);
      pending.resolve(confirmed);
      this.publishOutcome(pending.request.id, "closed", undefined, confirmed);
    }
  }

  private setEditorText(text: string): void {
    this.editorText = { text, revision: ++this.editorRevision };
    this.request({ id: crypto.randomUUID(), method: "set_editor_text", text });
  }

  private request(request: ExtensionUiRequest): void {
    if (request.method === "notify") this.rememberCard({ kind: "extension-ui", id: `ext:${request.id}`, createdAt: new Date().toISOString(), request });
    this.publish({ type: "request", request });
  }

  private dialog(request: DialogRequestInput, opts: { timeout?: number; signal?: AbortSignal } | undefined, defaultValue: DialogValue): Promise<DialogValue> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    const requestWithId = { ...request, id } as DialogRequest;
    const createdAt = new Date().toISOString();
    return new Promise((resolve) => {
      const onAbort = () => settle("closed", defaultValue);
      const cleanup = () => {
        clearTimeout(pending.timeout);
        opts?.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const settle = (outcome: Extract<ExtensionUiOutcome, "closed" | "timeout">, value: DialogValue) => {
        cleanup();
        const confirmed = requestWithId.method === "confirm" ? false : undefined;
        this.settleCard(id, outcome, undefined, confirmed);
        resolve(value);
        this.publishOutcome(id, outcome, undefined, confirmed);
      };
      const pending: PendingDialog = {
        request: requestWithId,
        createdAt,
        resolve,
        cleanup,
        timeout: setTimeout(() => settle("timeout", defaultValue), opts?.timeout ?? ExtensionUiBridge.DEFAULT_TIMEOUT_MS),
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);
      this.rememberCard({ kind: "extension-ui", id: `ext:${id}`, createdAt, request: requestWithId });
      this.request(requestWithId);
    });
  }

  private rememberCard(card: ExtensionUiTimelineItem): void {
    this.cards.set(card.id, cloneCard(card));
    while (this.cards.size > 100) this.cards.delete(this.cards.keys().next().value!);
  }

  private settleCard(id: string, outcome: ExtensionUiOutcome, value?: string, confirmed?: boolean): void {
    const key = `ext:${id}`;
    const card = this.cards.get(key);
    if (card === undefined) return;
    this.cards.set(key, { ...card, outcome, ...(value === undefined ? {} : { value }), ...(confirmed === undefined ? {} : { confirmed }) });
  }

  private publishOutcome(id: string, outcome: ExtensionUiOutcome, value?: string, confirmed?: boolean): void {
    this.publish({ type: "outcome", id, outcome, value, confirmed });
  }
}

function cloneDialogRequest(request: DialogRequest): DialogRequest {
  return { ...request, ...(request.method === "select" ? { options: [...request.options] } : {}) };
}

function cloneCard(card: ExtensionUiTimelineItem): ExtensionUiTimelineItem {
  const request = card.request.method === "select"
    ? { ...card.request, options: [...card.request.options] }
    : { ...card.request };
  return { ...card, request } as ExtensionUiTimelineItem;
}
