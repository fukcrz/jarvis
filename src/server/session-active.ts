import type { AgentSession, AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ComposerCommand,
  ErrorTimelineItem,
  MessageTimelineItem,
  SessionAttentionState,
  SessionQueue,
  SessionRef,
  SessionStatus,
  ThinkingTimelineItem,
  ToolTimelineItem,
} from "../shared/protocol.js";
import type { ExtensionUiBridge } from "./extension-ui.js";

export interface ActiveRun {
  id: string;
  startedAt: string;
  kind: "llm" | "bash" | "compaction" | "reload";
}

/** 所有运行类请求的幂等缓存值。 */
export type RunAccepted = { accepted: true; runId?: string; queued?: boolean; behavior?: "steer" | "followUp" };
export type PiEvent<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;

export interface ActiveSession {
  ref: SessionRef;
  cwd: string;
  session: AgentSession;
  modelRuntime: ModelRuntime;
  modelSwitching: boolean;
  unsubscribe: () => void;
  state: SessionStatus;
  attentionState: SessionAttentionState;
  attentionAt?: string;
  lastUserMessageAt?: string;
  starred?: boolean;
  /** Side chat: read-only tools, hidden from the session list, tied to a parent session. */
  readOnly?: boolean;
  requestRuns: Map<string, RunAccepted>;
  liveMessages: Map<string, MessageTimelineItem>;
  /** Retry attempts which have not yet been reconciled with persisted history. */
  liveErrors: Map<string, ErrorTimelineItem>;
  /** Stable identity shared by thinking/text/message_end for one assistant response. */
  assistantStreamId?: string;
  partial?: MessageTimelineItem;
  /** 当前 run 正在流式的思考块（message_end 定稿前）。 */
  partialThinking?: ThinkingTimelineItem;
  /** 排队等待投递的用户消息镜像（来自 Pi 的 queue_update 事件）。 */
  queue: SessionQueue;
  /** clearQueue+重入队期间暂停镜像同步，避免发布中间态。 */
  queueSyncSuspended: boolean;
  activeTools: Map<string, ToolTimelineItem>;
  /** 正在执行的用户 !cmd 命令（流式输出尚未落盘）。 */
  activeBash?: ToolTimelineItem;
  /** Retains a stop click that arrives before Pi installs its compaction abort controller. */
  compactionAbortRequested: boolean;
  extensionFailure?: { code: string; message: string };
  /** 扩展 ctx.ui 请求桥（对话框待浏览器响应）。 */
  extensionUi: ExtensionUiBridge;
  /** Extension startup must finish before callers can use or replace this session. */
  extensionReady: Promise<void>;
  /** Error from the last assistant message; applied at agent_settled once Pi's retries/compaction finish. */
  pendingRunError?: { code: string; message: string };
  /** A deferred settle lets extension-triggered compaction claim the active run. */
  settlementTimer?: ReturnType<typeof setTimeout>;
  /** The current compaction took over immediately after an agent_settled handoff. */
  compactionHandoff: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 通过 SDK 的 `appendSystemPrompt` 注入到系统提示词的 Jarvis UI 说明。
 * 常驻基础提示词之后（`<project_context>` 之前），告知 AI 当前运行环境。
 */
export const JARVIS_UI_NOTICE = [
  "You are running inside Jarvis, a local web UI for persistent Pi sessions, not the Pi TUI. The user reads your reply as rendered Markdown in a timeline and does not see raw tool output.",
  "Your reply is rendered as GitHub-flavored Markdown: headings, tables, task lists, links, fenced code with syntax highlighting, and ```mermaid blocks rendered as real diagrams. Prefer mermaid for flows, sequences, state machines, class and ER diagrams, and hierarchical mind maps instead of ASCII art, and keep each diagram small enough to read (label the nodes, no decorative churn). When a tree-shaped overview would help the user see structure at a glance, draw a mermaid `mindmap` (indentation is hierarchy). Unquoted `()`, `[]`, or `{{}}` in mindmap labels are shape markers — quote the node text if those characters belong in the words.",
  "Images: embed them with standard Markdown image syntax. ![](relative/path.png) resolves against the current workspace root; ![](/absolute/path.png) and ![](file:///absolute/path.png) resolve against the machine filesystem, so artifacts outside the workspace are fine too. Video and audio use the same syntax and render as inline players (![](clip.mp4), ![](voice.mp3), plus http(s) and data: URLs), so never hand over a bare path or a download link for media either. Other local files linked as [name](relative/path.pdf) open in a preview or download. Jarvis serves these through its /api/files endpoint and renders them inline, so the user sees them directly.",
  "Show, do not describe. Whenever a task produces or inspects visual output — a screenshot or browser render, a rendered UI, a chart, a diagram, a before/after comparison, a video or audio clip, image or PDF processing, generated graphics, or any question about what something looks like — put ![](path) in the reply. If you already saved an image or a clip, attach it: never answer with a bare file path for media the user asked to see. After visual verification, the image is the evidence; a description alone is not enough.",
  "Keep it useful: one short caption plus the image beats paragraphs of description, and skip images when they carry no information (for example, a text-only code change).",
].join(" ");

export const SIDE_CHAT_NOTICE = "This is a read-only side chat next to the main Jarvis session. You may inspect project files with read, grep, find, and ls. Do not modify files, run commands, or change the workspace.";
export const SIDE_CHAT_TOOLS = ["read", "grep", "find", "ls"] as const;

export const PAGE_LIMIT = 120;
export const MAX_PROMPT_LENGTH = 40_000;
export const MAX_ATTACHMENT_DATA_LENGTH = 14_000_000; // ≈ 10 MiB decoded
export const MAX_BASH_OUTPUT_CHARS = 100_000; // 流式气泡的最大输出长度，落盘结果由 Pi 自行截断
export const PI_ABORT_TIMEOUT_MS = 8_000;
export const SETTLEMENT_RETRY_INTERVAL_MS = 100;
export const SETTLEMENT_MAX_WAIT_MS = 10_000;
export const FORK_SNAPSHOT_RETRIES = 4;
export const FORK_SNAPSHOT_RETRY_DELAY_MS = 50;
export const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);
export const JARVIS_COMPACT_COMMAND: ComposerCommand = {
  name: "compact",
  description: "压缩当前会话上下文",
  source: "jarvis",
};

/** 重载 AGENTS.md / 插件 / 技能 / 提示词等资源（对齐 Pi TUI 的 /reload）。 */
export const JARVIS_RELOAD_COMMAND: ComposerCommand = {
  name: "reload",
  description: "重新加载 AGENTS.md / 插件 / 技能 / 提示词",
  source: "jarvis",
};
