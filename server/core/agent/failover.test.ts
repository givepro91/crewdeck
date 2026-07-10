import { describe, expect, it } from "vitest";
import {
  decideFailover,
  triedProvidersFromFailoverTrace,
  type FailoverReasonCode,
} from "./failover.js";
import type { AgentProvider } from "./adapters/backend.js";

const base = {
  triedProviders: ["claude"] as AgentProvider[],
  codexAvailable: true,
  claudeAvailable: true,
  failoverEnabled: true,
};

describe("decideFailover", () => {
  it.each([
    ["rate_limit"],
    ["session_exhausted"],
    ["env_error"],
  ] satisfies [FailoverReasonCode][])(
    "redispatches for %s and preserves the reasonCode",
    (failure) => {
      expect(
        decideFailover({
          ...base,
          failure,
          currentProvider: "claude",
        }),
      ).toMatchObject({
        action: "failover",
        reasonCode: failure,
        fromProvider: "claude",
        toProvider: "codex",
        redispatched: true,
        loopGuardBlocked: false,
      });
    },
  );

  it("does not redispatch task_error because it is not a provider failure", () => {
    expect(
      decideFailover({
        ...base,
        failure: "task_error",
        currentProvider: "claude",
      }),
    ).toEqual({
      action: "cooldown",
      reasonCode: null,
      userMessage: null,
      fromProvider: null,
      toProvider: null,
      redispatched: false,
      loopGuardBlocked: false,
    });
  });

  it("does not redispatch when failover is disabled", () => {
    expect(
      decideFailover({
        ...base,
        failoverEnabled: false,
        failure: "rate_limit",
        currentProvider: "claude",
      }),
    ).toMatchObject({
      action: "cooldown",
      reasonCode: "rate_limit",
      fromProvider: "claude",
      toProvider: "codex",
      redispatched: false,
      loopGuardBlocked: false,
    });
  });

  it("does not redispatch when the alternate provider is unavailable", () => {
    expect(
      decideFailover({
        ...base,
        codexAvailable: false,
        failure: "env_error",
        currentProvider: "claude",
      }),
    ).toMatchObject({
      action: "cooldown",
      reasonCode: "env_error",
      fromProvider: "claude",
      toProvider: "codex",
      redispatched: false,
      loopGuardBlocked: false,
    });
  });

  it("blocks redispatch when the alternate provider was already tried", () => {
    expect(
      decideFailover({
        ...base,
        triedProviders: ["claude", "codex"],
        failure: "session_exhausted",
        currentProvider: "claude",
      }),
    ).toMatchObject({
      action: "cooldown",
      reasonCode: "session_exhausted",
      fromProvider: "claude",
      toProvider: "codex",
      redispatched: false,
      loopGuardBlocked: true,
    });
  });
});

describe("triedProvidersFromFailoverTrace", () => {
  it("restores only providers that were actually redispatched", () => {
    expect(
      triedProvidersFromFailoverTrace({
        fromProvider: "claude",
        toProvider: "codex",
        redispatched: true,
      }),
    ).toEqual(["claude", "codex"]);

    expect(
      triedProvidersFromFailoverTrace({
        fromProvider: "claude",
        toProvider: "codex",
        redispatched: false,
      }),
    ).toEqual([]);
  });

  it("restored redispatch history blocks a restarted scheduler from bouncing back", () => {
    const triedProviders = triedProvidersFromFailoverTrace({
      fromProvider: "claude",
      toProvider: "codex",
      redispatched: true,
    });

    expect(
      decideFailover({
        ...base,
        triedProviders,
        failure: "rate_limit",
        currentProvider: "codex",
      }),
    ).toMatchObject({
      action: "cooldown",
      reasonCode: "rate_limit",
      fromProvider: "codex",
      toProvider: "claude",
      redispatched: false,
      loopGuardBlocked: true,
    });
  });
});
