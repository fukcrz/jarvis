/**
 * 网页端问题上报：未捕获异常、接口失败、点击后状态没生效。
 * 只写服务端内存里的最近日志（`POST /api/system/client-log`），进诊断包，不重试、不影响界面。
 */
export const CLIENT_LOG_PATH = "/api/system/client-log";
export const CLIENT_ISSUE_MESSAGE_MAX = 2_000;
export const CLIENT_ISSUE_DETAIL_MAX = 4_000;
const REPORT_LIMIT_PER_PAGE = 40;
const DEDUPE_WINDOW_MS = 60_000;

export interface ClientIssue {
  kind: string;
  message: string;
  detail?: string;
}

export function normalizeClientIssue(kind: string, message: string, detail?: string): ClientIssue | undefined {
  const trimmedKind = kind.trim().slice(0, 64);
  const trimmedMessage = message.trim().slice(0, CLIENT_ISSUE_MESSAGE_MAX);
  if (trimmedKind === "" || trimmedMessage === "") return undefined;
  const trimmedDetail = detail?.trim().slice(0, CLIENT_ISSUE_DETAIL_MAX) ?? "";
  return { kind: trimmedKind, message: trimmedMessage, ...(trimmedDetail === "" ? {} : { detail: trimmedDetail }) };
}

/** 同一类问题一分钟一次、一分钟内最多 40 条：出问题时不刷爆日志，长时间运行也不会把配额用完。 */
export function createIssueThrottle(options: { now?: () => number; windowMs?: number; limit?: number } = {}): { accept: (issue: ClientIssue) => boolean } {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? DEDUPE_WINDOW_MS;
  const limit = options.limit ?? REPORT_LIMIT_PER_PAGE;
  const seen = new Map<string, number>();
  const recent: number[] = [];
  return {
    accept(issue) {
      const at = now();
      while (recent.length > 0 && at - (recent[0] ?? 0) >= windowMs) recent.shift();
      if (recent.length >= limit) return false;
      const key = `${issue.kind}:${issue.message}`;
      const last = seen.get(key);
      if (last !== undefined && at - last < windowMs) return false;
      if (seen.size >= 500) seen.clear();
      seen.set(key, at);
      recent.push(at);
      return true;
    },
  };
}

const throttle = createIssueThrottle();

export function reportClientIssue(kind: string, message: string, detail?: string): void {
  if (typeof fetch !== "function") return;
  const issue = normalizeClientIssue(kind, message, detail);
  if (issue === undefined || !throttle.accept(issue)) return;
  void fetch(CLIENT_LOG_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(issue),
    keepalive: true,
  }).catch(() => undefined);
}

/** 会话点击后的现场：用来判断「点了没选中」还是「选中了但列表里没有」。 */
export function selectionIssueDetail(input: {
  targetWorkspaceId: string;
  targetSessionId: string;
  selectedWorkspaceId?: string;
  selectedSessionId?: string;
  path: string;
  listedSessionIds?: readonly string[];
}): string {
  const listed = input.listedSessionIds === undefined ? "未加载" : String(input.listedSessionIds.length);
  return [
    `target=${input.targetWorkspaceId}:${input.targetSessionId}`,
    `selected=${input.selectedWorkspaceId ?? "-"}:${input.selectedSessionId ?? "-"}`,
    `path=${input.path}`,
    `listed=${listed}`,
    `inList=${input.listedSessionIds === undefined ? "未知" : input.listedSessionIds.includes(input.targetSessionId) ? "是" : "否"}`,
  ].join(" ");
}

function describeThrown(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 接住没被业务代码处理的异常，下次复现时诊断包里能看到。返回卸载函数。 */
export function installClientErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    const where = event.filename === "" ? "" : ` (${event.filename}:${String(event.lineno)}:${String(event.colno)})`;
    reportClientIssue("window-error", `${event.message}${where}`, describeThrown(event.error));
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportClientIssue("unhandled-rejection", describeThrown(event.reason));
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
