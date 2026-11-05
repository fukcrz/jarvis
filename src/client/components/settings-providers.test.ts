import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "../../shared/protocol";
import { LeaveGuardProvider, SettingsToastProvider } from "./settings-feedback";
import { ConnectionSection, type ProviderSettings } from "./settings-providers";

function renderConnection(apiKey?: string) {
  const provider = {
    id: "test-provider", supportsApiKey: true, apiKey, authConfigured: apiKey !== undefined,
  } as ProviderStatus;
  return renderToStaticMarkup(createElement(SettingsToastProvider, {
    children: createElement(LeaveGuardProvider, {
      children: createElement(ConnectionSection, { ps: {} as ProviderSettings, provider }),
    }),
  }));
}

describe("saved provider API Key", () => {
  it("loads the saved key into the password input without marking the connection dirty", () => {
    const markup = renderConnection("sk-test-saved-key");
    expect(markup).toMatch(/type="password"[^>]*value="sk-test-saved-key"/u);
    expect(markup).toContain('aria-label="显示 API Key"');
    expect(markup).toContain('class="st-dirty" aria-hidden="true"');
    expect(markup).not.toContain("留空不变");
  });

  it("keeps an unconfigured key empty", () => {
    const markup = renderConnection();
    expect(markup).toMatch(/type="password"[^>]*value=""/u);
    expect(markup).toContain('class="st-dirty" aria-hidden="true"');
  });
});
