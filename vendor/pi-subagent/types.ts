/**
 * Shared type definitions for the subagent extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import { getFinalAssistantText, hasAttributedToolError } from "./runner-events.js";

/** Supported per-call thinking overrides. */
export const CALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type CallThinkingLevel = (typeof CALL_THINKING_LEVELS)[number];

/** Initial context for a newly-created subagent conversation. */
export type InitialContext = "empty" | "parent";

/** Default initial context for delegated calls. */
export const DEFAULT_INITIAL_CONTEXT: InitialContext = "empty";

/** Metadata for a named persistent subagent session. */
export interface SubagentSessionDetails {
	handle: string;
	id: string;
	name: string;
	cwd: string;
	created: boolean;
	initialContextApplied: InitialContext | null;
}

/** Aggregated token usage from a subagent run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent call. */
export interface SingleResult {
	callIndex?: number;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	prompt: string;
	initialContext: InitialContext;
	session?: SubagentSessionDetails;
	exitCode: number;
	messages: Message[];
	stderr: string;
	stderrTruncated?: boolean;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentStart?: boolean;
	sawAgentEnd?: boolean;
	sawAgentSettled?: boolean;
	rpcPromptAccepted?: boolean;
	rpcPromptIdle?: boolean;
	handledWithoutAgent?: boolean;
	/** Immediately pending failed-tool text for terminal-status attribution. */
	pendingToolError?: string;
	/** Older or oversized assistant messages were omitted to bound memory. */
	captureTruncated?: boolean;
	/** Process-level failures that should not be normalized away by semantic assistant completion. */
	processError?: boolean;
}

/** Metadata attached to every tool result for rendering and result middleware. */
export interface SubagentDetails {
	kind: "pi-subagent";
	projectAgentsDir: string | null;
	results: SingleResult[];
	failed?: true;
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/** Whether the child emitted a final assistant text response. */
export function hasFinalAssistantOutput(r: Pick<SingleResult, "messages">): boolean {
	return getFinalAssistantText(r.messages).trim().length > 0;
}

/** Whether the child semantically completed the run successfully. */
export function hasSemanticCompletion(
	r: Pick<
		SingleResult,
		"messages" | "sawAgentEnd" | "stopReason" | "errorMessage" | "pendingToolError" | "handledWithoutAgent"
	>,
): boolean {
	if (r.handledWithoutAgent) return true;
	if (!r.sawAgentEnd || !hasFinalAssistantOutput(r)) return false;
	if (r.stopReason === "aborted") return false;
	if (r.stopReason === "error") return hasAttributedToolError(r);
	return true;
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	if (r.processError) return false;
	return hasSemanticCompletion(r);
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	return !isResultSuccess(r);
}

/** Reconcile process exit status with semantic completion observed from Pi's event stream. */
export function normalizeCompletedResult(result: SingleResult, wasAborted: boolean): SingleResult {
	const hasSemanticSuccess = hasSemanticCompletion(result);
	const completedBeforeAbort =
		result.sawAgentSettled &&
		(hasSemanticSuccess ||
			(result.stopReason === "aborted" && result.sawAgentEnd && hasFinalAssistantOutput(result)));
	if (wasAborted) {
		if (completedBeforeAbort && !result.processError) {
			result.exitCode = 0;
			if (result.stopReason === "aborted" || result.stopReason === "error") {
				result.stopReason = undefined;
			}
			if (
				result.errorMessage === "Subagent was aborted." ||
				result.errorMessage === result.stderr.trim()
			) {
				result.errorMessage = undefined;
			}
		} else if (result.processError) {
			if (result.exitCode <= 0) result.exitCode = 1;
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		} else {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted.";
			if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
		}
		return result;
	}

	if (result.exitCode === 0 && !hasSemanticSuccess) {
		result.exitCode = 1;
		if (!result.stopReason) result.stopReason = "error";
		if (!result.errorMessage) {
			result.errorMessage = result.sawAgentEnd
				? "Subagent completed without final assistant output."
				: "Subagent exited without completing an agent run.";
		}
		if (!result.stderr.trim()) result.stderr = result.errorMessage;
	}

	if (result.exitCode > 0) {
		if (hasSemanticSuccess && !result.processError) {
			result.exitCode = 0;
			if (result.stopReason === "error") result.stopReason = undefined;
			if (result.errorMessage === result.stderr.trim()) {
				result.errorMessage = undefined;
			}
		} else {
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		}
	}

	return result;
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
	return getFinalAssistantText(messages);
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}
	}
	return items;
}
