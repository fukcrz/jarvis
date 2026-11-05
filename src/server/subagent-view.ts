import { THINKING_LEVELS, isRecord, type SubagentCallView, type SubagentView, type ThinkingLevel, type ToolTimelineItem } from "../shared/protocol.js";
import { numberValue, stringValue } from "./values.js";

const MAX_SUBAGENT_PROMPT_CHARS = 160;
const MAX_SUBAGENT_FULL_PROMPT_CHARS = 8_000;
const MAX_SUBAGENT_OUTPUT_CHARS = 4_000;
const MAX_SUBAGENT_ERROR_CHARS = 240;
const MAX_SUBAGENT_TOOL_CALLS = 4;
const MAX_SUBAGENT_TOOL_SUMMARY_CHARS = 80;
const MAX_SUBAGENT_STEPS = 24;
const MAX_SUBAGENT_STEP_TEXT_CHARS = 200;

export function subagentViewFromArgs(name: string, args: unknown, dispatchedAt?: string): SubagentView | undefined {
  if (name !== "subagent" || !isRecord(args)) return undefined;
  const results = Array.isArray(args["calls"])
    ? args["calls"].flatMap((value, index) => subagentCallFromArgs(value, index, dispatchedAt))
    : taskCallsFromArgs(args, dispatchedAt);
  return results.length === 0 ? undefined : viewFromCalls(results);
}

export function attachSubagentView(tool: ToolTimelineItem, result?: unknown): ToolTimelineItem {
  if (tool.name !== "subagent") return tool;
  const fromResult = subagentViewFromResult(result, tool.createdAt, tool.subagent);
  if (fromResult !== undefined && fromResult.results.length > 0) return { ...tool, subagent: fromResult };
  return finalizeSeededSubagent(tool, result);
}

function subagentViewFromResult(result: unknown, dispatchedAt?: string, seed?: SubagentView): SubagentView | undefined {
  const details = detailsRecord(result);
  if (details === undefined || !Array.isArray(details["results"])) return undefined;
  const runStartedAt = timeFromMillis(details["startedAt"]);
  const runEndedAt = timeFromMillis(details["endedAt"]);
  const results = details["kind"] === "pi-subagent"
    ? details["results"].flatMap((value, index) => subagentCallFromResult(value, index, dispatchedAt))
    : details["results"].flatMap((value: unknown, index: number) => taskCallFromResult(value, index, dispatchedAt, seed?.results[index], runStartedAt, runEndedAt));
  return viewFromCalls(results);
}

function detailsRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value["details"])) return value["details"];
  return value;
}

/** 新插件的后台运行：工具已返回但子任务仍在跑时不能被标成完成。 */
function runIsStillActive(result: unknown): boolean {
  const details = detailsRecord(result);
  if (details === undefined) return false;
  const state = stringValue(details["state"]);
  return state === "queued" || state === "starting" || state === "running" || state === "cancelling";
}

function finalizeSeededSubagent(tool: ToolTimelineItem, result?: unknown): ToolTimelineItem {
  const view = tool.subagent;
  if (view === undefined) return tool;
  if (tool.state === "queued" || tool.state === "running") return tool;
  if (runIsStillActive(result)) return tool;
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
    completed: results.filter((call) => call.state === "completed" || call.state === "partial").length,
    running: results.filter((call) => call.state === "running").length,
    failed: results.filter((call) => call.state === "failed").length,
  };
}

/** @parke.dev/pi-subagent：单个 task 或 tasks 数组，入口先给出运行中的卡片。 */
function taskCallsFromArgs(args: Record<string, unknown>, dispatchedAt?: string): SubagentCallView[] {
  if (args["action"] !== undefined) return [];
  const tasks = args["tasks"];
  if (Array.isArray(tasks)) return tasks.flatMap((value, index) => taskCallFromArgs(value, index, dispatchedAt, args));
  if (stringValue(args["task"]) === "") return [];
  return taskCallFromArgs(args, 0, dispatchedAt, args);
}

