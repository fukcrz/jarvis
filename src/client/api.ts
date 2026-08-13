import type {
  BashAccepted,
  CompactAccepted,
  ComposerCommand,
  DirectoryListing,
  ImageAttachment,
  ModelDescriptor,
  PromptAccepted,
  QueuedMessage,
  QueuedPromptAccepted,
  SessionFileReference,
  SessionRef,
  SessionStreamSnapshot,
  SessionSummary,
  SessionThinkingSnapshot,
  ThinkingLevel,
  TimelinePage,
  WorkspaceFile,
  Workspace,
  AppSettings,
  AuthLoginOperation,
  ManagedProvider,
  ProviderStatus,
} from "../shared/protocol";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A state race the client can recover from by hydrating the latest session. */
export function isSessionConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && (error.code === "SESSION_BUSY" || error.code === "RUN_NOT_ACTIVE");
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && options.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as unknown;
    const error = apiErrorDetails(body);
    throw new ApiError(
      error.code ?? "REQUEST_FAILED",
      error.message ?? `Request failed (${String(response.status)})`,
      response.status,
      error.requestId,
    );
  }
  return response.json() as Promise<T>;
}

/** Accept the current API envelope and Fastify's legacy top-level error body. */
function apiErrorDetails(body: unknown): { code?: string; message?: string; requestId?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const value = body as Record<string, unknown>;
  const nested = value["error"];
  const source = typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : value;
  return {
    ...(typeof source["code"] === "string" ? { code: source["code"] } : {}),
    ...(typeof source["message"] === "string" ? { message: source["message"] } : {}),
    ...(typeof source["requestId"] === "string" ? { requestId: source["requestId"] } : {}),
  };
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
  reorderWorkspaces: async (ids: string[]): Promise<Workspace[]> => (await request<{ workspaces: Workspace[] }>("/api/workspaces/order", { method: "PUT", body: JSON.stringify({ ids }) })).workspaces,
  settings: async (): Promise<AppSettings> => (await request<{ settings: AppSettings }>("/api/settings")).settings,
  updateSettings: async (assistantName: string): Promise<AppSettings> => (await request<{ settings: AppSettings }>("/api/settings", { method: "PATCH", body: JSON.stringify({ assistantName }) })).settings,
  providers: async (): Promise<ProviderStatus[]> => (await request<{ providers: ProviderStatus[] }>("/api/settings/providers")).providers,
  customProviders: async (): Promise<ManagedProvider[]> => (await request<{ providers: ManagedProvider[] }>("/api/settings/custom-providers")).providers,
  saveCustomProvider: async ({ id, ...provider }: ManagedProvider): Promise<ManagedProvider> => (await request<{ provider: ManagedProvider }>(`/api/settings/custom-providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(provider) })).provider,
  removeCustomProvider: async (providerId: string): Promise<void> => { await request(`/api/settings/custom-providers/${encodeURIComponent(providerId)}`, { method: "DELETE" }); },
  startLogin: async (providerId: string, type: "api_key" | "oauth"): Promise<AuthLoginOperation> => (await request<{ operation: AuthLoginOperation }>("/api/settings/auth/login", { method: "POST", body: JSON.stringify({ providerId, type }) })).operation,
  loginStatus: async (operationId: string): Promise<AuthLoginOperation> => (await request<{ operation: AuthLoginOperation }>(`/api/settings/auth/${operationId}`)).operation,
  respondLogin: async (operationId: string, value: string): Promise<AuthLoginOperation> => (await request<{ operation: AuthLoginOperation }>(`/api/settings/auth/${operationId}/respond`, { method: "POST", body: JSON.stringify({ value }) })).operation,
  cancelLogin: async (operationId: string): Promise<AuthLoginOperation> => (await request<{ operation: AuthLoginOperation }>(`/api/settings/auth/${operationId}/cancel`, { method: "POST", body: "{}" })).operation,
  logoutProvider: async (providerId: string): Promise<void> => { await request(`/api/settings/auth/${encodeURIComponent(providerId)}/logout`, { method: "POST", body: "{}" }); },
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
  searchSessionFiles: async (workspaceId: string, query?: string): Promise<SessionFileReference[]> => {
    const params = new URLSearchParams();
    if (query?.trim()) params.set("query", query.trim());
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return (await request<{ sessions: SessionFileReference[] }>(`/api/workspaces/${workspaceId}/session-files${suffix}`)).sessions;
  },
  commands: async (ref: SessionRef): Promise<ComposerCommand[]> => (await request<{ commands: ComposerCommand[] }>(`${sessionPath(ref)}/commands`)).commands,
  createSession: async (workspaceId: string): Promise<SessionSummary> => (await request<{ session: SessionSummary }>(`/api/workspaces/${workspaceId}/sessions`, { method: "POST", body: "{}" })).session,
  forkSession: async (ref: SessionRef, messageId: string): Promise<SessionSummary> => (await request<{ session: SessionSummary }>(`${sessionPath(ref)}/fork`, { method: "POST", body: JSON.stringify({ messageId }) })).session,
  removeSession: async (ref: SessionRef): Promise<void> => { await request(sessionPath(ref), { method: "DELETE" }); },
  renameSession: async (ref: SessionRef, name: string): Promise<SessionSummary> => (await request<{ session: SessionSummary }>(sessionPath(ref), { method: "PATCH", body: JSON.stringify({ name }) })).session,
  timeline: async (ref: SessionRef, before?: number): Promise<TimelinePage> => {
    const query = before === undefined ? "" : `?before=${String(before)}`;
    return request(`${sessionPath(ref)}/timeline${query}`);
  },
  runtime: async (ref: SessionRef): Promise<SessionStreamSnapshot> => request(`${sessionPath(ref)}/runtime`),
  setModel: async (ref: SessionRef, model: Pick<ModelDescriptor, "provider" | "id">): Promise<ModelDescriptor> => (await request<{ model: ModelDescriptor }>(`${sessionPath(ref)}/model`, { method: "PUT", body: JSON.stringify({ provider: model.provider, modelId: model.id }) })).model,
  setThinkingLevel: async (ref: SessionRef, level: ThinkingLevel): Promise<SessionThinkingSnapshot> => (await request<{ thinking: SessionThinkingSnapshot }>(`${sessionPath(ref)}/thinking`, { method: "PUT", body: JSON.stringify({ level }) })).thinking,
  prompt: async (ref: SessionRef, text: string, clientRequestId: string, images?: ImageAttachment[], behavior?: "steer" | "followUp"): Promise<PromptAccepted | QueuedPromptAccepted> => request(`${sessionPath(ref)}/prompt`, {
    method: "POST",
    body: JSON.stringify({
      text,
      clientRequestId,
      ...(images === undefined || images.length === 0 ? {} : { images }),
      ...(behavior === undefined ? {} : { behavior }),
    }),
  }),
  dequeueQueue: async (ref: SessionRef): Promise<{ steering: QueuedMessage[]; followUp: QueuedMessage[] }> => request(`${sessionPath(ref)}/queue/dequeue`, { method: "POST", body: "{}" }),
  removeQueued: async (ref: SessionRef, messageId: string): Promise<{ removed?: QueuedMessage }> => request(`${sessionPath(ref)}/queue/${encodeURIComponent(messageId)}`, { method: "DELETE" }),
  setQueuedKind: async (ref: SessionRef, messageId: string, kind: "steer" | "followUp"): Promise<{ updated?: QueuedMessage }> => request(`${sessionPath(ref)}/queue/${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify({ kind }) }),
  editAndResend: async (ref: SessionRef, messageId: string, text: string, clientRequestId: string, images?: ImageAttachment[]): Promise<PromptAccepted> => request(`${sessionPath(ref)}/edit-and-resend`, {
    method: "POST",
    body: JSON.stringify({ messageId, text, clientRequestId, ...(images === undefined || images.length === 0 ? {} : { images }) }),
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
  abort: async (ref: SessionRef, runId?: string): Promise<{ aborted: true; dequeued?: { steering: QueuedMessage[]; followUp: QueuedMessage[] } }> => request(`${sessionPath(ref)}/abort`, { method: "POST", body: JSON.stringify(runId === undefined ? {} : { runId }) }),
  respondExtensionUi: async (ref: SessionRef, id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }): Promise<void> => {
    await request(`${sessionPath(ref)}/extension-ui`, { method: "POST", body: JSON.stringify({ id, ...response }) });
  },
};

export function sessionPath(ref: SessionRef): string {
  return `/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}`;
}

export function socketUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
