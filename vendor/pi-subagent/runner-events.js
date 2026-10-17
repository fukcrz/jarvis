/**
 * Helpers for parsing Pi RPC events and summarizing subagent results.
 */

import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const MAX_CAPTURED_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_DEDUP_SIGNATURES = 8192;
const TRUNCATION_MARKER = "\n\n[Subagent response truncated during capture]";

function getSeenMessageSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures;
}

function serializeMessage(message) {
  try {
    const serialized = JSON.stringify(message);
    return {
      bytes: Buffer.byteLength(serialized, "utf8"),
      signature: createHash("sha256").update(serialized).digest("hex"),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function getCapturedMessageState(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__capturedMessageState")) {
    Object.defineProperty(result, "__capturedMessageState", {
      value: { sizes: [], totalBytes: 0 },
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__capturedMessageState;
}

function rememberSignature(seen, signature) {
  while (seen.size >= MAX_DEDUP_SIGNATURES) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  seen.add(signature);
}

function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.model && message.model) result.model = message.model;
  if (result.processError) return;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

function compactOversizedAssistantMessage(message) {
  const text = getTextContent(message.content);
  if (!text) return null;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const compactText =
    Buffer.byteLength(text, "utf8") > MAX_CAPTURED_MESSAGE_BYTES - markerBytes - 1024
      ? `${truncateUtf8(text, MAX_CAPTURED_MESSAGE_BYTES - markerBytes - 1024)}${TRUNCATION_MARKER}`
      : text;
  return {
    role: "assistant",
    content: [{ type: "text", text: compactText }],
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    timestamp: message.timestamp,
    usage: message.usage,
  };
}

function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  updateAssistantMetadata(result, message);

  let capturedMessage = message;
  let serialized = serializeMessage(capturedMessage);
  if (serialized.error) {
    result.captureTruncated = true;
    result.processError = true;
    result.stopReason = "error";
    result.errorMessage = `Could not safely capture a subagent message: ${serialized.error}`;
    return false;
  }
  if (serialized.bytes > MAX_CAPTURED_MESSAGE_BYTES) {
    result.captureTruncated = true;
    capturedMessage = compactOversizedAssistantMessage(message);
    if (!capturedMessage) return false;
    serialized = serializeMessage(capturedMessage);
    if (serialized.error) {
      result.processError = true;
      result.stopReason = "error";
      result.errorMessage = `Could not safely capture a subagent message: ${serialized.error}`;
      return false;
    }
  }
  const { signature, bytes } = serialized;
  const seen = getSeenMessageSignatures(result);
  if (seen.has(signature)) return false;

  const capture = getCapturedMessageState(result);
  while (
    result.messages.length > 0 &&
    capture.totalBytes + bytes > MAX_CAPTURED_MESSAGE_BYTES
  ) {
    result.messages.shift();
    capture.totalBytes -= capture.sizes.shift() ?? 0;
    result.captureTruncated = true;
  }
  if (bytes > MAX_CAPTURED_MESSAGE_BYTES) {
    result.captureTruncated = true;
    return false;
  }

  rememberSignature(seen, signature);
  result.messages.push(capturedMessage);
  capture.sizes.push(bytes);
  capture.totalBytes += bytes;

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }

  return true;
}

function addAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addAssistantMessage(result, message)) changed = true;
  }
  return changed;
}

function getTextContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function addToolError(result, event) {
  if (!event?.isError) return;
  const text = getTextContent(event.result?.content);
  if (!text) return;
  result.pendingToolError = text;
}

export function hasAttributedToolError(result) {
  if (result?.stopReason !== "error") return false;
  const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage.trim() : "";
  const pendingToolError =
    typeof result.pendingToolError === "string" ? result.pendingToolError.trim() : "";
  return Boolean(errorMessage && pendingToolError && pendingToolError === errorMessage);
}

