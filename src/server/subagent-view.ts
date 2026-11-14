import { THINKING_LEVELS, isRecord, type SubagentCallView, type SubagentRecord, type SubagentStreamItem, type SubagentThreadRow, type SubagentView, type ThinkingLevel, type ToolTimelineItem } from "../shared/protocol.js";
import { numberValue, stringValue } from "./values.js";

const MAX_SUBAGENT_PROMPT_CHARS = 160;
const MAX_SUBAGENT_FULL_PROMPT_CHARS = 8_000;
const MAX_SUBAGENT_OUTPUT_CHARS = 4_000;
const MAX_SUBAGENT_ERROR_CHARS = 240;
const MAX_SUBAGENT_TOOL_CALLS = 4;
const MAX_SUBAGENT_TOOL_SUMMARY_CHARS = 80;
const MAX_SUBAGENT_STEPS = 24;
const MAX_SUBAGENT_STEP_TEXT_CHARS = 200;

/** pi-subagent-manager：每个工具只管一个线程或一棵子树，线程快照是 ThreadView。 */
const MANAGER_TOOLS = new Set(["agent_spawn", "agent_wait", "agent_steer", "agent_status", "agent_stop"]);
const MANAGER_SEED_TOOLS = new Set(["agent_spawn"]);
const MANAGER_THREAD_STATES = ["starting", "running", "paused", "completed", "failed", "stopped"] as const;

export function subagentViewFromArgs(name: string, args: unknown, dispatchedAt?: string): SubagentView | undefined {
  if (!isRecord(args)) return undefined;
  if (MANAGER_SEED_TOOLS.has(name)) {
    const seed = managerCallFromArgs(args, dispatchedAt);
    return seed === undefined ? undefined : viewFromCalls([seed]);
  }
  if (name !== "subagent") return undefined;
  const results = Array.isArray(args["calls"])
    ? args["calls"].flatMap((value, index) => subagentCallFromArgs(value, index, dispatchedAt))
    : taskCallsFromArgs(args, dispatchedAt);
  return results.length === 0 ? undefined : viewFromCalls(results);
}

export function attachSubagentView(tool: ToolTimelineItem, result?: unknown): ToolTimelineItem {
  if (!MANAGER_TOOLS.has(tool.name) && tool.name !== "subagent") return tool;
  const fromResult = subagentViewFromResult(result, tool.createdAt, tool.subagent);
  if (fromResult !== undefined && fromResult.results.length > 0) return { ...tool, subagent: fromResult };
  return finalizeSeededSubagent(tool, result);
}

/** Apply a live pi-subagent-manager thread snapshot to the matching seeded call. */
export function attachLiveSubagentThread(tool: ToolTimelineItem, value: unknown): ToolTimelineItem {
  if (!MANAGER_TOOLS.has(tool.name) || tool.subagent === undefined || !isThreadView(value)) return tool;
  const path = stringValue(value["path"]);
  const index = tool.subagent.results.findIndex((call) => {
    const label = call.label;
    return label === path || (label !== undefined && !label.startsWith("/") && `/root/${label}` === path);
  });
  if (index < 0) return tool;
  const updated = managerCallFromThread(value, index, tool.createdAt, tool.subagent)[0];
  if (updated === undefined) return tool;
  const results = tool.subagent.results.map((call, resultIndex) => resultIndex === index ? updated : call);
  return { ...tool, subagent: viewFromCalls(results) };
}

const MAX_SUBAGENT_THREAD_LINE_CHARS = 80;
/** 子代理实时输出片段：只放行白名单字段，缺 id/kind 的整条丢掉。 */
export function subagentStreamItems(value: unknown): SubagentStreamItem[] {
  if (!Array.isArray(value)) return [];
  const items: SubagentStreamItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = stringValue(entry["id"]);
    const kind = stringValue(entry["kind"]);
    if (id === "" || (kind !== "text" && kind !== "thinking" && kind !== "tool")) continue;
    const item: SubagentStreamItem = { id, kind };
    const text = stringValue(entry["text"]);
    if (text !== "") item.text = text;
    if (typeof entry["streaming"] === "boolean") item.streaming = entry["streaming"];
    const name = stringValue(entry["name"]);
    if (name !== "") item.name = name;
    const state = stringValue(entry["state"]);
    if (state === "running" || state === "completed" || state === "failed") item.state = state;
    const output = stringValue(entry["output"]);
    if (output !== "") item.output = output;
    const error = stringValue(entry["error"]);
    if (error !== "") item.error = error;
    const at = stringValue(entry["at"]);
    if (at !== "") item.at = at;
    items.push(item);
  }
  return items;
}

