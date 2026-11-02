import { THINKING_LEVELS, isRecord, type SubagentCallView, type SubagentView, type ThinkingLevel, type ToolTimelineItem } from "../shared/protocol.js";
import { numberValue, stringValue } from "./values.js";

const MAX_SUBAGENT_PROMPT_CHARS = 160;
const MAX_SUBAGENT_FULL_PROMPT_CHARS = 8_000;
const MAX_SUBAGENT_OUTPUT_CHARS = 500;
const MAX_SUBAGENT_ERROR_CHARS = 240;
const MAX_SUBAGENT_TOOL_CALLS = 4;
const MAX_SUBAGENT_TOOL_SUMMARY_CHARS = 80;
const MAX_SUBAGENT_STEPS = 6;
const MAX_SUBAGENT_STEP_TEXT_CHARS = 200;

export function subagentViewFromArgs(name: string, args: unknown, dispatchedAt?: string): SubagentView | undefined {
  if (name !== "subagent" || !isRecord(args) || !Array.isArray(args["calls"])) return undefined;
  const results = args["calls"].flatMap((value, index) => subagentCallFromArgs(value, index, dispatchedAt));
  return results.length === 0 ? undefined : viewFromCalls(results);
}

export function attachSubagentView(tool: ToolTimelineItem, result?: unknown): ToolTimelineItem {
  if (tool.name !== "subagent") return tool;
  const fromResult = subagentViewFromResult(result, tool.createdAt);
  if (fromResult !== undefined && fromResult.results.length > 0) return { ...tool, subagent: fromResult };
  return finalizeSeededSubagent(tool);
}

