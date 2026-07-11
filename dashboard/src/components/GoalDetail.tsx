import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityLog } from "./ActivityLog";
import {
  type GoalStatus,
  type GoalStatusResponse,
  useGoalStatusStore,
} from "../stores/goals";
import type {
  VerificationIssueStatus,
  VerificationRoundVerdict,
  VerificationTimelineStatus,
} from "../lib/api";

interface GoalDetailProps {
  goalId: string;
  title?: string;
  initialStatus?: GoalStatusResponse | null;
  autoLoad?: boolean;
  className?: string;
  onStatusChange?: (status: GoalStatusResponse) => void;
}

const COPY = {
  en: {
    status: {
      running: "Running",
      failed: "Failed",
      pending_approval: "Pending Approval",
      completed: "Completed",
    },
    activity: "Activity",
    failedStage: "Failed stage",
    isolatedWorkspace: "Isolated workspace",
    savePoint: "Save point",
    evaluator: "Evaluator",
    loadFailed: "Could not load goal status",
    timeline: "Quality decision timeline",
    round: "Round",
    dimensions: "Quality dimensions",
    issues: "Issues",
    noIssues: "No issues found",
    noRounds: "No quality decisions yet",
    reason: "End reason",
    assignee: "Owner",
    fixTask: "Fix task",
    execution: "Agent run details",
    implementationAgent: "Implementation agent",
    evaluatorAgent: "Evaluation agent",
    fixAgents: "Fix agents",
    timelineLoadFailed: "Could not load quality decisions",
  },
  ko: {
    status: {
      running: "진행 중",
      failed: "실패",
      pending_approval: "목표 반영 대기 중",
      completed: "완료",
    },
    activity: "활동",
    failedStage: "실패 단계",
    isolatedWorkspace: "독립된 작업 공간",
    savePoint: "저장 지점",
    evaluator: "검증 에이전트",
    loadFailed: "목표 상태를 불러오지 못했습니다",
    timeline: "품질 판정 타임라인",
    round: "라운드",
    dimensions: "품질 항목",
    issues: "발견된 문제",
    noIssues: "발견된 문제가 없습니다",
    noRounds: "아직 품질 판정이 없습니다",
    reason: "종료 이유",
    assignee: "담당자",
    fixTask: "수정 작업",
    execution: "에이전트 실행 정보",
    implementationAgent: "구현 에이전트",
    evaluatorAgent: "검증 에이전트",
    fixAgents: "수정 에이전트",
    timelineLoadFailed: "품질 판정을 불러오지 못했습니다",
  },
};

const TIMELINE_STATUS_LABELS: Record<VerificationTimelineStatus, { en: string; ko: string }> = {
  passed: { en: "Passed", ko: "통과" },
  fixing: { en: "Fixing", ko: "수정 중" },
  stopped: { en: "Stopped", ko: "중단" },
  manual_approval: { en: "Needs review", ko: "확인 필요" },
};

const VERDICT_LABELS: Record<VerificationRoundVerdict, { en: string; ko: string }> = {
  pass: { en: "Passed", ko: "통과" },
  fail: { en: "Failed", ko: "실패" },
  stopped: { en: "Stopped", ko: "중단" },
  manual_approval: { en: "Needs review", ko: "확인 필요" },
};

const ISSUE_STATUS_LABELS: Record<VerificationIssueStatus, { en: string; ko: string }> = {
  open: { en: "Open", ko: "미해결" },
  resolved: { en: "Resolved", ko: "해결됨" },
  regression: { en: "Regression", ko: "재발" },
};

const DIMENSION_LABELS: Record<string, { en: string; ko: string }> = {
  functionality: { en: "Functionality", ko: "기능" },
  dataFlow: { en: "Data flow", ko: "데이터 흐름" },
  designAlignment: { en: "Design fit", ko: "설계 일치" },
  craft: { en: "Completeness", ko: "완성도" },
  edgeCases: { en: "Edge cases", ko: "예외 상황" },
};

const TIMELINE_STATUS_TONES: Record<VerificationTimelineStatus, string> = {
  passed: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  fixing: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  stopped: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  manual_approval: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
};