/** 子会话文件名 `<时间戳>_<uuid>.jsonl` → uuid；对不上就不给，避免客户端拼错请求。 */
function threadSessionIdFromFile(sessionFile: string): string | undefined {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(sessionFile);
  return match?.[1];
}

/**
 * live 线程快照 → 会话状态用的最小行。
 * 返回 undefined 表示线程已结束（completed / failed / stopped），调用方据此移除。
 */
export function subagentThreadRow(value: unknown): SubagentThreadRow | undefined {
  if (!isThreadView(value)) return undefined;
  const state = stringValue(value["state"]);
  const rowState = state === "paused" ? "paused" as const : state === "starting" || state === "running" ? "running" as const : undefined;
  if (rowState === undefined) return undefined;
  const startedAt = timeFromMillis(value["startedAt"]);
  const elapsedMs = numberValue(value["elapsedMs"]);
  return {
    path: stringValue(value["path"]),
    type: stringValue(value["type"]),
    state: rowState,
    line: truncateOneLine(stringValue(value["summary"]) || stringValue(value["status"]) || stringValue(value["task"]), MAX_SUBAGENT_THREAD_LINE_CHARS),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(rowState === "paused" && elapsedMs !== undefined ? { elapsedMs } : {}),
  };
}

/** Read existing registry checkpoints for card hydration, without exposing child history. */
export function subagentThreadsFromEntries(entries: readonly unknown[]): unknown[] {
  const threads = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] !== "custom" || !isRecord(entry["data"])) continue;
    const data = entry["data"];
    if (data["version"] !== 1) continue;
    if (entry["customType"] === "pi-subagent:registry:v1" && Array.isArray(data["threads"])) {
      threads.clear();
      for (const thread of data["threads"]) {
        if (isRecord(thread) && isThreadView(thread["view"])) threads.set(stringValue(thread["view"]["path"]), thread["view"]);
      }
    } else if (entry["customType"] === "pi-subagent:registry-delta:v1" && Array.isArray(data["changes"])) {
      for (const change of data["changes"]) {
        if (!isRecord(change)) continue;
        const thread = change["thread"];
        if (isRecord(thread) && isThreadView(thread["view"])) {
          threads.set(stringValue(thread["view"]["path"]), thread["view"]);
        } else if (typeof change["path"] === "string" && isRecord(change["view"])) {
          const previous = threads.get(change["path"]);
          if (previous === undefined) continue;
          const view = { ...previous, ...change["view"] };
          if (Array.isArray(change["cleared"])) for (const field of change["cleared"]) {
            if (typeof field === "string") delete view[field];
          }
          threads.set(change["path"], view);
        }
      }
    }
  }
  return [...threads.values()];
}

/** 线程状态变化的时刻：delta 带自己的时间戳，全量快照只有 updatedAt。 */
function threadRecordedAt(entry: Record<string, unknown>, view: Record<string, unknown>): string | undefined {
  const fromEntry = entry["timestamp"];
  if (typeof fromEntry === "string" && Number.isFinite(Date.parse(fromEntry))) return new Date(fromEntry).toISOString();
  if (typeof fromEntry === "number") return timeFromMillis(fromEntry);
  return timeFromMillis(view["updatedAt"]);
}

/**
 * 从注册表快照与增量里抽出子代理的状态变更记录。
 * 只记派发与终态（完成/失败/停止）：暂停与恢复是临时态，留给胶囊。
 * 全量快照会丢掉更早的增量，所以旧会话只能还原出最终状态。
 */
