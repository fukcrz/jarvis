import type {
  ApiErrorBody,
  ModelDescriptor,
  PromptAccepted,
  SessionRef,
  SessionStreamSnapshot,
  SessionSummary,
  TimelinePage,
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
  listWorkspaces: async (): Promise<Workspace[]> => (await request<{ workspaces: Workspace[] }>("/api/workspaces")).workspaces,
  addWorkspace: async (cwd: string, label?: string): Promise<Workspace> => (await request<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: JSON.stringify({ cwd, ...(label === undefined ? {} : { label }) }) })).workspace,
  removeWorkspace: async (workspaceId: string): Promise<void> => { await request(`/api/workspaces/${workspaceId}`, { method: "DELETE" }); },
  listSessions: async (workspaceId: string, query?: string): Promise<SessionSummary[]> => {
    const params = new URLSearchParams();
    if (query?.trim()) params.set("query", query.trim());
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return (await request<{ sessions: SessionSummary[] }>(`/api/workspaces/${workspaceId}/sessions${suffix}`)).sessions;
  },
  createSession: async (workspaceId: string): Promise<SessionSummary> => (await request<{ session: SessionSummary }>(`/api/workspaces/${workspaceId}/sessions`, { method: "POST", body: "{}" })).session,
  renameSession: async (ref: SessionRef, name: string): Promise<SessionSummary> => (await request<{ session: SessionSummary }>(sessionPath(ref), { method: "PATCH", body: JSON.stringify({ name }) })).session,
  timeline: async (ref: SessionRef, before?: number): Promise<TimelinePage> => {
    const query = before === undefined ? "" : `?before=${String(before)}`;
    return request(`${sessionPath(ref)}/timeline${query}`);
  },
  runtime: async (ref: SessionRef): Promise<SessionStreamSnapshot> => request(`${sessionPath(ref)}/runtime`),
  setModel: async (ref: SessionRef, model: Pick<ModelDescriptor, "provider" | "id">): Promise<ModelDescriptor> => (await request<{ model: ModelDescriptor }>(`${sessionPath(ref)}/model`, { method: "PUT", body: JSON.stringify({ provider: model.provider, modelId: model.id }) })).model,
  prompt: async (ref: SessionRef, text: string, clientRequestId: string): Promise<PromptAccepted> => request(`${sessionPath(ref)}/prompt`, { method: "POST", body: JSON.stringify({ text, clientRequestId }) }),
  abort: async (ref: SessionRef, runId?: string): Promise<void> => { await request(`${sessionPath(ref)}/abort`, { method: "POST", body: JSON.stringify(runId === undefined ? {} : { runId }) }); },
};

export function sessionPath(ref: SessionRef): string {
  return `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}`;
}

export function socketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
