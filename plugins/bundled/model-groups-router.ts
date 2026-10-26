import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "model-groups";
/** footer 状态栏的 key,用 setStatus 展示当前会话实际使用的真实 route。 */
const STATUS_KEY = "model-groups";
const STATE_ENTRY_TYPE = "model-group-router-state";
const DEFAULT_THRESHOLD_TOKENS = 230_000;
/** 与 Pi settings.json 的 compaction.reserveTokens 对齐的兜底值,用于按窗口封顶阈值。 */
const DEFAULT_RESERVE_TOKENS = 32_768;
const DEFAULT_GROUP_RETRY_DELAY_MS = 180_000;
const GROUP_RETRY_WAIT_CHUNK_MS = 30_000;
const COMPACTION_INSTRUCTIONS_MAX_CHARS = 4_000;
export const CONTINUATION_CUSTOM_TYPE = "compaction-continuation";
export const CONTINUATION_WRAPPER =
	"Context was compacted. The user's last message follows, restored verbatim. Answer that message. Do not treat this wrapper, the compaction summary, or in-progress tool work as permission to implement.";
export const CONTINUATION_FALLBACK =
	"Context was compacted. Answer the user's last message using the compacted summary. Do not treat this wrapper, the compaction summary, or in-progress tool work as permission to implement.";
export const SUBAGENT_CONTINUATION_WRAPPER =
	"Context was compacted. Continue the delegated task from the summary and the kept recent messages. Do not restart completed work. The original task follows.";
export const SUBAGENT_CONTINUATION_FALLBACK =
	"Context was compacted. Continue the delegated task from the summary and the kept recent messages. Do not restart completed work.";
export const SUBAGENT_COMPACTION_INSTRUCTIONS_PREFIX =
	"The latest user message is an already-authorized delegated task. Preserve the task, file paths, decisions, and remaining work. Next Steps must continue that task, not wait for confirmation.";
const COMPACTION_INSTRUCTIONS_PREFIX =
	'Quote the user\'s last message VERBATIM in a section titled "## User\'s last message". Do not paraphrase it. Do not treat assistant actions as user authorization. If the last user message is a question or has not confirmed a plan, Next Steps must wait for confirmation rather than implement.';

type Route = {
	provider: string;
	model: string;
	recommendedConcurrency?: number;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 保留模型组对外的思考等级,只将请求等级向下兼容到当前真实 route。
 * 标准等级在 map 中缺省时表示支持;xhigh/max 则必须显式声明且不能为 null。
 */
const compatibleThinkingLevel = (model: Model<Api>, requested: ThinkingLevel | undefined): ThinkingLevel | undefined => {
	if (requested === undefined) return undefined;
	if (!model.reasoning) return "off";
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index >= 0; index -= 1) {
		const level = THINKING_LEVELS[index];
		const mapped = model.thinkingLevelMap?.[level];
		const supported = mapped !== null && (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high" || mapped !== undefined);
		if (supported) return level;
	}
	return "off";
};

type Group = {
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	thinkingLevelMap?: Record<string, string | null>;
	routes: Route[];
};

type Config = {
	version: number;
	retry?: {
		/** 整组失败后从头再打之前的等待。默认 3 分钟。 */
		groupRetryDelayMs?: number;
	};
	compaction?: {
		thresholdTokens?: number;
		/** 按窗口封顶阈值时预留的响应空间,默认 32768。 */
		reserveTokens?: number;
	};
	groups: Record<string, Group>;
};

type SessionState = {
	groupId?: string;
	taskRouteIndex?: number;
};

type PersistedState = SessionState & { version: 1 };

const routeKey = (route: Route) => `${route.provider}/${route.model}`;
const formatTokens = (tokens: number) => tokens.toLocaleString("en-US");

const readConfig = (path: string): Config => {
	let value: Config;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as Config;
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return { version: 1, groups: {} };
		}
		throw error;
	}
	if (!value.groups || typeof value.groups !== "object") {
		throw new Error("model-groups.json must contain a groups object");
	}
	for (const [id, group] of Object.entries(value.groups)) {
		if (!Array.isArray(group.routes) || group.routes.length === 0) {
			throw new Error(`Model group '${id}' must have at least one route`);
		}
	}
	return value;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const isSyntheticContinuationText = (text: string): boolean => {
	const trimmed = text.trim();
	return (
		trimmed.startsWith("Continue the current task from the compacted context")
		|| trimmed.startsWith("The conversation was compacted.")
		|| trimmed.startsWith("Context was compacted.")
	);
};

export const textFromMessageContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
};

