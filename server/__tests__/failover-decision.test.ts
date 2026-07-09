import { describe, it, expect } from "vitest";
import { decideFailover, pickCrossProviderForFix } from "../core/agent/failover.js";

const base = {
  triedProviders: ["claude"] as ("claude" | "codex")[],
  codexAvailable: true,
  claudeAvailable: true,
  failoverEnabled: true,
};

describe("decideFailover", () => {
  it("claude rate_limit → codex failover", () => {
    expect(decideFailover({ ...base, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "failover", toProvider: "codex" });
  });
  it("session_exhausted·env_error도 failover", () => {
    for (const f of ["session_exhausted", "env_error"] as const)
      expect(decideFailover({ ...base, failure: f, currentProvider: "claude" }).action).toBe("failover");
  });
  it("task_error는 cooldown(코드 버그는 failover 안 함)", () => {
    expect(decideFailover({ ...base, failure: "task_error", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("이미 codex 시도했으면 루프 가드 → cooldown", () => {
    expect(decideFailover({ ...base, triedProviders: ["claude", "codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toEqual({ action: "cooldown" });
  });
  it("codex 미가용이면 cooldown", () => {
    expect(decideFailover({ ...base, codexAvailable: false, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("failover 꺼져 있으면 cooldown", () => {
    expect(decideFailover({ ...base, failoverEnabled: false, failure: "rate_limit", currentProvider: "claude" }))
      .toEqual({ action: "cooldown" });
  });
  it("codex가 소진돼도 claude 미시도면 claude로 failover", () => {
    expect(decideFailover({ ...base, triedProviders: ["codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toEqual({ action: "failover", toProvider: "claude" });
  });
});

describe("pickCrossProviderForFix — 검증 FAIL 후 교차-provider 자동수정", () => {
  it("codex 구현 실패 → claude로 수정", () => {
    expect(pickCrossProviderForFix({ implProvider: "codex", altAvailable: true, failoverEnabled: true })).toBe("claude");
  });
  it("claude 구현 실패 → codex로 수정 (codex 가용 시)", () => {
    expect(pickCrossProviderForFix({ implProvider: "claude", altAvailable: true, failoverEnabled: true })).toBe("codex");
  });
  it("failover 꺼짐 → 교차 안 함(null, 같은 provider로 수정)", () => {
    expect(pickCrossProviderForFix({ implProvider: "codex", altAvailable: true, failoverEnabled: false })).toBeNull();
  });
  it("대체 provider 미가용 → 교차 안 함(null)", () => {
    expect(pickCrossProviderForFix({ implProvider: "claude", altAvailable: false, failoverEnabled: true })).toBeNull();
  });
});