export function processPiEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "agent_start":
      result.sawAgentStart = true;
      return false;

    case "message_end":
      if (event.message?.role === "assistant") result.pendingToolError = undefined;
      return addAssistantMessage(result, event.message);

    case "turn_end":
      if (event.message?.role === "assistant") result.pendingToolError = undefined;
      return addAssistantMessage(result, event.message);

    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);

    case "tool_execution_end":
      addToolError(result, event);
      return false;

    case "agent_settled":
      result.sawAgentSettled = true;
      return false;

    case "response":
      if (event.command === "prompt" && event.success === true) {
        result.rpcPromptAccepted = true;
      } else if (
        event.command === "get_state" &&
        event.id === "pi-subagent-prompt-state" &&
        event.success === true &&
        event.data?.isStreaming === false
      ) {
        result.rpcPromptIdle = true;
      } else if (event.success === false) {
        if (!result.processError) {
          const message = typeof event.error === "string" ? event.error : "Subagent RPC prompt failed.";
          result.processError = true;
          result.stopReason = "error";
          result.errorMessage = message;
        }
        result.sawAgentSettled = true;
      }
      return false;

    default:
      return false;
  }
}

export function processPiJsonLine(line, result) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processPiEvent(event, result);
}

export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const text = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .filter((partText) => partText.length > 0)
      .join("");
    if (text) return text;
  }

  return "";
}

export function getProcessErrorText(result) {
  if (!result?.processError) return "";

  const message =
    typeof result.errorMessage === "string" && result.errorMessage.trim()
      ? result.errorMessage.trim()
      : typeof result.stderr === "string" && result.stderr.trim()
        ? result.stderr.trim()
        : "Subagent process failed after completion.";

  return `Subagent process error after completion: ${message}`;
}

export function getResultSummaryText(result) {
  const finalText = getFinalAssistantText(result?.messages);
  if (!finalText && result?.handledWithoutAgent) {
    return "Subagent prompt was handled without an agent response.";
  }
  const processErrorText = getProcessErrorText(result);
  const terminalErrorText =
    !processErrorText &&
    (result?.stopReason === "error" || result?.stopReason === "aborted") &&
    !hasAttributedToolError(result) &&
    typeof result?.errorMessage === "string" &&
    result.errorMessage.trim()
      ? `Subagent ${result.stopReason}: ${result.errorMessage.trim()}`
      : "";
  const errorText = processErrorText || terminalErrorText;
  const captureText = result?.captureTruncated
    ? "[Earlier or oversized subagent messages were omitted at the capture limit.]"
    : "";
  const suffix = [errorText, captureText].filter(Boolean).join("\n\n");
  if (finalText && suffix) return `${finalText}\n\n${suffix}`;
  if (finalText) return finalText;
  if (suffix) return suffix;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError && typeof result?.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }

  return "(no output)";
}

/** ctx.compact() aborts the run before compaction_start. These are that abort, not a finished task. */
const COMPACTION_ABORT_MESSAGES = new Set([
  "This operation was aborted",
  "Operation aborted",
  "Compacting context before continuing",
]);

export function isCompactionAbortResult(result) {
  const message = typeof result?.errorMessage === "string" ? result.errorMessage.trim() : "";
  return COMPACTION_ABORT_MESSAGES.has(message);
}

/**
 * Decide whether an RPC event should keep a child alive across manual compaction.
 *
 * Native in-loop compaction emits compaction_start without a preceding abort settle.
 * Those events stay in "idle" and must not delay a normal exit. The aborting compact
 * path is: aborted assistant message, agent_settled, compaction_start, compaction_end,
 * then a continuation agent_start.
 *
 * @returns {{ phase: string, action: "none" | "finish" | "arm-grace" | "hold" | "resume" }}
 */
export function reduceCompactionHandoff(phase, event, result) {
  const current = phase || "idle";
  if (!event || typeof event !== "object") return { phase: current, action: "none" };

  if (event.type === "compaction_start") {
    if (current === "idle") return { phase: current, action: "none" };
    return { phase: "compacting", action: "hold" };
  }

  if (event.type === "compaction_end") {
    if (current !== "compacting") return { phase: current, action: "none" };
    if (event.aborted) return { phase: "grace", action: "arm-grace" };
    if (event.result == null) return { phase: "grace", action: "hold" };
    return { phase: "awaitingContinuation", action: "arm-grace" };
  }

  if (event.type === "agent_start") {
    if (current === "idle") return { phase: current, action: "none" };
    return { phase: "idle", action: "resume" };
  }

  if (event.type === "agent_settled") {
    if (current !== "idle") return { phase: current, action: "hold" };
    if (isCompactionAbortResult(result)) return { phase: "grace", action: "arm-grace" };
    return { phase: "idle", action: "finish" };
  }

  return { phase: current, action: "none" };
}
