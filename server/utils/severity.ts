import type { Severity } from "../../shared/types.js";

const SEVERITY_VALUES: readonly Severity[] = ["auto-resolve", "soft-block", "hard-block"];

/**
 * `verifications.severity` 컬럼은 schema.ts의 CHECK로 3개 값만 허용한다:
 * ('auto-resolve' | 'soft-block' | 'hard-block').
 *
 * evaluator(특히 Codex)가 issue-레벨 표현(critical/high/info/warning 등)을 최상위
 * severity로 반환하면, 정규화 없이 INSERT할 경우 SQLITE_CONSTRAINT_CHECK로 throw되어
 * 검증이 verdict를 기록하지 못하고 crash → task blocked → 스케줄러 무한 retry 루프에 빠진다.
 *
 * 이 함수는 enum 밖의 값을 의미가 가장 가까운 허용값으로 매핑해 그 루프를 차단한다.
 */
export function normalizeSeverity(raw: unknown, verdict?: string): Severity {
  if (typeof raw === "string" && (SEVERITY_VALUES as readonly string[]).includes(raw)) {
    return raw as Severity;
  }
  const s = String(raw ?? "").trim().toLowerCase();
  if (["critical", "high", "blocker", "fail", "block", "hard_block"].includes(s)) return "hard-block";
  if (["medium", "moderate", "warning", "warn", "conditional", "soft_block"].includes(s)) return "soft-block";
  if (["low", "info", "none", "trivial", "pass", "minor", "auto_resolve", ""].includes(s)) return "auto-resolve";
  // 알 수 없는 값 → verdict 기준 폴백
  const v = String(verdict ?? "").toLowerCase();
  return v === "fail" ? "hard-block" : v === "conditional" ? "soft-block" : "auto-resolve";
}
