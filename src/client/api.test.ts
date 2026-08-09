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
});
