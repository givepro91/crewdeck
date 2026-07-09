/**
 * failover 결정 로직 (순수 함수).
 *
 * 세션이 실패했을 때 대체 백엔드로 재디스패치할지, 아니면 기존 쿨다운으로 갈지 결정한다.
 * - 트리거: rate_limit | session_exhausted | env_error (task_error=코드버그는 failover 안 함)
 * - failover 전역 토글이 켜져 있고, 대체 provider가 가용하며, 이 태스크 시도에서 아직 안 써봤을 때만 failover
 * - 루프 가드: triedProviders로 claude↔codex 무한 왕복 차단
 */
import type { AgentProvider } from "./adapters/backend.js";

export type FailureClass = "rate_limit" | "session_exhausted" | "env_error" | "task_error";

const TRIGGERS: FailureClass[] = ["rate_limit", "session_exhausted", "env_error"];

export interface FailoverInput {
  failure: FailureClass;
  currentProvider: AgentProvider;
  triedProviders: AgentProvider[];
  codexAvailable: boolean;
  claudeAvailable: boolean;
  failoverEnabled: boolean;
}

export type FailoverDecision =
  | { action: "failover"; toProvider: AgentProvider }
  | { action: "cooldown" };

/**
 * 검증 FAIL 후 self-heal 자동수정을 어느 provider로 돌릴지 결정한다 (교차-provider 해결).
 * 구현이 실패한 provider의 "반대"로 1회 수정 시도 — 같은 모델로 헛돌지 않고 다른 모델이
 * 실제로 고칠 기회를 준다("사용자 개입 없이 결국 해결"). self-heal 1회 상한은 불변이라 무한루프 없음.
 * @returns 대체 provider (교차 시도) | null (교차 안 함 → 같은 provider로 수정)
 */
export function pickCrossProviderForFix(input: {
  implProvider: AgentProvider;
  altAvailable: boolean;
  failoverEnabled: boolean;
}): AgentProvider | null {
  if (!input.failoverEnabled || !input.altAvailable) return null;
  return input.implProvider === "claude" ? "codex" : "claude";
}

export function decideFailover(input: FailoverInput): FailoverDecision {
  if (!input.failoverEnabled || !TRIGGERS.includes(input.failure)) {
    return { action: "cooldown" };
  }
  const alt: AgentProvider = input.currentProvider === "claude" ? "codex" : "claude";
  const altAvailable = alt === "codex" ? input.codexAvailable : input.claudeAvailable;
  if (!altAvailable || input.triedProviders.includes(alt)) {
    return { action: "cooldown" };
  }
  return { action: "failover", toProvider: alt };
}
