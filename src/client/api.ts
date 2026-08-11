import type {
  ApiErrorBody,
  BashAccepted,
  CompactAccepted,
  ComposerCommand,
  DirectoryListing,
  ImageAttachment,
  ModelDescriptor,
  PromptAccepted,
  SessionRef,
  SessionStreamSnapshot,
  SessionSummary,
  SessionThinkingSnapshot,
  ThinkingLevel,
  TimelinePage,
  WorkspaceFile,
  Workspace,
} from "../shared/protocol";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && options.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as ApiErrorBody | undefined;
    throw new ApiError(body?.error.code ?? "REQUEST_FAILED", body?.error.message ?? `Request failed (${String(response.status)})`, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  directory: async (path?: string, roots = false): Promise<DirectoryListing> => {
    const params = new URLSearchParams();
    if (path !== undefined) params.set("path", path);
    if (roots) params.set("roots", "true");
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    return (await request<{ directory: DirectoryListing }>(`/api/directories${query}`)).directory;
  },
  listWorkspaces: async (): Promise<Workspace[]> => (await request<{ workspaces: Workspace[] }>("/api/workspaces")).workspaces,
  addWorkspace: async (cwd: string, label?: string): Promise<Workspace> => (await request<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: JSON.stringify({ cwd, ...(label === undefined ? {} : { label }) }) })).workspace,
  renameWorkspace: async (workspaceId: string, label: string): Promise<Workspace> => (await request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`, { method: "PATCH", body: JSON.stringify({ label }) })).workspace,
  openWorkspace: async (workspaceId: string): Promise<Workspace> => (await request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}/open`, { method: "POST", body: "{}" })).workspace,
  removeWorkspace: async (workspaceId: string): Promise<void> => { await request(`/api/workspaces/${workspaceId}`, { method: "DELETE" }); },
  listSessions: async (workspaceId: string, query?: string): Promise<SessionSummary[]> => {
    const params = new URLSearchParams();
    if (query?.trim()) params.set("query", query.trim());
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return (await request<{ sessions: SessionSummary[] }>(`/api/workspaces/${workspaceId}/sessions${suffix}`)).sessions;
  },
  searchFiles: async (workspaceId: string, query?: string): Promise<WorkspaceFile[]> => {
    const params = new URLSearchParams();
    if (query?.trim()) params.set("query", query.trim());
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return (await request<{ files: WorkspaceFile[] }>(`/api/workspaces/${workspaceId}/files${suffix}`)).files;
  },
  commands: async (ref: SessionRef): Promise<ComposerCommand[]> => (await request<{ commands: ComposerCommand[] }>(`${sessionPath(ref)}/commands`)).commands,
  createSession: async (workspaceId: string): Promise<SessionSummary> => (await request<{ session: SessionSummary }>(`/api/workspaces/${workspaceId}/sessions`, { method: "POST", body: "{}" })).session,
  removeSession: async (ref: SessionRef): Promise<void> => { await request(sessionPath(ref), { method: "DELETE" }); },
  renameSession: async (ref: SessionRef, name: string): Promise<SessionSummary> => (await request<{ session: SessionSummary }>(sessionPath(ref), { method: "PATCH", body: JSON.stringify({ name }) })).session,
  timeline: async (ref: SessionRef, before?: number): Promise<TimelinePage> => {
    const query = before === undefined ? "" : `?before=${String(before)}`;
    return request(`${sessionPath(ref)}/timeline${query}`);
  },
  runtime: async (ref: SessionRef): Promise<SessionStreamSnapshot> => request(`${sessionPath(ref)}/runtime`),
  setModel: async (ref: SessionRef, model: Pick<ModelDescriptor, "provider" | "id">): Promise<ModelDescriptor> => (await request<{ model: ModelDescriptor }>(`${sessionPath(ref)}/model`, { method: "PUT", body: JSON.stringify({ provider: model.provider, modelId: model.id }) })).model,
  setThinkingLevel: async (ref: SessionRef, level: ThinkingLevel): Promise<SessionThinkingSnapshot> => (await request<{ thinking: SessionThinkingSnapshot }>(`${sessionPath(ref)}/thinking`, { method: "PUT", body: JSON.stringify({ level }) })).thinking,
  prompt: async (ref: SessionRef, text: string, clientRequestId: string, images?: ImageAttachment[]): Promise<PromptAccepted> => request(`${sessionPath(ref)}/prompt`, {
    method: "POST",
    body: JSON.stringify({
      text,
      clientRequestId,
      ...(images === undefined || images.length === 0 ? {} : { images }),
    }),
  }),
  compact: async (ref: SessionRef, customInstructions?: string, clientRequestId?: string): Promise<CompactAccepted> => request(`${sessionPath(ref)}/compact`, {
    method: "POST",
    body: JSON.stringify({
      ...(customInstructions === undefined ? {} : { customInstructions }),
      ...(clientRequestId === undefined ? {} : { clientRequestId }),
    }),
  }),
  bash: async (ref: SessionRef, command: string, excludeFromContext: boolean, clientRequestId: string): Promise<BashAccepted> => request(`${sessionPath(ref)}/bash`, {
    method: "POST",
    body: JSON.stringify({ command, excludeFromContext, clientRequestId }),
  }),
  abort: async (ref: SessionRef, runId?: string): Promise<void> => { await request(`${sessionPath(ref)}/abort`, { method: "POST", body: JSON.stringify(runId === undefined ? {} : { runId }) }); },
};

export function sessionPath(ref: SessionRef): string {
  return `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}`;
}

export function socketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
