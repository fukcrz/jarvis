import type { ContextSummaryTimelineItem, ImageAttachment, MessageTimelineItem, TimelineItem, ToolState, ToolTimelineItem } from "../shared/protocol.js";

const MAX_TOOL_OUTPUT_CHARS = 12_000;

export function projectHistory(entries: readonly unknown[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const entry of entries) {
    const contextSummary = contextSummaryFromEntry(entry);
    if (contextSummary !== undefined) {
      items.push(contextSummary);
      continue;
    }
    if (!isRecord(entry) || entry["type"] !== "message") continue;
    const message = entry["message"];
    if (!isRecord(message)) continue;

    const entryId = stringValue(entry["id"]) || crypto.randomUUID();
    const createdAt = toIso(entry["timestamp"] ?? message["timestamp"]);
    const role = stringValue(message["role"]);

    if (role === "user") {
      const { text, images } = userContentFromContent(message["content"]);
      if (text === "" && images.length === 0) continue;
      items.push({
        ...messageFromPi(message, "user", text, createdAt, entryId),
        ...(images.length === 0 ? {} : { images }),
      });
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
      const item = bashExecutionItem(entryId, createdAt, message);
      if (item !== undefined) items.push(item);
    }
  }

  return items;
}

/**
 * 把 Pi 会话文件里的 bashExecution 消息投影为时间线条目。
 * jarvis 服务端用它把用户 !cmd 的执行结果落盘后再投影回浏览器。
 */
export function bashExecutionItem(entryId: string, createdAt: string, message: Record<string, unknown>): ToolTimelineItem | undefined {
  const command = stringValue(message["command"]);
  const output = stringValue(message["output"]);
  const exitCode = numberValue(message["exitCode"]);
  const state = message["cancelled"] === true
    ? "cancelled" as const
    : exitCode !== undefined && exitCode !== 0
      ? "failed" as const
      : "completed" as const;
  return {
    kind: "tool",
    id: `bash:${entryId}`,
    createdAt,
    name: "bash",
    title: "Run command",
    state,
    ...(command === "" ? {} : { target: command, inputPreview: command }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(message["truncated"] === true ? { truncated: true } : {}),
    ...(message["excludeFromContext"] === true ? { excludeFromContext: true } : {}),
    ...(state === "failed"
      ? (output === "" ? {} : { error: truncate(output) })
      : (output === "" ? {} : { output: truncate(output) })),
  };
}

export function contextSummaryFromEntry(entry: unknown): ContextSummaryTimelineItem | undefined {
  if (!isRecord(entry)) return undefined;
  const type = entry["type"];
  if (type !== "compaction" && type !== "branch_summary") return undefined;
  const summary = stringValue(entry["summary"]);
  if (summary === "") return undefined;
  const entryId = stringValue(entry["id"]) || crypto.randomUUID();
  const tokensBefore = type === "compaction" ? numberValue(entry["tokensBefore"]) : undefined;
  return {
    kind: "context-summary",
    id: `context-summary:${entryId}`,
    createdAt: toIso(entry["timestamp"]),
    summaryType: type === "compaction" ? "compaction" : "branch",
    summary,
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
  };
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

export function toolFromCall(
  id: string,
  name: string,
  args: unknown,
  createdAt = new Date().toISOString(),
  state: ToolState = "running",
  metadata?: { cwd?: string },
): ToolTimelineItem {
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
    ...(metadata?.cwd === undefined ? {} : { cwd: metadata.cwd }),
  };
}

export function toolWithResult(tool: ToolTimelineItem, result: unknown, isError: boolean, durationMs?: number): ToolTimelineItem {
  const text = truncate(textFromToolResult(result));
  const metadata = toolResultMetadata(result);
  const exitCode = metadata.exitCode ?? (tool.name === "bash" && isError ? bashExitCodeFromError(text) : undefined);
  const failed = isError || exitCode !== undefined && exitCode !== 0;
  const next = {
    ...tool,
    state: failed ? "failed" as const : "completed" as const,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(metadata.truncated ? { truncated: true } : {}),
  };
  if (failed) {
    delete next.output;
    if (text !== "") next.error = text;
    return next;
  }
  delete next.error;
  if (text !== "") next.output = text;
  return next;
}

export function toolWithPartial(tool: ToolTimelineItem, result: unknown): ToolTimelineItem {
  const output = truncate(textFromToolResult(result));
  const metadata = toolResultMetadata(result);
  return {
    ...tool,
    state: "running",
    ...(output === "" ? {} : { output }),
    ...(metadata.truncated ? { truncated: true } : {}),
  };
}

export function textFromContent(content: unknown): string {
  return contentParts(content).text;
}

/**
 * Extracts the visible text and image attachments from a Pi message content
 * value. Images are passed through as base64 attachments so Jarvis can echo
 * them back in the timeline.
 */
export function contentParts(content: unknown): { text: string; images: ImageAttachment[] } {
  if (typeof content === "string") return content === "" ? { text: "", images: [] } : { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const text: string[] = [];
  const images: ImageAttachment[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part["type"] === "text") {
      const value = stringValue(part["text"]);
      if (value !== "") text.push(value);
      continue;
    }
    if (part["type"] === "image") {
      const data = stringValue(part["data"]);
      const mimeType = stringValue(part["mimeType"]) || stringValue(part["mediaType"]);
      if (data !== "" && mimeType !== "") images.push({ mimeType, data });
    }
  }
  return { text: text.join("\n"), images };
}

export function userContentFromContent(content: unknown): { text: string; images: ImageAttachment[] } {
  return contentParts(content);
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

function bashExitCodeFromError(value: string): number | undefined {
  const match = value.match(/Command exited with code (-?\\d+)/);
  if (match === null) return undefined;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : undefined;
}

function toolResultMetadata(value: unknown): { exitCode?: number; truncated?: boolean } {
  if (!isRecord(value)) return {};
  const details = isRecord(value["details"]) ? value["details"] : undefined;
  const exitCode = numberValue(value["exitCode"]) ?? numberValue(details?.["exitCode"]);
  const truncated = value["truncated"] === true || details?.["truncated"] === true || isRecord(details?.["truncation"]) && details["truncation"]["truncated"] === true;
  return {
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(truncated ? { truncated: true } : {}),
  };
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
