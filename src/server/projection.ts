import type { MessageTimelineItem, TimelineItem, ToolState, ToolTimelineItem } from "../shared/protocol.js";

const MAX_TOOL_OUTPUT_CHARS = 12_000;

export function projectHistory(entries: readonly unknown[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message)) continue;

    const entryId = stringValue(entry["id"]) || crypto.randomUUID();
    const createdAt = toIso(entry["timestamp"] ?? message["timestamp"]);
    const role = stringValue(message["role"]);

    if (role === "user") {
      const text = textFromContent(message["content"]);
      if (text !== "") items.push(messageFromPi(message, "user", text, createdAt, entryId));
      continue;
    }

    if (role === "assistant") {
      const text = assistantTextFromContent(message["content"]);
      if (text !== "") items.push(messageFromPi(message, "assistant", text, createdAt, entryId));
      const content = message["content"];
      if (Array.isArray(content)) {
        for (let index = 0; index < content.length; index += 1) {
          const part = content[index];
          if (!isRecord(part) || part["type"] !== "toolCall") continue;
          const toolId = stringValue(part["id"]) || `tool:${entryId}:${String(index)}`;
          const tool = toolFromCall(toolId, stringValue(part["name"]) || "tool", part["arguments"], createdAt, "queued");
          toolIndex.set(tool.id, items.length);
          items.push(tool);
        }
      }
      if (stringValue(message["stopReason"]) === "error") {
        const detail = stringValue(message["errorMessage"]) || "The model response failed.";
        items.push({ kind: "message", id: `error:${entryId}`, role: "assistant", createdAt, text: `Error: ${detail}` });
      }
      continue;
    }

    if (role === "toolResult") {
      const toolId = stringValue(message["toolCallId"]) || `orphan:${entryId}`;
      const output = textFromContent(message["content"]);
      const existingIndex = toolIndex.get(toolId);
      const state: ToolState = message["isError"] === true ? "failed" : "completed";
      if (existingIndex !== undefined) {
        const current = items[existingIndex];
        if (current?.kind === "tool") {
          items[existingIndex] = {
            ...current,
            state,
            ...(state === "failed" ? { error: output } : { output }),
          };
          continue;
        }
      }
      const tool = toolFromCall(toolId, stringValue(message["toolName"]) || "tool", undefined, createdAt, state);
      items.push({ ...tool, ...(state === "failed" ? { error: output } : { output }) });
      toolIndex.set(toolId, items.length - 1);
      continue;
    }

    if (role === "bashExecution") {
      const command = stringValue(message["command"]);
      const output = [stringValue(message["output"]), message["exitCode"] === undefined ? "" : `exit ${String(message["exitCode"])}`]
        .filter((part) => part !== "")
        .join("\n");
      items.push({
        kind: "tool",
        id: `bash:${entryId}`,
        createdAt,
        name: "bash",
        title: "Run command",
        state: message["cancelled"] === true ? "cancelled" : "completed",
        ...(command === "" ? {} : { target: command, inputPreview: command }),
        ...(output === "" ? {} : { output: truncate(output) }),
      });
    }
  }

  return items;
}

export function messageFromPi(message: unknown, role: "user" | "assistant", text: string, fallbackCreatedAt = new Date().toISOString(), fallbackId: string = crypto.randomUUID()): MessageTimelineItem {
  const record = isRecord(message) ? message : {};
  const timestamp = record["timestamp"];
  const createdAt = toIso(timestamp ?? fallbackCreatedAt);
  const stableId = typeof timestamp === "number" || typeof timestamp === "string"
    ? `message:${role}:${String(timestamp)}`
    : `message:${fallbackId}`;
  return { kind: "message", id: stableId, role, createdAt, text };
}