export const lastUserMessageFromBranch = (entries: readonly unknown[]): string | undefined => {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "user") continue;
		const text = textFromMessageContent(entry.message.content);
		if (!text.trim() || isSyntheticContinuationText(text)) continue;
		return text;
	}
	return undefined;
};

const clipText = (value: string, maxChars: number) => {
	const trimmed = value.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars).trimEnd()}…`;
};

export const isSubagentProcess = (): boolean => {
	const raw = process.env.PI_SUBAGENT_DEPTH;
	if (raw === undefined || raw.trim() === "") return false;
	const depth = Number(raw);
	return Number.isInteger(depth) && depth > 0;
};

export const buildCompactionInstructions = (lastUserText: string | undefined): string => {
	const quoted = lastUserText?.trim() ? clipText(lastUserText, COMPACTION_INSTRUCTIONS_MAX_CHARS) : "";
	if (!quoted) return COMPACTION_INSTRUCTIONS_PREFIX;
	return `${COMPACTION_INSTRUCTIONS_PREFIX}\n\nUser's last message:\n${quoted}`;
};

export const buildSubagentCompactionInstructions = (lastUserText: string | undefined): string => {
	const quoted = lastUserText?.trim() ? clipText(lastUserText, COMPACTION_INSTRUCTIONS_MAX_CHARS) : "";
	if (!quoted) return SUBAGENT_COMPACTION_INSTRUCTIONS_PREFIX;
	return `${SUBAGENT_COMPACTION_INSTRUCTIONS_PREFIX}\n\nDelegated task:\n${quoted}`;
};

export const sessionLogHint = (sessionFile: string | undefined): string => {
	const path = sessionFile?.trim();
	if (!path) return "";
	return `The full session log is still on disk at:\n${path}\nIf the summary is missing a decision, quote, or file detail, read that file (user messages or the latest entries). Do not read the whole file.`;
};

export const buildContinuationContent = (lastUserText: string | undefined, sessionFile?: string): string => {
	const body = lastUserText?.trim() ?? "";
	const hint = sessionLogHint(sessionFile);
	const parts = [body ? CONTINUATION_WRAPPER : CONTINUATION_FALLBACK];
	if (hint) parts.push(hint);
	if (body) parts.push(body);
	return parts.join("\n\n");
};

export const buildSubagentContinuationContent = (lastUserText: string | undefined, sessionFile?: string): string => {
	const body = lastUserText?.trim() ?? "";
	const hint = sessionLogHint(sessionFile);
	const parts = [body ? SUBAGENT_CONTINUATION_WRAPPER : SUBAGENT_CONTINUATION_FALLBACK];
	if (hint) parts.push(hint);
	if (body) parts.push(body);
	return parts.join("\n\n");
};

const errorMessageOf = (event: Extract<AssistantMessageEvent, { type: "error" }>) =>
	event.error.errorMessage || "Unknown provider error";

const remapMessage = (message: AssistantMessage, model: Model<Api>): AssistantMessage => ({
	...message,
	api: model.api,
	provider: model.provider,
	model: model.id,
});

const remapEvent = (event: AssistantMessageEvent, model: Model<Api>, route: Route): AssistantMessageEvent => {
	const withRoute = (message: AssistantMessage): AssistantMessage => ({
		...remapMessage(message, model),
		routeProvider: route.provider,
		routeModel: route.model,
	} as AssistantMessage);
	if (event.type === "done") return { ...event, message: withRoute(event.message) };
	if (event.type === "error") return { ...event, error: withRoute(event.error) };
	return { ...event, partial: withRoute(event.partial) } as AssistantMessageEvent;
};