const VERDICT_TONES: Record<VerificationRoundVerdict, string> = {
  pass: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  fail: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  stopped: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  manual_approval: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
};

const ISSUE_STATUS_TONES: Record<VerificationIssueStatus, string> = {
  open: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  resolved: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400",
  regression: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400",
};

function getCopy(language: string) {
  return language.startsWith("ko") ? COPY.ko : COPY.en;
}

function getStatusTone(status: GoalStatus): {
  chip: string;
  dot: string;
  panel: string;
} {
  switch (status) {
    case "pending_approval":
      return {
        chip: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400",
        dot: "bg-amber-500",
        panel: "border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-900/10",
      };
    case "failed":
      return {
        chip: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400",
        dot: "bg-red-500",
        panel: "border-red-200 dark:border-red-800 bg-red-50/70 dark:bg-red-900/10",
      };
    case "completed":
      return {
        chip: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400",
        dot: "bg-green-500",
        panel: "border-green-200 dark:border-green-800 bg-green-50/60 dark:bg-green-900/10",
      };
    case "running":
      return {
        chip: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400",
        dot: "bg-blue-500",
        panel: "border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-900/10",
      };
  }
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

function readableCode(value: string): string {
  return value.replaceAll("_", " ");
}

export function GoalDetail({
  goalId,
  title,
  initialStatus = null,
  autoLoad = true,
  className = "",
  onStatusChange,
}: GoalDetailProps) {
  const { t, i18n } = useTranslation();
  const copy = getCopy(i18n.language);
  const [localError, setLocalError] = useState<string | null>(null);
  const [roundSelection, setRoundSelection] = useState<{
    goalId: string;
    verificationId: string | null;
  } | null>(null);
  const storeStatus = useGoalStatusStore((state) => state.byGoalId[goalId]);
  const loading = useGoalStatusStore((state) => Boolean(state.loadingByGoalId[goalId]));
  const storeError = useGoalStatusStore((state) => state.errorByGoalId[goalId]);
  const setGoalStatus = useGoalStatusStore((state) => state.setGoalStatus);
  const fetchGoalStatus = useGoalStatusStore((state) => state.fetchGoalStatus);
  const timeline = useGoalStatusStore((state) => state.timelineByGoalId[goalId]);
  const timelineLoading = useGoalStatusStore((state) => Boolean(state.timelineLoadingByGoalId[goalId]));
  const timelineError = useGoalStatusStore((state) => state.timelineErrorByGoalId[goalId]);
  const fetchVerificationTimeline = useGoalStatusStore((state) => state.fetchVerificationTimeline);
  const status = storeStatus ?? initialStatus;
  const expandedRound = roundSelection?.goalId === goalId
    ? roundSelection.verificationId
    : timeline?.rounds.at(-1)?.verification_id ?? null;

  useEffect(() => {
    if (initialStatus) setGoalStatus(initialStatus);
  }, [initialStatus, setGoalStatus]);

  useEffect(() => {
    if (!autoLoad) return;
    const load = () => {
      fetchGoalStatus(goalId)
        .then((next) => {
          setLocalError(null);
          onStatusChange?.(next);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : copy.loadFailed;
          setLocalError(message);
        });
      fetchVerificationTimeline(goalId).catch(() => undefined);
    };
    load();
    window.addEventListener("crewdeck:refresh", load);
    return () => window.removeEventListener("crewdeck:refresh", load);
  }, [autoLoad, copy.loadFailed, fetchGoalStatus, fetchVerificationTimeline, goalId, onStatusChange]);

  const statusTone = useMemo(
    () => (status ? getStatusTone(status.status) : getStatusTone("running")),
    [status],
  );

  const activityEvents = status?.activity_events ?? [];
  const errorMessage = localError ?? storeError;

  return (
    <section
      className={`rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-[#25253d] ${className}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          {title && (
            <h3 className="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
              {title}
            </h3>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone.chip}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusTone.dot}`} />
              {status ? copy.status[status.status] : t("loading")}
            </span>
            {loading && (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400 dark:bg-gray-700 dark:text-gray-500">
                <svg className="h-2.5 w-2.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                {t("loading")}
              </span>
            )}
          </div>
        </div>
      </div>

      {status && (
        <div className={`mt-3 rounded-lg border px-3 py-2 ${statusTone.panel}`}>
          <div className="grid gap-2 text-[11px] text-gray-600 dark:text-gray-400 sm:grid-cols-3">
            {status.worktree_path && (
              <div className="min-w-0">
                <span className="block font-medium text-gray-400 dark:text-gray-500">
                  {copy.isolatedWorkspace}
                </span>
                <span className="block truncate font-mono" title={status.worktree_path}>
                  {shortPath(status.worktree_path)}
                </span>
              </div>
            )}
            {status.worktree_branch && (
              <div className="min-w-0">
                <span className="block font-medium text-gray-400 dark:text-gray-500">
                  {copy.savePoint}
                </span>
                <span className="block truncate font-mono" title={status.worktree_branch}>
                  {status.worktree_branch}
                </span>
              </div>
            )}
            {status.evaluator_session_id && (
              <div className="min-w-0">
                <span className="block font-medium text-gray-400 dark:text-gray-500">
                  {copy.evaluator}
                </span>
                <span className="block truncate font-mono" title={status.evaluator_session_id}>
                  {status.evaluator_session_id.slice(0, 8)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {errorMessage}
        </div>
      )}

      {(timeline || timelineLoading || timelineError) && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-700" data-testid="verification-timeline">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {copy.timeline}
            </h4>
            <div className="flex items-center gap-1.5">
              {timelineLoading && (
                <span className="text-[10px] text-gray-400 dark:text-gray-500">{t("loading")}</span>
              )}
              {timeline && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${TIMELINE_STATUS_TONES[timeline.status]}`}>
                  {TIMELINE_STATUS_LABELS[timeline.status][i18n.language.startsWith("ko") ? "ko" : "en"]}
                </span>
              )}
            </div>
          </div>

          {timeline && (
            <div className="mt-1.5 flex min-w-0 items-start gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              <span className="shrink-0 font-medium">{copy.reason}</span>
              <span className="min-w-0 break-words">{readableCode(timeline.reason)}</span>
            </div>
          )}

          {timelineError && (
            <div className="mt-2 rounded border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              {copy.timelineLoadFailed}: {timelineError}
            </div>
          )}

          {timeline && timeline.rounds.length === 0 && (
            <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">{copy.noRounds}</p>
          )}

          {timeline && timeline.rounds.length > 0 && (
            <div className="mt-2 space-y-2">
              {timeline.rounds.map((round) => {
                const isExpanded = expandedRound === round.verification_id;
                const language = i18n.language.startsWith("ko") ? "ko" : "en";
                return (
                  <div key={round.verification_id} className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-700">
                    <button type="button"
                      aria-expanded={isExpanded}
                      aria-controls={`verification-round-${round.verification_id}`}
                      onClick={() => setRoundSelection({
                        goalId,
                        verificationId: isExpanded ? null : round.verification_id,
                      })}
                      className="flex w-full min-w-0 items-center gap-2 bg-gray-50 px-2.5 py-2 text-left hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-gray-800/50 dark:hover:bg-gray-800"
                    >
                      <svg
                        className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        aria-hidden="true"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                      <span className="shrink-0 text-[11px] font-semibold text-gray-700 dark:text-gray-200">
                        {copy.round} {round.round}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500 dark:text-gray-400">
                        {round.task_title}
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${VERDICT_TONES[round.verdict]}`}>
                        {VERDICT_LABELS[round.verdict][language]}
                      </span>
                    </button>

                    {isExpanded && (
                      <div id={`verification-round-${round.verification_id}`} className="space-y-3 px-2.5 py-2.5">
                        {round.reason && (
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">
                            <span className="font-medium">{copy.reason}: </span>
                            {readableCode(round.reason)}
                          </div>
                        )}

                        <div>
                          <h5 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                            {copy.dimensions}
                          </h5>
                          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                            {round.dimensions.map((dimension) => (
                              <div
                                key={dimension.dimension}
                                className={`min-w-0 rounded border px-2 py-1.5 ${
                                  dimension.passed
                                    ? "border-green-200 bg-green-50/60 dark:border-green-900 dark:bg-green-900/10"
                                    : "border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-900/10"
                                }`}
                              >
                                <div className="truncate text-[10px] text-gray-500 dark:text-gray-400" title={dimension.rationale}>
                                  {DIMENSION_LABELS[dimension.dimension]?.[language] ?? dimension.dimension}
                                </div>
                                <div className={`text-xs font-semibold ${dimension.passed ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                                  {dimension.score}/10
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div>
                          <h5 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                            {copy.issues} ({round.issues.length})
                          </h5>
                          {round.issues.length === 0 ? (
                            <p className="text-[11px] text-gray-400 dark:text-gray-500">{copy.noIssues}</p>
                          ) : (
                            <div className="space-y-1.5">
                              {round.issues.map((issue) => (
                                <div key={issue.issue_id} className="rounded border border-gray-200 bg-gray-50/60 px-2 py-2 dark:border-gray-700 dark:bg-gray-800/40">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${ISSUE_STATUS_TONES[issue.status]}`}>
                                      {ISSUE_STATUS_LABELS[issue.status][language]}
                                    </span>
                                    <span className="text-[9px] font-semibold uppercase text-gray-500 dark:text-gray-400">{issue.severity}</span>
                                    <span className="text-[10px] text-gray-400 dark:text-gray-500">
                                      {DIMENSION_LABELS[issue.dimension]?.[language] ?? issue.dimension}
                                    </span>
                                  </div>
                                  <p className="mt-1 break-words text-[11px] text-gray-700 dark:text-gray-300">{issue.evidence}</p>
                                  {(issue.assignee_id || issue.fix_task_id) && (
                                    <dl className="mt-1.5 grid gap-x-3 gap-y-1 text-[10px] text-gray-500 dark:text-gray-400 sm:grid-cols-2">
                                      {issue.assignee_id && (
                                        <div className="min-w-0">
                                          <dt className="font-medium">{copy.assignee}</dt>
                                          <dd className="break-all font-mono" title={issue.assignee_id}>{issue.assignee_id}</dd>
                                        </div>
                                      )}
                                      {issue.fix_task_id && (
                                        <div className="min-w-0">
                                          <dt className="font-medium">{copy.fixTask}</dt>
                                          <dd className="break-all font-mono" title={issue.fix_task_id}>{issue.fix_task_id}</dd>
                                        </div>
                                      )}
                                    </dl>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <details className="text-[10px] text-gray-500 dark:text-gray-400">
                          <summary className="cursor-pointer select-none font-medium focus-visible:ring-2 focus-visible:ring-blue-500">
                            {copy.execution}
                          </summary>
                          <dl className="mt-1.5 grid gap-x-3 gap-y-1.5 sm:grid-cols-2">
                            {round.implementation_session_id && (
                              <div className="min-w-0">
                                <dt>{copy.implementationAgent}</dt>
                                <dd className="break-all font-mono">{round.implementation_session_id}</dd>
                              </div>
                            )}
                            {round.evaluator_session_id && (
                              <div className="min-w-0">
                                <dt>{copy.evaluatorAgent}</dt>
                                <dd className="break-all font-mono">{round.evaluator_session_id}</dd>
                              </div>
                            )}
                            {round.fix_session_ids.length > 0 && (
                              <div className="min-w-0 sm:col-span-2">
                                <dt>{copy.fixAgents}</dt>
                                {round.fix_session_ids.map((sessionId) => (
                                  <dd key={sessionId} className="break-all font-mono">{sessionId}</dd>
                                ))}
                              </div>
                            )}
                          </dl>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {status?.status === "failed" && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            {copy.failedStage}
          </div>
          <ActivityLog events={activityEvents} highlightFailures maxEvents={8} />
        </div>
      )}

      {status?.status !== "failed" && activityEvents.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {copy.activity}
          </div>
          <ActivityLog events={activityEvents} compact maxEvents={5} />
        </div>
      )}
    </section>
  );
}
