import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, isSessionConflict } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client", () => {
  it("does not send a JSON content type for a request without a body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ removed: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.removeWorkspace("da69b38d-f132-4c84-8c4f-6174015e9c5e");

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("does not send a JSON content type when deleting a session", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ removed: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ref = { workspaceId: "da69b38d-f132-4c84-8c4f-6174015e9c5e", sessionId: "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0" };

    await api.removeSession(ref);

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}`);
    expect(init?.method).toBe("DELETE");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });

  it("sends workspace ids to the reorder endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ workspaces: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ids = ["da69b38d-f132-4c84-8c4f-6174015e9c5e", "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0"];

    await api.reorderWorkspaces(ids);

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/workspaces/order");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(JSON.stringify({ ids }));
  });

  it("uses the provider id in the URL instead of duplicating it in the save body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ provider: { id: "local" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      id: "local",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions" as const,
      authHeader: true,
      models: [{ id: "model", reasoning: false, vision: false }],
    };

    await api.saveCustomProvider(provider);

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/settings/custom-providers/local");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      baseUrl: provider.baseUrl,
      api: provider.api,
      authHeader: true,
      models: provider.models,
    });
  });

  it("sends a provider and model id to the session model endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: { provider: "provider", id: "model", name: "Model", reasoning: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ref = { workspaceId: "da69b38d-f132-4c84-8c4f-6174015e9c5e", sessionId: "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0" };

    await expect(api.setModel(ref, { provider: "provider", id: "model" })).resolves.toMatchObject({ name: "Model" });

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/model`);
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ provider: "provider", modelId: "model" }));
  });

  it("sends the selected thinking level to the session thinking endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ thinking: { current: "high", available: ["off", "low", "high"] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ref = { workspaceId: "da69b38d-f132-4c84-8c4f-6174015e9c5e", sessionId: "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0" };

    await expect(api.setThinkingLevel(ref, "high")).resolves.toMatchObject({ current: "high" });

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/thinking`);
    expect(init?.method).toBe("PUT");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ level: "high" }));
  });

  it("retains server request ids on API errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: "SESSION_BUSY", message: "This session is already running", requestId: "req-409" } }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const ref = { workspaceId: "da69b38d-f132-4c84-8c4f-6174015e9c5e", sessionId: "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0" };

    await expect(api.compact(ref)).rejects.toMatchObject({ name: "ApiError", code: "SESSION_BUSY", status: 409, requestId: "req-409" });
  });

  it("recognizes legacy Fastify error bodies as recoverable session conflicts", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ statusCode: 409, code: "SESSION_BUSY", error: "Conflict", message: "This session is already running" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const ref = { workspaceId: "da69b38d-f132-4c84-8c4f-6174015e9c5e", sessionId: "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0" };

    await expect(api.compact(ref)).rejects.toSatisfy((error: unknown) => isSessionConflict(error) && error.message === "This session is already running");
  });

  it("recognizes recoverable session state conflicts only", () => {
    expect(isSessionConflict(new ApiError("SESSION_BUSY", "busy", 409))).toBe(true);
    expect(isSessionConflict(new ApiError("RUN_NOT_ACTIVE", "settled", 409))).toBe(true);
    expect(isSessionConflict(new ApiError("MODEL_NOT_AVAILABLE", "conflict", 409))).toBe(false);
    expect(isSessionConflict(new ApiError("SESSION_BUSY", "busy", 500))).toBe(false);
  });

  it("sends Fork and edit-and-resend message operations to their session endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (path) => new Response(JSON.stringify(String(path).endsWith("/fork") ? { session: { id: "forked" } } : { accepted: true, runId: "run" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ref = { workspaceId: "da69b38d-f132-4c84-8c4f-6174015e9c5e", sessionId: "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0" };
    const requestId = "8b2a18fb-9b91-4b1d-9c15-d2c6caf8e99e";

    await api.forkSession(ref, "message:user:1");
    await api.editAndResend(ref, "message:user:1", "Edited", requestId, [{ mimeType: "image/png", data: "abc" }]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/fork`);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ messageId: "message:user:1" }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/edit-and-resend`);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ messageId: "message:user:1", text: "Edited", clientRequestId: requestId, images: [{ mimeType: "image/png", data: "abc" }] }));
  });

  it("sends compaction instructions and an idempotency key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accepted: true, runId: "8b2a18fb-9b91-4b1d-9c15-d2c6caf8e99e" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ref = { workspaceId: "da69b38d-f132-4c84-8c4f-6174015e9c5e", sessionId: "c2f73ddd-cfc6-464f-acb3-c8f425cea7f0" };
    const requestId = "8b2a18fb-9b91-4b1d-9c15-d2c6caf8e99e";

    await api.compact(ref, "Keep test results", requestId);

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/compact`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ customInstructions: "Keep test results", clientRequestId: requestId }));
  });
});
