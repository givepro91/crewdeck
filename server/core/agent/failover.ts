/**
 * failover 결정 로직 (순수 함수).
 *
 * 세션이 실패했을 때 대체 백엔드로 재디스패치할지, 아니면 기존 쿨다운으로 갈지 결정한다.
 * - 트리거: rate_limit | session_exhausted | env_error (task_error=코드버그는 failover 안 함)
 * - failover 전역 토글이 켜져 있고, 대체 provider가 가용하며, 이 태스크 시도에서 아직 안 써봤을 때만 failover
 * - 루프 가드: triedProviders로 claude↔codex 무한 왕복 차단
 */
import type { AgentProvider } from "./adapters/backend.js";

export type FailoverReasonCode = "rate_limit" | "session_exhausted" | "env_error";
export type FailureClass = FailoverReasonCode | "task_error";

const TRIGGERS: FailoverReasonCode[] = ["rate_limit", "session_exhausted", "env_error"];

export interface FailoverInput {
  failure: FailureClass;
  currentProvider: AgentProvider;
  triedProviders: AgentProvider[];
  codexAvailable: boolean;
  claudeAvailable: boolean;
  failoverEnabled: boolean;
}

interface FailoverTraceFields {
  reasonCode: FailoverReasonCode | null;
  userMessage: string | null;
  fromProvider: AgentProvider | null;
  toProvider: AgentProvider | null;
  redispatched: boolean;
  loopGuardBlocked: boolean;
}

export type FailoverDecision =
  | ({ action: "failover"; toProvider: AgentProvider } & FailoverTraceFields)
  | ({ action: "cooldown" } & FailoverTraceFields);

function isFailoverReasonCode(failure: FailureClass): failure is FailoverReasonCode {
  return TRIGGERS.includes(failure as FailoverReasonCode);
}

function describeReason(reasonCode: FailoverReasonCode): string {
  switch (reasonCode) {
    case "rate_limit":
      return "사용량 한도";
    case "session_exhausted":
      return "세션 소진";
    case "env_error":
      return "실행 환경 오류";
  }
}

function buildUserMessage(input: {
  reasonCode: FailoverReasonCode;
  fromProvider: AgentProvider;
  toProvider: AgentProvider;
  redispatched: boolean;
  loopGuardBlocked: boolean;
  altAvailable: boolean;
  failoverEnabled: boolean;
}): string {
  const reason = describeReason(input.reasonCode);
  if (input.redispatched) {
    return `${input.fromProvider} ${reason}로 ${input.toProvider}에 재디스패치했습니다.`;
  }
  if (input.loopGuardBlocked) {
    return `${input.fromProvider} ${reason}가 발생했지만 ${input.toProvider}는 이미 이 태스크에서 시도되어 재디스패치하지 않았습니다.`;
  }
  if (!input.failoverEnabled) {
    return `${input.fromProvider} ${reason}가 발생했지만 provider failover가 꺼져 있어 쿨다운으로 전환했습니다.`;
  }
  if (!input.altAvailable) {
    return `${input.fromProvider} ${reason}가 발생했지만 ${input.toProvider}를 사용할 수 없어 쿨다운으로 전환했습니다.`;
  }
  return `${input.fromProvider} ${reason}를 쿨다운으로 전환했습니다.`;
}

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

/**
 * DB에 영속된 failover 트레이스에서 "이 태스크가 이미 시도한 provider"를 복원한다.
 *
 * loop guard 상태(triedProviders)는 인메모리 Map에만 있어 서버 재시작 시 사라진다.
 * 재시작 후 대체 provider가 다시 실패하면 tried가 {현재 provider}로만 재구성돼
 * 이미 실패했던 provider로 되돌아가는 무한 왕복이 열린다. 실제 재디스패치가 일어난
 * (redispatched=true) 트레이스의 from/to를 tried로 되살려 이를 차단한다.
 * redispatched=false(쿨다운만)이면 to provider가 실행된 적이 없으므로 복원하지 않는다.
 */
export function triedProvidersFromFailoverTrace(trace: {
  fromProvider: AgentProvider | null;
  toProvider: AgentProvider | null;
  redispatched: boolean;
}): AgentProvider[] {
  if (!trace.redispatched) return [];
  const tried: AgentProvider[] = [];
  if (trace.fromProvider) tried.push(trace.fromProvider);
  if (trace.toProvider) tried.push(trace.toProvider);
  return tried;
}

export function decideFailover(input: FailoverInput): FailoverDecision {
  const alt: AgentProvider = input.currentProvider === "claude" ? "codex" : "claude";
  const reasonCode = isFailoverReasonCode(input.failure) ? input.failure : null;
  if (!reasonCode) {
    return {
      action: "cooldown",
      reasonCode: null,
      userMessage: null,
      fromProvider: null,
      toProvider: null,
      redispatched: false,
      loopGuardBlocked: false,
    };
  }
  const altAvailable = alt === "codex" ? input.codexAvailable : input.claudeAvailable;
  const loopGuardBlocked = input.failoverEnabled && input.triedProviders.includes(alt);
  const redispatched = input.failoverEnabled && altAvailable && !loopGuardBlocked;
  const trace: FailoverTraceFields = {
    reasonCode,
    userMessage: buildUserMessage({
      reasonCode,
      fromProvider: input.currentProvider,
      toProvider: alt,
      redispatched,
      loopGuardBlocked,
      altAvailable,
      failoverEnabled: input.failoverEnabled,
    }),
    fromProvider: input.currentProvider,
    toProvider: alt,
    redispatched,
    loopGuardBlocked,
  };

  if (!redispatched) {
    return { action: "cooldown", ...trace };
  }
  return { action: "failover", ...trace, toProvider: alt };
}
