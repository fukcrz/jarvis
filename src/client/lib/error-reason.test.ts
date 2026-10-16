import { describe, expect, it } from "vitest";
import { plainErrorReason } from "./error-reason";

describe("plainErrorReason", () => {
  it("explains common HTTP failures", () => {
    expect(plainErrorReason("HTTP 403\nforbidden")).toContain("403");
    expect(plainErrorReason("401 Unauthorized")).toContain("API Key");
    expect(plainErrorReason("429 Too Many Requests")).toContain("429");
    expect(plainErrorReason("HTTP 503 Service Unavailable")).toContain("5xx");
  });
  it("explains network and context errors", () => {
    expect(plainErrorReason("fetch failed: ECONNRESET")).toContain("网络");
    expect(plainErrorReason("This model's maximum context length is 128000 tokens")).toContain("上下文");
  });
  it("returns undefined for unknown errors", () => {
    expect(plainErrorReason("something odd")).toBeUndefined();
  });
});
