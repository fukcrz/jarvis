import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

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