export function subagentRecordsFromEntries(entries: readonly unknown[]): SubagentRecord[] {
  const threads = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  const records: SubagentRecord[] = [];
  const remember = (view: Record<string, unknown>, createdAt: string | undefined) => {
    const path = stringValue(view["path"]);
    if (path === "" || createdAt === undefined) return;
    const state = recordState(stringValue(view["state"]));
    if (state === undefined) return;
    const key = `${path}:${state}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push(recordFromView(view, state, createdAt));
  };
  for (const entry of entries) {
    if (!isRecord(entry) || entry["type"] !== "custom" || !isRecord(entry["data"])) continue;
    const data = entry["data"];
    if (data["version"] !== 1) continue;
    if (entry["customType"] === "pi-subagent:registry:v1" && Array.isArray(data["threads"])) {
      for (const thread of data["threads"]) {
        if (!isRecord(thread) || !isThreadView(thread["view"])) continue;
        threads.set(stringValue(thread["view"]["path"]), thread["view"]);
        remember(thread["view"], threadRecordedAt(entry, thread["view"]));
      }
    } else if (entry["customType"] === "pi-subagent:registry-delta:v1" && Array.isArray(data["changes"])) {
      for (const change of data["changes"]) {
        if (!isRecord(change)) continue;
        const thread = change["thread"];
        if (isRecord(thread) && isThreadView(thread["view"])) {
          threads.set(stringValue(thread["view"]["path"]), thread["view"]);
          remember(thread["view"], threadRecordedAt(entry, thread["view"]));
        } else if (typeof change["path"] === "string" && isRecord(change["view"])) {
          const previous = threads.get(change["path"]);
          if (previous === undefined || !isThreadView(previous)) continue;
          const view = { ...previous, ...change["view"] };
          threads.set(change["path"], view);
          remember(view, threadRecordedAt(entry, view));
        }
      }
    }
  }
  return records;
}

/** 派发与终态才进时间线；starting/running/paused 不是记录。 */
function recordState(raw: string): SubagentRecord["state"] | undefined {
  if (raw === "starting") return "dispatched";
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  if (raw === "stopped") return "stopped";
  return undefined;
}

function recordFromView(view: Record<string, unknown>, state: SubagentRecord["state"], createdAt: string): SubagentRecord {
  const path = stringValue(view["path"]);
  const agent = stringValue(view["type"]);
  const task = stringValue(view["task"]);
  const elapsedMs = state === "dispatched" ? undefined : numberValue(view["elapsedMs"]);
  const tokens = state === "dispatched" ? 0 : (numberValue(view["inputTokens"]) ?? 0) + (numberValue(view["outputTokens"]) ?? 0);
  const output = state === "dispatched" ? "" : truncateText(stringValue(view["output"]), MAX_SUBAGENT_OUTPUT_CHARS);
  const error = state === "failed" ? truncateText(stringValue(view["error"]), MAX_SUBAGENT_ERROR_CHARS) : "";
  return {
    kind: "subagent-record",
    id: `subagent-record:${path}:${state}`,
    createdAt,
    path,
    agent: agent === "" ? "子代理" : agent,
    prompt: truncateOneLine(task, MAX_SUBAGENT_PROMPT_CHARS),
    state,
    ...(elapsedMs === undefined ? {} : { durationMs: elapsedMs }),
    ...(tokens === 0 ? {} : { tokens }),
    ...(output === "" ? {} : { output }),
    ...(error === "" ? {} : { error }),
    fullPrompt: truncateText(task, MAX_SUBAGENT_FULL_PROMPT_CHARS),
  };
}

function subagentViewFromResult(result: unknown, dispatchedAt?: string, seed?: SubagentView): SubagentView | undefined {
  const threads = managerThreads(result);
  if (threads !== undefined) {
    const results = threads.flatMap((thread, index) => managerCallFromThread(thread, index, dispatchedAt, seed));
    return results.length === 0 ? undefined : viewFromCalls(results);
  }
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

/** 结果里的 `details` 可能是单个 ThreadView，也可能是线程数组。 */
function detailsValue(value: unknown): unknown {
  return isRecord(value) && value["details"] !== undefined ? value["details"] : value;
}

function isThreadView(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const state = stringValue(value["state"]);
  return typeof value["path"] === "string"
    && typeof value["type"] === "string"
    && typeof value["task"] === "string"
    && (MANAGER_THREAD_STATES as readonly string[]).includes(state);
}

/** `agent_status` 不带路径时返回可见子线程数组。 */
function managerThreads(result: unknown): Record<string, unknown>[] | undefined {
  const details = detailsValue(result);
  if (Array.isArray(details)) {
    const threads = details.filter(isThreadView);
    return threads.length === 0 ? undefined : threads;
  }
  return isThreadView(details) ? [details] : undefined;
}

function managerCallFromArgs(args: Record<string, unknown>, dispatchedAt?: string): SubagentCallView | undefined {
  const task = stringValue(args["task"]);
  if (task === "") return undefined;
  const agent = stringValue(args["type"]);
  const path = stringValue(args["path"]);
  return {
    agent: agent === "" ? "子代理" : agent,
    ...(path === "" ? {} : { label: path }),
    prompt: truncateOneLine(task, MAX_SUBAGENT_PROMPT_CHARS),
    state: "running",
    ...(dispatchedAt === undefined ? {} : { startedAt: dispatchedAt }),
    fullPrompt: truncateText(task, MAX_SUBAGENT_FULL_PROMPT_CHARS),
  };
}

function managerCallFromThread(value: Record<string, unknown>, fallbackCallIndex: number, dispatchedAt?: string, seed?: SubagentView): SubagentCallView[] {
  const state = managerCallState(stringValue(value["state"]));
  const agent = stringValue(value["type"]);
  const task = stringValue(value["task"]);
  const path = stringValue(value["path"]);
  const usage = managerUsage(value);
  const startedAt = timeFromMillis(numberValue(value["startedAt"]) ?? numberValue(value["lastStartedAt"]) ?? numberValue(value["createdAt"]))
    ?? seed?.results[fallbackCallIndex]?.startedAt
    ?? dispatchedAt;
  const elapsedMs = numberValue(value["elapsedMs"]);
  const thinkingLevel = thinkingLevelFrom(value["thinkingLevel"]);
  const model = stringValue(value["model"]);
  const output = truncateText(stringValue(value["output"]), MAX_SUBAGENT_OUTPUT_CHARS);
  const error = state === "running" ? "" : truncateText(stringValue(value["error"]), MAX_SUBAGENT_ERROR_CHARS);
  const progress = stringValue(value["status"]);
  const threadSessionId = threadSessionIdFromFile(stringValue(value["sessionFile"]));
  const steps = state === "running" && progress !== ""
    ? [{ kind: "text" as const, text: truncateText(progress, MAX_SUBAGENT_STEP_TEXT_CHARS) }]
    : [];
  return [{
    callIndex: fallbackCallIndex,
    agent: agent === "" ? "子代理" : agent,
    ...(path === "" ? {} : { label: path }),
    prompt: truncateOneLine(task, MAX_SUBAGENT_PROMPT_CHARS),
    state,
    ...(model === "" ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(usage === undefined ? {} : { usage }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(state === "running" || elapsedMs === undefined ? {} : { durationMs: Math.max(0, elapsedMs) }),
    ...(task === "" ? {} : { fullPrompt: truncateText(task, MAX_SUBAGENT_FULL_PROMPT_CHARS) }),
    ...(threadSessionId === undefined ? {} : { threadSessionId }),
    ...(steps.length === 0 ? {} : { recentSteps: steps }),
    ...(output === "" ? {} : { output }),
    ...(error === "" ? {} : { error }),
  }];
}

/** paused 是“停在轮边界、不交答案”，按未收尾计，不算失败也不算完成。 */
function managerCallState(raw: string): SubagentCallView["state"] {
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  if (raw === "stopped") return "cancelled";
  if (raw === "paused") return "partial";
  return "running";
}

function managerUsage(value: Record<string, unknown>): SubagentCallView["usage"] | undefined {
  const input = numberValue(value["inputTokens"]);
  const output = numberValue(value["outputTokens"]);
  const cost = numberValue(value["costUsd"]);
  const total = (input ?? 0) + (output ?? 0);
  if (input === undefined && output === undefined && (cost === undefined || cost <= 0)) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(total === 0 ? {} : { total }),
    ...(cost === undefined || cost <= 0 ? {} : { cost }),
  };
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
    completed: results.filter((call) => call.state === "completed").length,
    ...(results.some((call) => call.state === "partial") ? { partial: results.filter((call) => call.state === "partial").length } : {}),
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