const createError = (model: Model<Api>, message: string, aborted = false): AssistantMessageEvent => ({
	type: "error",
	reason: aborted ? "aborted" : "error",
	error: {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage: message,
		timestamp: Date.now(),
	},
});

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<"ok" | "aborted">((resolve) => {
		if (signal?.aborted) {
			resolve("aborted");
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve("ok");
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve("aborted");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * 一个会话的 model-groups 运行时。Pi 会为同一工作区的每个会话重新调用本
 * factory,因此任务进度(groupId/taskRouteIndex)天然按会话隔离。
 */
type SessionRuntime = {
	pi: ExtensionAPI;
	sessionId?: string;
	ctx: ExtensionContext | undefined;
	config: Config;
	state: SessionState;
	compactionInProgress: boolean;
	compactionRetryTimer: ReturnType<typeof setTimeout> | undefined;
	continuationQueued: boolean;
	pendingLastUser: string | undefined;
	taskActive: boolean;
	/** agent_end 之后、下一次 agent_start 之前为 true:此时的阈值压缩发生在任务答完之后。 */
	agentEnded: boolean;
	runtimeActive: boolean;
	// Report a switch only after the next retry actually selects a route.
	pendingSwitchFrom: string | undefined;
	/** 整组打完后的下一次从头时间;未到点前不选路。 */
	groupRestartAt: number | undefined;
	/** 本会话的流式实现(闭包持有上面的状态),factory 末尾赋入。 */
	stream?: (virtualModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
};

/**
 * 会话注册表(模块级,进程内共享):
 *
 * jarvis 里所有会话共享同一个 ModelRuntime,provider 注册是"最后注册者胜"。
 * 因此 provider 的 streamSimple 不能闭包某个会话的状态——否则后打开的会话会
 * 覆盖先注册的闭包,导致先开会话的流式请求(路由失败/切换/压缩的通知和续写)
 * 全部串到最近加载的那个会话。
 *
 * 这里改为:provider 只负责分发,通过请求携带的稳定 ownerSessionId
 * （普通请求退化为 sessionId）在进程级注册表中找到真正所属的会话运行时,
 * 再执行该会话自己的路由逻辑。
 */
type SharedRouterState = {
	runtimes: Map<string, SessionRuntime>;
	activeRoutes: Map<string, number>;
	config?: Config;
	configPath?: string;
};

/**
 * Pi can instantiate the same extension module more than once after /reload.
 * The virtual provider is process-shared, so its routing registry must be too.
 */
const shared = ((process as NodeJS.Process & { __jarvisModelGroupsRouter?: SharedRouterState }).__jarvisModelGroupsRouter ??= {
	runtimes: new Map<string, SessionRuntime>(),
	activeRoutes: new Map<string, number>(),
});

/**
 * ownerSessionId is injected by Pi's session-scoped SDK stream function. It
 * remains stable for normal requests, retries, compaction and branch summaries;
 * sessionId may deliberately change for standalone summary requests.
 */
function resolveRuntime(ownerSessionId: string | undefined, sessionId: string | undefined, groupId: string): SessionRuntime | undefined {
	const runtime = shared.runtimes.get(ownerSessionId ?? sessionId ?? "");
	if (runtime?.runtimeActive) return runtime;
	// Compatibility for AgentSession instances created before ownerSessionId was
	// introduced. It is safe only when exactly one active task selected this
	// virtual group; new sessions always take the exact path above.
	const legacy = [...shared.runtimes.values()].filter((candidate) =>
		candidate.runtimeActive
		&& candidate.ctx?.model?.provider === PROVIDER_ID
		&& candidate.ctx.model.id === groupId,
	);
	return legacy.length === 1 ? legacy[0] : undefined;
}

function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	output.push(createError(model, message));
	output.end();
	return output;
}

export default function (pi: ExtensionAPI) {
	const configDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pi", "agent");
	const configPath = join(configDir, "model-groups.json");

	shared.config = readConfig(configPath);
	shared.configPath = configPath;
	for (const runtime of shared.runtimes.values()) runtime.config = shared.config;
	const rt: SessionRuntime = {
		pi,
		ctx: undefined,
		config: shared.config,
		state: {},
		compactionInProgress: false,
		compactionRetryTimer: undefined,
		continuationQueued: false,
		pendingLastUser: undefined,
		taskActive: false,
		agentEnded: false,
		runtimeActive: true,
		pendingSwitchFrom: undefined,
		groupRestartAt: undefined,
	};

	const notify = (ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") => {
		try {
			if (ctx?.hasUI) ctx.ui.notify(message, level);
		} catch {
			// Stale ctx after session disposal; the notification is best-effort.
		}
	};

	/** 当前会话实际使用的真实模型文本;未选中组或无 route 时返回 undefined(清空状态栏)。 */
	const currentRouteText = (): string | undefined => {
		const { groupId, taskRouteIndex } = rt.state;
		if (groupId === undefined) return undefined;
		const group = rt.config.groups[groupId];
		if (!group) return undefined;
		const route = taskRouteIndex !== undefined ? group.routes[taskRouteIndex] : undefined;
		return route ? routeKey(route) : undefined;
	};

	/** 用 setStatus 把当前真实 route 显示到状态栏;纯展示,不影响路由逻辑。 */
	const updateStatus = (ctx?: ExtensionContext) => {
		if (!rt.runtimeActive) return;
		try {
			const target = ctx ?? rt.ctx;
			if (!target?.hasUI) return;
			target.ui.setStatus(STATUS_KEY, currentRouteText());
		} catch {
			// Status display is best-effort; never affect routing logic.
		}
	};

	// A reload, session switch, or fork invalidates every context object from
	// this extension instance. Streams can resume after an await, so they must
	// verify ownership before touching a captured ctx again.
	const ownsContext = (ctx: ExtensionContext) => rt.runtimeActive && rt.ctx === ctx;

	const persist = () => {
		if (!rt.runtimeActive) return;
		try {
			pi.appendEntry(STATE_ENTRY_TYPE, { version: 1, ...rt.state } satisfies PersistedState);
		} catch {
			// A session disposed or replaced while an async continuation (stream
			// error, compaction callback, retry timer) was still running leaves
			// the extension ctx stale and pi.appendEntry throwing. The entry has
			// nowhere to go; drop it instead of letting the throw escape as an
			// unhandled rejection that kills the host process.
		}
	};

	const restore = (ctx: ExtensionContext) => {
		rt.state = {};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !isObject(entry.data)) continue;
			const data = entry.data as Partial<PersistedState>;
			rt.state = {
				groupId: typeof data.groupId === "string" ? data.groupId : undefined,
				taskRouteIndex: typeof data.taskRouteIndex === "number" ? data.taskRouteIndex : undefined,
			};
		}
	};

	const groupRetryDelayMs = () => rt.config.retry?.groupRetryDelayMs ?? DEFAULT_GROUP_RETRY_DELAY_MS;

	/**
	 * 任务中压缩阈值,对所有模型生效:使用配置的绝对阈值,但按当前模型的 Pi 原生
	 * 阈值(contextWindow - reserveTokens)封顶,避免小窗口模型够不到绝对阈值而永不压缩。
	 */
	const thresholdTokens = (ctx?: ExtensionContext) => {
		const configured = rt.config.compaction?.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
		const contextWindow = ctx?.model?.contextWindow;
		if (contextWindow === undefined || contextWindow <= 0) return configured;
		const nativeThreshold = contextWindow - (rt.config.compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
		return Math.min(configured, Math.max(1, nativeThreshold));
	};

	const chooseRoute = (groupId: string, preferFirst: boolean): number | undefined => {
		const group = rt.config.groups[groupId];
		if (!group || group.routes.length === 0) return undefined;
		if (preferFirst) return 0;
		const current = rt.state.taskRouteIndex;
		if (current !== undefined && current >= 0 && current < group.routes.length) return current;

		const underRecommended = group.routes.findIndex((route) => {
			const recommended = route.recommendedConcurrency;
			return recommended === undefined || (shared.activeRoutes.get(routeKey(route)) ?? 0) < recommended;
		});
		return underRecommended >= 0 ? underRecommended : 0;
	};

	const selectGroupRoute = (groupId: string, preferFirst: boolean, ctx?: ExtensionContext) => {
		const index = chooseRoute(groupId, preferFirst);
		if (index === undefined) return undefined;
		const route = rt.config.groups[groupId].routes[index];
		rt.state.groupId = groupId;
		rt.state.taskRouteIndex = index;
		persist();
		updateStatus(ctx);
		return route;
	};

	const markFailure = (groupId: string, route: Route, routeIndex: number) => {
		if (routeIndex + 1 < rt.config.groups[groupId].routes.length) {
			rt.state.taskRouteIndex = routeIndex + 1;
		} else {
			rt.state.taskRouteIndex = undefined;
			rt.groupRestartAt = Date.now() + groupRetryDelayMs();
		}
		rt.pendingSwitchFrom = routeKey(route);
		persist();
		updateStatus();
	};

	const markSuccess = (groupId: string, routeIndex: number) => {
		rt.state.groupId = groupId;
		rt.state.taskRouteIndex = routeIndex;
		rt.groupRestartAt = undefined;
		persist();
		updateStatus();
	};

	const groupIdFromModel = (model: Model<Api>) => (model.provider === PROVIDER_ID ? model.id : undefined);

	const clearCompactionRetry = () => {
		if (rt.compactionRetryTimer) {
			clearTimeout(rt.compactionRetryTimer);
			rt.compactionRetryTimer = undefined;
		}
	};

	const startCompaction = (ctx: ExtensionContext, tokens: number) => {
		if (!rt.runtimeActive || rt.compactionInProgress || rt.continuationQueued) return;
		const subagent = isSubagentProcess();
		rt.compactionInProgress = true;
		try {
			rt.pendingLastUser = lastUserMessageFromBranch(ctx.sessionManager.getBranch());
		} catch {
			rt.pendingLastUser = undefined;
		}
		notify(ctx, subagent
			? `Context reached ${formatTokens(tokens)} tokens; compacting, then continuing the delegated task.`
			: `Context reached ${formatTokens(tokens)} tokens; compacting, then restoring the last user message.`);
		ctx.compact({
			customInstructions: subagent
				? buildSubagentCompactionInstructions(rt.pendingLastUser)
				: buildCompactionInstructions(rt.pendingLastUser),
			onComplete: () => {
				rt.compactionInProgress = false;
				const lastUserText = rt.pendingLastUser;
				rt.pendingLastUser = undefined;
				try {
					if (!rt.runtimeActive || rt.continuationQueued) return;
					// Route promotion is for a parent task restart. A subagent must stay
					// on the route that was already doing the delegated work.
					if (!subagent) {
						const groupId = ctx.model?.provider === PROVIDER_ID ? rt.state.groupId : undefined;
						const previousRoute = groupId && rt.state.taskRouteIndex !== undefined ? rt.config.groups[groupId]?.routes[rt.state.taskRouteIndex] : undefined;
						const selectedRoute = groupId ? selectGroupRoute(groupId, true, ctx) : undefined;
						if (previousRoute && selectedRoute && routeKey(previousRoute) !== routeKey(selectedRoute)) {
							notify(ctx, `Model-group promoted after compaction:\n${routeKey(previousRoute)}\n→ ${routeKey(selectedRoute)}`);
						}
						notify(ctx, groupId ? "Context compacted; selecting the first route and restoring the last user message." : "Context compacted; restoring the last user message.");
					} else {
						notify(ctx, "Context compacted; continuing the delegated task.");
					}
					rt.continuationQueued = true;
					// If the aborted agent loop has not fully settled yet, retain this
					// as a follow-up instead of steering or dropping the continuation.
					// Hidden custom message: Jarvis/TUI must not show this as a user bubble.
					let sessionFile: string | undefined;
					try {
						sessionFile = ctx.sessionManager.getSessionFile();
					} catch {
						sessionFile = undefined;
					}
					pi.sendMessage({
						customType: CONTINUATION_CUSTOM_TYPE,
						content: subagent
							? buildSubagentContinuationContent(lastUserText, sessionFile)
							: buildContinuationContent(lastUserText, sessionFile),
						display: false,
					}, { triggerTurn: true, deliverAs: "followUp" });
				} catch {
					// Session was disposed or replaced before this callback ran.
				}
			},
			onError: (error) => {
				rt.compactionInProgress = false;
				rt.pendingLastUser = undefined;
				if (!rt.runtimeActive || error.name === "AbortError" || error.message === "Compaction cancelled") return;
				const delay = groupRetryDelayMs();
				notify(ctx, `Context compaction failed: ${error.message}. Retrying in ${Math.ceil(delay / 1000)}s...`, "warning");
				clearCompactionRetry();
				rt.compactionRetryTimer = setTimeout(() => {
					rt.compactionRetryTimer = undefined;
					try {
						const currentTokens = ctx.getContextUsage()?.tokens;
						if (currentTokens !== null && currentTokens !== undefined && currentTokens >= thresholdTokens(ctx)) {
							startCompaction(ctx, currentTokens);
						}
					} catch {
						// Session was disposed while the retry timer was pending.
					}
				}, delay);
			},
		});
	};

	const waitBeforeRestart = async (
		ctx: ExtensionContext,
		groupId: string,
		signal: AbortSignal | undefined,
	): Promise<"continue" | "abort" | "gone"> => {
		const delay = groupRetryDelayMs();
		const existing = rt.groupRestartAt !== undefined && rt.groupRestartAt > Date.now() ? rt.groupRestartAt : undefined;
		const deadline = existing ?? Date.now() + delay;
		rt.groupRestartAt = deadline;
		const remainingAtStart = deadline - Date.now();
		if (remainingAtStart > 0) {
			notify(ctx, `Model group '${groupId}' failed all routes. Retrying from the first route in ${Math.ceil(remainingAtStart / 1000)}s.`, "warning");
		}
		while (Date.now() < deadline) {
			if (!ownsContext(ctx)) return "gone";
			if (signal?.aborted) return "abort";
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const result = await sleep(Math.min(GROUP_RETRY_WAIT_CHUNK_MS, remaining), signal);
			if (result === "aborted") return ownsContext(ctx) ? "abort" : "gone";
		}
		if (!ownsContext(ctx)) return "gone";
		if (signal?.aborted) return "abort";
		rt.groupRestartAt = undefined;
		rt.state.taskRouteIndex = 0;
		rt.pendingSwitchFrom = undefined;
		persist();
		updateStatus(ctx);
		return "continue";
	};

	const streamGroup = (virtualModel: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			let ctx: ExtensionContext | undefined;
			try {
				const groupId = groupIdFromModel(virtualModel);
				ctx = rt.ctx;
				if (!groupId || !rt.config.groups[groupId] || !ctx || !ownsContext(ctx)) {
					output.push(createError(virtualModel, "Model group runtime is not ready"));
					return;
				}
				// ctx.compact() is intentionally fire-and-forget in the extension API.
				// At turn_start the agent may enter streamGroup once more before the
				// abort settles. Stop only that normal-session request; compaction's
				// summarizer uses a fresh sessionId and must pass through.
				if (rt.compactionInProgress && (options?.sessionId === undefined || options.sessionId === rt.sessionId)) {
					output.push(createError(virtualModel, "Compacting context before continuing", true));
					return;
				}

				const tried = new Set<number>();
				while (ownsContext(ctx)) {
					const restartDue = rt.groupRestartAt !== undefined && Date.now() < rt.groupRestartAt;
					const wrapped = rt.state.taskRouteIndex === undefined && tried.size > 0;
					if (restartDue || wrapped || (rt.state.taskRouteIndex !== undefined && tried.has(rt.state.taskRouteIndex))) {
						const wait = await waitBeforeRestart(ctx, groupId, options?.signal);
						if (wait !== "continue") {
							if (wait === "abort") output.push(createError(virtualModel, "Request cancelled", true));
							return;
						}
						tried.clear();
						continue;
					}
					const route = selectGroupRoute(groupId, false, ctx);
					const routeIndex = rt.state.taskRouteIndex;
					if (!route || routeIndex === undefined) {
						output.push(createError(virtualModel, `Model group '${groupId}' has no routes`));
						return;
					}
					tried.add(routeIndex);
					const key = routeKey(route);
					if (rt.pendingSwitchFrom && rt.pendingSwitchFrom !== key) {
						notify(ctx, `Model-group switched:\n${rt.pendingSwitchFrom}\n→ ${key}`, "warning");
						rt.pendingSwitchFrom = undefined;
					}

					const realModel = ctx.modelRegistry.find(route.provider, route.model);
					if (!realModel) {
						markFailure(groupId, route, routeIndex);
						continue;
					}

					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(realModel);
					// The awaited authentication lookup can finish after /reload or a
					// session replacement. Do not access or report through the stale ctx.
					if (!ownsContext(ctx)) return;
					if (!auth.ok) {
						markFailure(groupId, route, routeIndex);
						continue;
					}

					const realProvider = ctx.modelRegistry.getProvider(route.provider);
					if (!realProvider) {
						markFailure(groupId, route, routeIndex);
						continue;
					}

					shared.activeRoutes.set(key, (shared.activeRoutes.get(key) ?? 0) + 1);
					let emitted = false;
					try {
						const routeThinkingLevel = compatibleThinkingLevel(realModel, options?.reasoning);
						const realStream = realProvider.streamSimple(realModel, context, {
							...options,
							reasoning: routeThinkingLevel === "off" ? undefined : routeThinkingLevel,
							apiKey: auth.apiKey,
							headers: auth.headers,
							env: auth.env,
							maxRetries: 0,
						});
						let retryRoute = false;
						for await (const event of realStream) {
							// A provider may yield after its owning session has gone away.
							// Ending the obsolete output is sufficient; emitting an error here
							// incorrectly fails the replacement session's task.
							if (!ownsContext(ctx)) return;
							if (event.type === "error") {
								const message = errorMessageOf(event);
								if (event.reason === "aborted" || options?.signal?.aborted) {
									output.push(remapEvent(event, virtualModel));
									return;
								}
								if (/context[_ -]?(length|window)|maximum context|too many tokens|token limit/i.test(message)) {
									// Preserve overflow errors so Pi's own compact-and-retry recovery handles them.
									output.push(remapEvent(event, virtualModel));
									return;
								}
								markFailure(groupId, route, routeIndex);
								// Partial output already belongs to this assistant message;
								// switching routes in-stream would mix two models. Let Pi retry.
								if (emitted) {
									notify(ctx, `Model-group route failed: ${key}. Pi will retry another route.`, "warning");
									output.push(createError(virtualModel, `HTTP 503: model-group route failed (${key}): ${message}`));
									return;
								}
								retryRoute = true;
								break;
							}
							if (event.type === "done") markSuccess(groupId, routeIndex);
							if (event.type !== "done") emitted = true;
							output.push(remapEvent(event, virtualModel, route));
							if (event.type === "done") return;
						}
						if (retryRoute) continue;
						if (emitted) {
							markFailure(groupId, route, routeIndex);
							notify(ctx, `Model-group route failed: ${key}. Pi will retry another route.`, "warning");
							output.push(createError(virtualModel, `HTTP 503: model-group route failed (${key}): stream ended without a final response`));
							return;
						}
						markFailure(groupId, route, routeIndex);
					} catch (error) {
						if (!ownsContext(ctx)) return;
						const message = error instanceof Error ? error.message : String(error);
						if (options?.signal?.aborted) {
							output.push(createError(virtualModel, "Request cancelled", true));
							return;
						}
						markFailure(groupId, route, routeIndex);
						if (emitted) {
							notify(ctx, `Model-group route failed: ${key}. Pi will retry another route.`, "warning");
							output.push(createError(virtualModel, `HTTP 503: model-group route failed (${key}): ${message}`));
							return;
						}
					} finally {
						const remaining = Math.max(0, (shared.activeRoutes.get(key) ?? 1) - 1);
						if (remaining === 0) shared.activeRoutes.delete(key);
						else shared.activeRoutes.set(key, remaining);
					}
				}
			} catch (error) {
				// The owning session was disposed or replaced while this stream
				// was pending. Its old output must simply stop; surfacing a stale-ctx
				// exception turns a normal reload into a failed user task.
				if (ctx !== undefined && !ownsContext(ctx)) return;
				const message = error instanceof Error ? error.message : String(error);
				output.push(createError(virtualModel, `Model-group stream interrupted: ${message}`));
			} finally {
				output.end();
			}
		})();
		return output;
	};

	rt.stream = streamGroup;

	const registerProvider = () => {
		pi.registerProvider(PROVIDER_ID, {
			name: "Model Groups",
			baseUrl: "https://model-groups.invalid",
			apiKey: "model-groups-router",
			api: "model-groups-router-api",
			models: Object.entries(rt.config.groups).map(([id, group]) => ({
				id,
				name: group.name,
				reasoning: group.reasoning,
				input: group.input,
				contextWindow: group.contextWindow,
				maxTokens: group.maxTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				...(group.thinkingLevelMap ? { thinkingLevelMap: group.thinkingLevelMap } : {}),
			})),
			// 分发器本身不持有会话状态:通过 ownerSessionId 精确定位归属会话,
			// 再调用该会话自己的 stream 实现。所有会话注册的是同一个行为,
			// 因此"最后注册者胜"不会串会话。
			streamSimple: (model, context, options) => {
				const target = resolveRuntime(options?.ownerSessionId, options?.sessionId, model.id);
				if (target === undefined || target.stream === undefined) return errorStream(model, "Model group request has no owning session");
				return target.stream(model, context, options);
			},
		});
	};

	registerProvider();

	pi.on("session_start", (_event, ctx) => {
		rt.sessionId = ctx.sessionManager.getSessionId();
		shared.runtimes.set(rt.sessionId, rt);
		rt.ctx = ctx;
		rt.runtimeActive = true;
		rt.continuationQueued = false;
		rt.taskActive = false;
		restore(ctx);
		updateStatus(ctx);
	});

	pi.on("model_select", (event) => {
		if (event.model.provider !== PROVIDER_ID) {
			// 切到非组模型:清除组状态与状态栏,避免残留误导。
			if (rt.state.groupId !== undefined || rt.state.taskRouteIndex !== undefined) {
				rt.state.groupId = undefined;
				rt.state.taskRouteIndex = undefined;
				rt.groupRestartAt = undefined;
				persist();
			}
			updateStatus();
			return;
		}
		rt.state.groupId = event.model.id;
		rt.state.taskRouteIndex = undefined;
		rt.groupRestartAt = undefined;
		persist();
		updateStatus();
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		if (rt.groupRestartAt !== undefined && Date.now() < rt.groupRestartAt) return;
		const groupId = ctx.model.id;
		if (rt.state.groupId !== groupId || rt.state.taskRouteIndex === undefined) {
			selectGroupRoute(groupId, false, ctx);
		}
	});

	pi.on("agent_start", () => {
		rt.continuationQueued = false;
		rt.taskActive = true;
		rt.agentEnded = false;
	});

	pi.on("agent_end", () => {
		rt.agentEnded = true;
	});

	// A settled run is the end of a task. The next user task starts again at the
	// first route, while a compaction continuation sets a fresh route.
	pi.on("agent_settled", (_event, ctx) => {
		rt.taskActive = false;
		rt.groupRestartAt = undefined;
		if (ctx.model?.provider !== PROVIDER_ID || rt.compactionInProgress) return;
		rt.state.taskRouteIndex = undefined;
		persist();
		updateStatus(ctx);
	});

	pi.on("session_before_compact", (event) => {
		// Pi checks threshold compaction both after agent_end and immediately
		// before a new prompt. Suppress only the former: after a completed task
		// there is no continuation to make, while pre-prompt compaction still
		// protects the next task from an already-full context. Applies to every
		// model, because the extension threshold is capped at Pi's native one
		// and has therefore already compacted mid-task whenever Pi would.
		//
		// A subagent cannot use the abort-and-continue compaction below: the abort
		// makes Pi emit agent_settled(aborted), and pi-subagent ends the child on
		// that event, so the continuation never runs and the delegated task fails
		// with "This operation was aborted". Let Pi compact in-run between turns
		// instead (no abort, no settle); skip only the one after the final answer.
		if (isSubagentProcess()) {
			if (event.reason === "threshold" && rt.agentEnded) return { cancel: true };
			return;
		}
		if (event.reason === "threshold" && rt.taskActive) return { cancel: true };
	});

	// turn_start is emitted only when Pi is about to make another LLM request
	// (after the previous tool turn). Check here so compaction happens while a
	// task is still active, but never after a terminal answer or terminating tool.
	// Applies to every model, not only the model groups.
	pi.on("turn_start", (event, ctx) => {
		// turnIndex 0 is the first request of a user task. Only later turns
		// prove that the task is still in progress; otherwise a new task would
		// restore the last user message after compaction.
		if (event.turnIndex === 0) return;
		// Subagents rely on Pi's in-run compaction; see session_before_compact.
		if (isSubagentProcess()) return;
		if (rt.compactionInProgress || rt.continuationQueued) return;
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens === null || tokens === undefined || tokens < thresholdTokens(ctx)) return;
		startCompaction(ctx, tokens);
	});

	pi.registerCommand("model-group", {
		description: "List, inspect, reset, or reload model groups",
		handler: async (args, ctx) => {
			const [action = "status", groupId] = args.trim().split(/\s+/, 2);
			if (action === "reload") {
				try {
					const nextConfig = readConfig(configPath);
					shared.config = nextConfig;
					shared.configPath = configPath;
					for (const runtime of shared.runtimes.values()) runtime.config = nextConfig;
					rt.config = nextConfig;
					pi.unregisterProvider(PROVIDER_ID);
					registerProvider();
					notify(ctx, `Reloaded ${Object.keys(rt.config.groups).length} model groups.`);
				} catch (error) {
					notify(ctx, `Could not reload model groups: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (action === "reset") {
				const target = groupId || undefined;
				if (target && !rt.config.groups[target]) {
					return notify(ctx, `Unknown model group '${target}'.`, "warning");
				}
				let sessions = 0;
				for (const runtime of shared.runtimes.values()) {
					if (!runtime.runtimeActive) continue;
					if (target && runtime.state.groupId !== target) continue;
					if (runtime.state.taskRouteIndex === undefined && runtime.pendingSwitchFrom === undefined && runtime.groupRestartAt === undefined) continue;
					runtime.state.taskRouteIndex = undefined;
					runtime.pendingSwitchFrom = undefined;
					runtime.groupRestartAt = undefined;
					try {
						runtime.pi.appendEntry(STATE_ENTRY_TYPE, { version: 1, ...runtime.state } satisfies PersistedState);
					} catch {
						// Stale session ctx after dispose; skip persist.
					}
					try {
						const ui = runtime.ctx;
						if (ui?.hasUI) ui.ui.setStatus(STATUS_KEY, undefined);
					} catch {
						// Status display is best-effort.
					}
					sessions += 1;
				}
				const scope = target ? `model group '${target}'` : "all model groups";
				return notify(ctx, `Reset task routes for ${scope}${sessions > 0 ? ` and ${sessions} open session${sessions === 1 ? "" : "s"}` : ""}.`);
			}
			if (action === "list") {
				const lines = Object.entries(rt.config.groups).map(([id, group]) => `${PROVIDER_ID}/${id} — ${group.name} (${group.routes.length} routes)`);
				return notify(ctx, `Model groups:\n${lines.join("\n")}`);
			}
			const target = groupId || rt.state.groupId || (ctx.model?.provider === PROVIDER_ID ? ctx.model.id : undefined);
			if (!target || !rt.config.groups[target]) return notify(ctx, "No active model group. Select one with /model.", "warning");
			const group = rt.config.groups[target];
			const lines = group.routes.map((route, index) => {
				const active = rt.state.taskRouteIndex === index ? "active" : "available";
				return `${index + 1}. ${routeKey(route)} — ${active}`;
			});
			notify(ctx, `Model group: ${target}\n${lines.join("\n")}`);
		},
	});

	pi.on("session_shutdown", () => {
		try {
			rt.ctx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// 会话关闭时状态栏清理失败可忽略。
		}
		rt.runtimeActive = false;
		rt.taskActive = false;
		rt.pendingLastUser = undefined;
		clearCompactionRetry();
		rt.ctx = undefined;
		if (rt.sessionId !== undefined) shared.runtimes.delete(rt.sessionId);
	});
}
