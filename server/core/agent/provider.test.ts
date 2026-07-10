import { describe, expect, it } from "vitest";
import { resolveProvider, resolveProviderTrace } from "./provider.js";

const cfg = { defaultProvider: "claude" as const };

describe("resolveProviderTrace", () => {
  it("records agent as the source when agent.provider is valid", () => {
    expect(
      resolveProviderTrace(
        { provider: "codex" },
        { default_provider: "claude" },
        cfg,
      ),
    ).toEqual({ provider: "codex", source: "agent" });
  });

  it("records project as the source when agent.provider is absent", () => {
    expect(
      resolveProviderTrace(
        { provider: null },
        { default_provider: "codex" },
        cfg,
      ),
    ).toEqual({ provider: "codex", source: "project" });
  });

  it("records global as the source when neither agent nor project has a provider", () => {
    expect(
      resolveProviderTrace(
        { provider: null },
        { default_provider: null },
        cfg,
      ),
    ).toEqual({ provider: "claude", source: "global" });
  });

  it("falls back to the global default when a configured provider is invalid", () => {
    expect(
      resolveProviderTrace(
        { provider: "openai" },
        { default_provider: "codex" },
        { defaultProvider: "codex" },
      ),
    ).toEqual({ provider: "codex", source: "global" });
  });
});

describe("resolveProvider", () => {
  it("keeps the provider-only API aligned with the traced policy", () => {
    expect(
      resolveProvider(
        { provider: null },
        { default_provider: "codex" },
        cfg,
      ),
    ).toBe("codex");
  });
});
