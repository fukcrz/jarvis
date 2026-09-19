import { isRecord, type SubagentCallView, type SubagentView, type ToolTimelineItem } from "../shared/protocol.js";
import { numberValue, stringValue } from "./values.js";

const MAX_SUBAGENT_PROMPT_CHARS = 160;
const MAX_SUBAGENT_OUTPUT_CHARS = 500;
const MAX_SUBAGENT_ERROR_CHARS = 240;
const MAX_SUBAGENT_TOOL_CALLS = 4;
const MAX_SUBAGENT_TOOL_SUMMARY_CHARS = 80;

export function subagentViewFromArgs(name: string, args: unknown): SubagentView | undefined {
  if (name !== "subagent" || !isRecord(args) || !Array.isArray(args["calls"])) return undefined;
  const results = args["calls"].flatMap(subagentCallFromArgs);
  return results.length === 0 ? undefined : viewFromCalls(results);
}

export function attachSubagentView(tool: ToolTimelineItem, result?: unknown): ToolTimelineItem {
  if (tool.name !== "subagent") return tool;
  const fromResult = subagentViewFromResult(result);
  if (fromResult !== undefined && fromResult.results.length > 0) return { ...tool, subagent: fromResult };
  return finalizeSeededSubagent(tool);
}

function subagentViewFromResult(result: unknown): SubagentView | undefined {
  const details = detailsRecord(result);
  if (details === undefined) return undefined;
  const results = Array.isArray(details["results"]) ? details["results"].flatMap(subagentCallFromResult) : [];
  return viewFromCalls(results);
}

function detailsRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "pi-subagent") return value;
  if (isRecord(value["details"]) && value["details"]["kind"] === "pi-subagent") return value["details"];
  return undefined;
}

function finalizeSeededSubagent(tool: ToolTimelineItem): ToolTimelineItem {
  const view = tool.subagent;
  if (view === undefined) return tool;
  if (tool.state === "queued" || tool.state === "running") return tool;
  const nextState = tool.state === "cancelled" ? "cancelled" as const : tool.state === "failed" ? "failed" as const : "completed" as const;
  const error = nextState === "failed" ? tool.error : undefined;
  const results = view.results.map((call) => {
    if (call.state !== "running") return call;
    return {
      ...call,
      state: nextState,
      ...(error !== undefined && call.error === undefined ? { error: truncateText(error, MAX_SUBAGENT_ERROR_CHARS) } : {}),
    };
  });
  return { ...tool, subagent: viewFromCalls(results) };
}

function viewFromCalls(results: SubagentCallView[]): SubagentView {
  return {
    kind: "pi-subagent",
    results,
    total: results.length,
    completed: results.filter((call) => call.state === "completed").length,
    running: results.filter((call) => call.state === "running").length,
    failed: results.filter((call) => call.state === "failed").length,
  };
}

function subagentCallFromArgs(value: unknown): SubagentCallView[] {
  if (!isRecord(value)) return [];
  const agent = stringValue(value["agent"]);
  if (agent === "") return [];
  const handle = sessionHandleFrom(value["session"]);
  const model = stringValue(value["model"]);
  return [{
    agent,
    prompt: truncateOneLine(stringValue(value["prompt"]), MAX_SUBAGENT_PROMPT_CHARS),
    state: "running",
    ...(handle === "" ? {} : { sessionHandle: handle }),
    ...(model === "" ? {} : { model }),
  }];
}

function subagentCallFromResult(value: unknown): SubagentCallView[] {
  if (!isRecord(value)) return [];
  const agent = stringValue(value["agent"]);
  if (agent === "") return [];
  const state = subagentCallState(value);
  const prompt = truncateOneLine(stringValue(value["prompt"]), MAX_SUBAGENT_PROMPT_CHARS);
  const output = truncateText(lastAssistantText(value["messages"]), MAX_SUBAGENT_OUTPUT_CHARS);
  const error = state === "running" ? "" : truncateText(stringValue(value["errorMessage"]), MAX_SUBAGENT_ERROR_CHARS);
  const handle = sessionHandleFrom(value["session"]);
  const source = value["agentSource"];
  const model = stringValue(value["model"]);
  const turns = numberValue(isRecord(value["usage"]) ? value["usage"]["turns"] : undefined);
  const toolCalls = recentToolCalls(value["messages"]);
  return [{
    agent,
    prompt,
    state,
    ...(source === "user" || source === "project" || source === "unknown" ? { source } : {}),
    ...(model === "" ? {} : { model }),
    ...(turns !== undefined && turns > 0 ? { turns } : {}),
    ...(handle === "" ? {} : { sessionHandle: handle }),
    ...(output === "" ? {} : { output }),
    ...(error === "" ? {} : { error }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  }];
}

function subagentCallState(result: Record<string, unknown>): SubagentCallView["state"] {
  const exitCode = numberValue(result["exitCode"]);
  const stopReason = stringValue(result["stopReason"]);
  if (exitCode === -1) return "running";
  if (stopReason === "aborted" || exitCode === 130) return "cancelled";
  if (result["processError"] === true) return "failed";
  if (exitCode === 0) return "completed";
  if (exitCode !== undefined && exitCode !== 0) return "failed";
  if (stringValue(result["errorMessage"]) !== "") return "failed";
  return "completed";
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
    const text = message["content"]
      .flatMap((part) => isRecord(part) && part["type"] === "text" ? [stringValue(part["text"])] : [])
      .filter((part) => part !== "")
      .join("");
    if (text !== "") return text;
  }
  return "";
}

function recentToolCalls(messages: unknown): NonNullable<SubagentCallView["toolCalls"]> {
  if (!Array.isArray(messages)) return [];
  const calls: NonNullable<SubagentCallView["toolCalls"]> = [];
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
    for (const part of message["content"]) {
      if (!isRecord(part) || part["type"] !== "toolCall") continue;
      const name = stringValue(part["name"]) || "tool";
      const summary = truncateOneLine(summarizeToolArgs(part["arguments"] ?? part["args"]), MAX_SUBAGENT_TOOL_SUMMARY_CHARS);
      calls.push({ name, summary });
    }
  }
  return calls.slice(-MAX_SUBAGENT_TOOL_CALLS);
}

function summarizeToolArgs(args: unknown): string {
  if (!isRecord(args)) return args == null ? "" : String(args);
  const command = stringValue(args["command"]);
  if (command !== "") return command;
  const path = stringValue(args["path"]) || stringValue(args["file_path"]);
  if (path !== "") return path;
  const query = stringValue(args["query"]) || stringValue(args["pattern"]);
  if (query !== "") return query;
  return "";
}

function sessionHandleFrom(value: unknown): string {
  if (typeof value === "string") return value;
  return isRecord(value) ? stringValue(value["handle"]) : "";
}

function truncateOneLine(value: string, max: number): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), max);
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

