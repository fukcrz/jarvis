/** IDs intentionally match Jarvis's persisted assistant block projection. */
export function streamBlockId(timestamp: number, kind: "text" | "thinking", contentIndex: number): string {
  const base = `message:assistant:${String(timestamp)}`;
  if (kind === "thinking") return `${base}:thinking${contentIndex === 0 ? "" : `:${String(contentIndex)}`}`;
  return contentIndex === 0 ? base : `${base}:text:${String(contentIndex)}`;
}

/** A delta updates only its own content block, never the other blocks in the message. */
export function streamBlockText(content: readonly unknown[], contentIndex: number, kind: "text" | "thinking"): string {
  const block = content[contentIndex];
  if (block === null || typeof block !== "object") return "";
  const value = block as Record<string, unknown>;
  if (value["type"] !== kind) return "";
  const text = value[kind === "text" ? "text" : "thinking"];
  return typeof text === "string" ? text : "";
}