export function toolFromCall(id: string, name: string, args: unknown, createdAt = new Date().toISOString(), state: ToolState = "running"): ToolTimelineItem {
  const target = toolTarget(args);
  const title = toolTitle(name);
  const inputPreview = summarizeArgs(args);
  return {
    kind: "tool",
    id,
    createdAt,
    name,
    title,
    state,
    ...(target === undefined ? {} : { target }),
    ...(inputPreview === "" ? {} : { inputPreview }),
  };
}

export function toolWithResult(tool: ToolTimelineItem, result: unknown, isError: boolean): ToolTimelineItem {
  const text = truncate(textFromToolResult(result));
  return isError
    ? { ...tool, state: "failed", ...(text === "" ? {} : { error: text }) }
    : { ...tool, state: "completed", ...(text === "" ? {} : { output: text }) };
}

export function toolWithPartial(tool: ToolTimelineItem, result: unknown): ToolTimelineItem {
  const output = truncate(textFromToolResult(result));
  return { ...tool, state: "running", ...(output === "" ? {} : { output }) };
}

export function textFromContent(content: unknown): string {
  return textParts(content).join("\n");
}

/**
 * Pi's normal reasoning blocks use `type: "thinking"` and never reach
 * `textParts`. Some older/harness-written sessions instead store reasoning in
 * a text part prefixed with `<thinking>`. Filter that representation at the
 * browser projection boundary too, so it cannot become a visible answer.
 */
export function assistantTextFromContent(content: unknown): string {
  return textParts(content)
    .map(visibleTextAfterThinkingMarker)
    .filter((text) => text !== "")
    .join("\n");
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return content === "" ? [] : [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isRecord(part) || part["type"] !== "text") return [];
    const text = stringValue(part["text"]);
    return text === "" ? [] : [text];
  });
}

function visibleTextAfterThinkingMarker(text: string): string {
  const leadingWhitespace = text.length - text.trimStart().length;
  const trimmed = text.slice(leadingWhitespace);
  if (!trimmed.startsWith("<thinking>")) return text;
  const closeIndex = trimmed.indexOf("</thinking>");
  if (closeIndex === -1) return "";
  return trimmed.slice(closeIndex + "</thinking>".length).trimStart();
}

export function textFromToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromToolResult).filter(Boolean).join("\n");
  if (!isRecord(value)) return value == null ? "" : String(value);
  const direct = stringValue(value["text"]) || stringValue(value["output"]);
  if (direct !== "") return direct;
  const content = value["content"];
  const fromContent = textFromContent(content);
  if (fromContent !== "") return fromContent;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Tool returned an unreadable result.";
  }
}

export function summarizeArgs(args: unknown): string {
  if (!isRecord(args)) return args == null ? "" : String(args);
  const command = stringValue(args["command"]);
  if (command !== "") return command;
  const path = stringValue(args["path"]) || stringValue(args["file_path"]);
  if (path !== "") return path;
  if (Array.isArray(args["edits"])) return `${String(args["edits"].length)} edit${args["edits"].length === 1 ? "" : "s"}`;
  if (typeof args["oldText"] === "string" && typeof args["newText"] === "string") return "edit text replacement";
  return Object.entries(args)
    .filter(([, value]) => value != null)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${shortValue(value)}`)
    .join(" · ");
}

function toolTarget(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  return stringValue(args["path"]) || stringValue(args["file_path"]) || stringValue(args["command"]) || undefined;
}

function toolTitle(name: string): string {
  if (name === "bash") return "Run command";
  if (name === "read") return "Read file";
  if (name === "write") return "Write file";
  if (name === "edit") return "Edit file";
  if (name === "grep") return "Search files";
  if (name === "find") return "Find files";
  if (name === "ls") return "List directory";
  return name.replaceAll("_", " ");
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${String(value.length)} item${value.length === 1 ? "" : "s"}`;
  if (value !== null && typeof value === "object") return "object";
  return "";
}

function toIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function truncate(value: string): string {
  return value.length <= MAX_TOOL_OUTPUT_CHARS ? value : `${value.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[Output truncated by Jarvis]`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