function taskCallFromArgs(value: unknown, callIndex: number, dispatchedAt?: string, inherited?: Record<string, unknown>): SubagentCallView[] {
  if (!isRecord(value)) return [];
  const task = stringValue(value["task"]);
  if (task === "") return [];
  const explicitAgent = stringValue(value["agent"]);
  const inheritedAgent = inherited === undefined ? "" : stringValue(inherited["agent"]);
  const agent = explicitAgent || inheritedAgent;
  const profile = profileFrom(value["profile"]) ?? profileFrom(inherited?.["profile"]);
  const backend = backendFrom(value["backend"]) ?? backendFrom(inherited?.["backend"]);
  const label = stringValue(value["description"]) || stringValue(inherited?.["description"]);
  const model = stringValue(value["model"]) || (inherited === undefined ? "" : stringValue(inherited["model"]));
  const thinkingLevel = thinkingLevelFrom(value["thinking"]) ?? thinkingLevelFrom(inherited?.["thinking"]);
  const isolation = stringValue(value["isolation"]) || (inherited === undefined ? "" : stringValue(inherited["isolation"]));
  const fullPrompt = truncateText(task, MAX_SUBAGENT_FULL_PROMPT_CHARS);
  return [{
    callIndex,
    agent: agent !== "" ? agent : "子代理",
    ...(label === "" ? {} : { label }),
    prompt: truncateOneLine(task, MAX_SUBAGENT_PROMPT_CHARS),
    state: "running",
    ...(dispatchedAt === undefined ? {} : { startedAt: dispatchedAt }),
    ...(model === "" ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(profile === undefined ? {} : { profile }),
    ...(backend === undefined ? {} : { backend }),
    ...(isolation === "worktree" ? { worktree: true } : {}),
    ...(fullPrompt === "" ? {} : { fullPrompt }),
  }];
}

function taskCallFromResult(value: unknown, fallbackCallIndex: number, dispatchedAt?: string, seed?: SubagentCallView, runStartedAt?: string, runEndedAt?: string): SubagentCallView[] {
  if (!isRecord(value)) return [];
  const rawCallIndex = numberValue(value["callIndex"] ?? value["index"]);
  const callIndex = rawCallIndex !== undefined && Number.isInteger(rawCallIndex) && rawCallIndex >= 0 ? rawCallIndex : fallbackCallIndex;
  const state = taskCallState(value["state"], stringValue(value["errorMessage"]));
  const task = stringValue(value["task"]) || seed?.fullPrompt || "";
  const prompt = truncateOneLine(task, MAX_SUBAGENT_PROMPT_CHARS) || seed?.prompt || "";
  const fullPrompt = truncateText(task, MAX_SUBAGENT_FULL_PROMPT_CHARS);
  const profile = profileFrom(value["profile"]) ?? seed?.profile;
  const backend = backendFrom(value["backend"]) ?? seed?.backend;
  const model = stringValue(value["model"]) || seed?.model || "";
  const thinkingLevel = thinkingLevelFrom(value["thinking"]) ?? seed?.thinkingLevel;
  const usage = usageFrom(value["usage"]);
  const turns = usage.turns;
  const startedAt = seed?.startedAt ?? runStartedAt ?? dispatchedAt;
  const endedAt = state === "running" ? undefined : runEndedAt;
  const errorText = state === "running" ? "" : [stringValue(value["errorMessage"]), stringValue(value["structuredError"])].filter(Boolean).join(" · ");
  const output = truncateText(stringValue(value["finalOutput"]), MAX_SUBAGENT_OUTPUT_CHARS);
  const steps = stepsFromTranscript(stringValue(value["transcript"]));
  const label = stringValue(value["label"]) || seed?.label;
  const sessionId = stringValue(value["sessionId"]);
  const worktree = isRecord(value["worktree"]) || seed?.worktree === true;
  const durationStart = runStartedAt ?? startedAt;
  const durationMs = durationStart === undefined || endedAt === undefined ? undefined : Math.max(0, Date.parse(endedAt) - Date.parse(durationStart));
  return [{
    callIndex,
    agent: seed?.agent ?? profile ?? backend ?? "子代理",
    ...(label === undefined || label === "" ? {} : { label }),
    prompt,
    state,
    ...(model === "" ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(profile === undefined ? {} : { profile }),
    ...(backend === undefined ? {} : { backend }),
    ...(worktree ? { worktree: true } : {}),
    ...(turns !== undefined && turns > 0 ? { turns } : {}),
    ...(usage.view === undefined ? {} : { usage: usage.view }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(sessionId === "" ? {} : { sessionHandle: sessionId }),
    ...(fullPrompt === "" ? {} : { fullPrompt }),
    ...(steps.length === 0 ? {} : { recentSteps: steps }),
    ...(output === "" ? {} : { output }),
    ...(errorText === "" ? {} : { error: truncateText(errorText, MAX_SUBAGENT_ERROR_CHARS) }),
  }];
}

/** 新插件在 usage 里给 tokens / 成本；旧插件只有轮数。 */
function usageFrom(value: unknown): { turns?: number; view?: SubagentCallView["usage"] } {
  if (!isRecord(value)) return {};
  const turns = numberValue(value["turns"]);
  const input = numberValue(value["input"]);
  const output = numberValue(value["output"]);
  const cacheRead = numberValue(value["cacheRead"]);
  const cacheWrite = numberValue(value["cacheWrite"]);
  const cost = numberValue(value["cost"]);
  const total = numberValue(value["totalTokens"]) ?? [input, output, cacheRead, cacheWrite].reduce<number>((sum, part) => sum + (part ?? 0), 0);
  const view = input === undefined && output === undefined && cost === undefined && total === 0 ? undefined : {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(total === undefined || total === 0 ? {} : { total }),
    ...(cost === undefined || cost <= 0 ? {} : { cost }),
  };
  return { ...(turns === undefined ? {} : { turns }), ...(view === undefined ? {} : { view }) };
}

function taskCallState(raw: unknown, errorMessage: string): SubagentCallView["state"] {
  const state = stringValue(raw);
  if (state === "partial") return "partial";
  if (state === "cancelled") return "cancelled";
  if (state === "failed" || state === "timeout" || state === "lost") return "failed";
  if (state === "completed") return "completed";
  if (state === "queued" || state === "starting" || state === "running" || state === "cancelling") return "running";
  return errorMessage === "" ? "completed" : "failed";
}

function profileFrom(value: unknown): SubagentCallView["profile"] | undefined {
  return value === "explore" || value === "review" || value === "general" ? value : undefined;
}

function backendFrom(value: unknown): SubagentCallView["backend"] | undefined {
  return value === "pi" || value === "codex" || value === "claude" ? value : undefined;
}

function timeFromMillis(value: unknown): string | undefined {
  const millis = numberValue(value);
  return millis === undefined || !Number.isFinite(millis) || millis <= 0 ? undefined : new Date(millis).toISOString();
}

/** 新插件的子会话过程是拍平的纯文本行：`→ tool {args}` / 正文 / `← tool 结果`。 */
function stepsFromTranscript(transcript: string): NonNullable<SubagentCallView["recentSteps"]> {
  if (transcript.trim() === "") return [];
  const steps: NonNullable<SubagentCallView["recentSteps"]> = [];
  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("← ")) continue;
    if (!line.startsWith("→ ")) {
      steps.push({ kind: "text", text: truncateText(line, MAX_SUBAGENT_STEP_TEXT_CHARS) });
      continue;
    }
    const body = line.slice(2).trim();
    const space = body.indexOf(" ");
    const name = (space === -1 ? body : body.slice(0, space)) || "tool";
    const rawArgs = space === -1 ? "" : body.slice(space + 1).trim();
    steps.push({ kind: "tool", name, summary: subagentToolSummary(name, parseToolArguments(rawArgs)) });
  }
  return steps.slice(-MAX_SUBAGENT_STEPS);
}

function parseToolArguments(raw: string): unknown {
  if (raw === "") return "";
  if (!raw.startsWith("{") && !raw.startsWith("[")) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
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