function subagentViewFromResult(result: unknown, dispatchedAt?: string): SubagentView | undefined {
  const details = detailsRecord(result);
  if (details === undefined) return undefined;
  const results = Array.isArray(details["results"]) ? details["results"].flatMap((value, index) => subagentCallFromResult(value, index, dispatchedAt)) : [];
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

function subagentCallFromArgs(value: unknown, callIndex: number, dispatchedAt?: string): SubagentCallView[] {
  if (!isRecord(value)) return [];
  const agent = stringValue(value["agent"]);
  if (agent === "") return [];
  const handle = sessionHandleFrom(value["session"]);
  const model = stringValue(value["model"]);
  const thinkingLevel = thinkingLevelFrom(value["thinking"]);
  const fullPrompt = truncateText(stringValue(value["prompt"]), MAX_SUBAGENT_FULL_PROMPT_CHARS);
  return [{
    callIndex,
    agent,
    prompt: truncateOneLine(stringValue(value["prompt"]), MAX_SUBAGENT_PROMPT_CHARS),
    state: "running",
    ...(dispatchedAt === undefined ? {} : { startedAt: dispatchedAt }),
    ...(handle === "" ? {} : { sessionHandle: handle }),
    ...(model === "" ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(fullPrompt === "" ? {} : { fullPrompt }),
  }];
}

function subagentCallFromResult(value: unknown, fallbackCallIndex: number, dispatchedAt?: string): SubagentCallView[] {
  if (!isRecord(value)) return [];
  const agent = stringValue(value["agent"]);
  if (agent === "") return [];
  const rawCallIndex = numberValue(value["callIndex"]);
  const callIndex = rawCallIndex !== undefined && Number.isInteger(rawCallIndex) && rawCallIndex >= 0 ? rawCallIndex : fallbackCallIndex;
  const state = subagentCallState(value);
  const timing = callTiming(value["messages"], state, dispatchedAt);
  const prompt = truncateOneLine(stringValue(value["prompt"]), MAX_SUBAGENT_PROMPT_CHARS);
  const fullPrompt = truncateText(stringValue(value["prompt"]) || prompt, MAX_SUBAGENT_FULL_PROMPT_CHARS);
  const reply = lastAssistantText(value["messages"]);
  const output = truncateText(reply, MAX_SUBAGENT_OUTPUT_CHARS);
  const error = state === "running" ? "" : truncateText(stringValue(value["errorMessage"]), MAX_SUBAGENT_ERROR_CHARS);
  const handle = sessionHandleFrom(value["session"]);
  const source = value["agentSource"];
  const lastMessage = lastAssistantMessage(value["messages"]);
  const model = stringValue(value["model"]) || stringValue(lastMessage?.["model"]);
  const thinkingLevel = thinkingLevelFrom(lastMessage?.["thinkingLevel"]) ?? thinkingLevelFrom(value["thinking"]);
  const turns = numberValue(isRecord(value["usage"]) ? value["usage"]["turns"] : undefined);
  const toolCalls = recentToolCalls(value["messages"]);
  const recentSteps = recentStepStream(value["messages"]);
  return [{
    callIndex,
    agent,
    prompt,
    state,
    ...(source === "user" || source === "project" || source === "unknown" ? { source } : {}),
    ...(model === "" ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(turns !== undefined && turns > 0 ? { turns } : {}),
    ...timing,
    ...(handle === "" ? {} : { sessionHandle: handle }),
    ...(fullPrompt === "" ? {} : { fullPrompt }),
    ...(recentSteps.length === 0 ? {} : { recentSteps }),
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

/** 最后一条带正文的消息（跳过只有思考/工具调用的消息）。 */
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

function messageTime(message: Record<string, unknown> | undefined): string | undefined {
  const timestamp = numberValue(message?.["timestamp"]);
  return timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0 ? undefined : new Date(timestamp).toISOString();
}

/** 子代理消息的时间跨度：首条到最后一条。 */
function messageSpan(messages: unknown): { first?: string; last?: string } {
  if (!Array.isArray(messages)) return {};
  const times = messages
    .flatMap((message) => isRecord(message) ? [messageTime(message)] : [])
    .filter((time): time is string => time !== undefined);
  const [first] = times;
  const last = times.at(-1);
  return { ...(first === undefined ? {} : { first }), ...(last === undefined ? {} : { last }) };
}

/** 首条消息的时间作起点，派发时刻兼顾还没出消息的 call。 */
function callTiming(messages: unknown, state: SubagentCallView["state"], dispatchedAt?: string): Pick<SubagentCallView, "startedAt" | "durationMs"> {
  const { first, last } = messageSpan(messages);
  const startedAt = first ?? dispatchedAt;
  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(state === "running" || startedAt === undefined || last === undefined ? {} : { durationMs: Math.max(0, Date.parse(last) - Date.parse(startedAt)) }),
  };
}

function lastAssistantMessage(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message["role"] === "assistant") return message;
  }
  return undefined;
}

function thinkingLevelFrom(value: unknown): ThinkingLevel | undefined {
  const level = stringValue(value);
  return (THINKING_LEVELS as readonly string[]).includes(level) ? level as ThinkingLevel : undefined;
}

function recentToolCalls(messages: unknown): NonNullable<SubagentCallView["toolCalls"]> {
  if (!Array.isArray(messages)) return [];
  const calls: NonNullable<SubagentCallView["toolCalls"]> = [];
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
    for (const part of message["content"]) {
      if (!isRecord(part) || part["type"] !== "toolCall") continue;
      const name = stringValue(part["name"]) || "tool";
      calls.push({ name, summary: subagentToolSummary(name, part["arguments"] ?? part["args"]) });
    }
  }
  return calls.slice(-MAX_SUBAGENT_TOOL_CALLS);
}

/** 最近几条过程：思考 / 正文 / 动作按发生顺序拍平，只带尾部。 */
function recentStepStream(messages: unknown): NonNullable<SubagentCallView["recentSteps"]> {
  if (!Array.isArray(messages)) return [];
  const steps: NonNullable<SubagentCallView["recentSteps"]> = [];
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
    const at = messageTime(message);
    for (const part of message["content"]) {
      if (!isRecord(part)) continue;
      if (part["type"] === "thinking") {
        const text = stringValue(part["thinking"]);
        if (text !== "") steps.push({ kind: "thinking", ...(at === undefined ? {} : { at }), text: truncateOneLine(text, MAX_SUBAGENT_STEP_TEXT_CHARS) });
        continue;
      }
      if (part["type"] === "text") {
        const text = stringValue(part["text"]);
        if (text !== "") steps.push({ kind: "text", ...(at === undefined ? {} : { at }), text: truncateText(text, MAX_SUBAGENT_STEP_TEXT_CHARS) });
        continue;
      }
      if (part["type"] !== "toolCall") continue;
      const name = stringValue(part["name"]) || "tool";
      steps.push({ kind: "tool", ...(at === undefined ? {} : { at }), name, summary: subagentToolSummary(name, part["arguments"] ?? part["args"]) });
    }
  }
  return steps.slice(-MAX_SUBAGENT_STEPS);
}

/** 路径类参数先取文件名再截断，否则长路径会截成 `context.…`。 */
function subagentToolSummary(name: string, args: unknown): string {
  const path = stringValue(isRecord(args) ? args["path"] ?? args["file_path"] : undefined);
  if (path === "") return truncateOneLine(summarizeToolArgs(args), MAX_SUBAGENT_TOOL_SUMMARY_CHARS);
  const normalized = path.trim().replaceAll("\\", "/");
  const baseName = normalized.split("/").filter(Boolean).at(-1) ?? normalized;
  return truncateOneLine(name === "ls" ? normalized : baseName, MAX_SUBAGENT_TOOL_SUMMARY_CHARS);
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

