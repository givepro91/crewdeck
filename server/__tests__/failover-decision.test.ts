import { describe, it, expect } from "vitest";
import { decideFailover, pickCrossProviderForFix, triedProvidersFromFailoverTrace } from "../core/agent/failover.js";

const base = {
  triedProviders: ["claude"] as ("claude" | "codex")[],
  codexAvailable: true,
  claudeAvailable: true,
  failoverEnabled: true,
};

describe("decideFailover", () => {
  it("claude rate_limit → codex failover", () => {
    expect(decideFailover({ ...base, failure: "rate_limit", currentProvider: "claude" }))
      .toMatchObject({ action: "failover", toProvider: "codex" });
  });
  it("session_exhausted·env_error도 failover", () => {
    for (const f of ["session_exhausted", "env_error"] as const)
      expect(decideFailover({ ...base, failure: f, currentProvider: "claude" }).action).toBe("failover");
  });
  it("task_error는 cooldown(코드 버그는 failover 안 함)", () => {
    expect(decideFailover({ ...base, failure: "task_error", currentProvider: "claude" }))
      .toMatchObject({ action: "cooldown" });
  });
  it("이미 codex 시도했으면 루프 가드 → cooldown", () => {
    expect(decideFailover({ ...base, triedProviders: ["claude", "codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toMatchObject({ action: "cooldown", loopGuardBlocked: true });
  });
  it("codex 미가용이면 cooldown", () => {
    expect(decideFailover({ ...base, codexAvailable: false, failure: "rate_limit", currentProvider: "claude" }))
      .toMatchObject({ action: "cooldown" });
  });
  it("failover 꺼져 있으면 cooldown", () => {
    expect(decideFailover({ ...base, failoverEnabled: false, failure: "rate_limit", currentProvider: "claude" }))
      .toMatchObject({ action: "cooldown" });
  });
  it("codex가 소진돼도 claude 미시도면 claude로 failover", () => {
    expect(decideFailover({ ...base, triedProviders: ["codex"], failure: "rate_limit", currentProvider: "codex" }))
      .toMatchObject({ action: "failover", toProvider: "claude" });
  });
});

describe("triedProvidersFromFailoverTrace — 재시작 후 loop guard 복원", () => {
  it("redispatched 트레이스의 from/to를 tried로 복원", () => {
    expect(
      triedProvidersFromFailoverTrace({ fromProvider: "claude", toProvider: "codex", redispatched: true }),
    ).toEqual(["claude", "codex"]);
  });

  it("쿨다운만(redispatched=false)이면 복원하지 않음 — to는 실행된 적 없음", () => {
    expect(
      triedProvidersFromFailoverTrace({ fromProvider: "claude", toProvider: "codex", redispatched: false }),
    ).toEqual([]);
  });

  it("null provider는 건너뜀", () => {
    expect(
      triedProvidersFromFailoverTrace({ fromProvider: null, toProvider: null, redispatched: true }),
    ).toEqual([]);
  });

  it("재시작 시나리오: 복원한 tried로 왕복 재디스패치 차단 (codex 재실패 → claude로 안 돌아감)", () => {
    // claude→codex 재디스패치가 DB에 저장된 뒤 서버 재시작 → 인메모리 Map은 비었지만
    // DB 트레이스에서 [claude, codex]를 복원한다. codex가 다시 rate_limit이어도
    // claude는 이미 시도됨으로 잡혀 cooldown(loop guard).
    const tried = triedProvidersFromFailoverTrace({ fromProvider: "claude", toProvider: "codex", redispatched: true });
    expect(
      decideFailover({ ...base, triedProviders: tried, failure: "rate_limit", currentProvider: "codex" }),
    ).toMatchObject({ action: "cooldown", loopGuardBlocked: true });
  });

  it("복원값이 없으면(쿨다운만·신규 태스크) 정상 failover 유지", () => {
    // codex가 원래 provider였고 아직 failover 이력이 없으면(복원 [] + currentProvider) claude로 failover.
    const tried = triedProvidersFromFailoverTrace({ fromProvider: "claude", toProvider: "codex", redispatched: false });
    expect(
      decideFailover({ ...base, triedProviders: [...tried, "codex"], failure: "rate_limit", currentProvider: "codex" }),
    ).toMatchObject({ action: "failover", toProvider: "claude" });
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
