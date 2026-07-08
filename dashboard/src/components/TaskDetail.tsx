import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

const STATUSES = ["pending_approval", "todo", "in_progress", "in_review", "done", "blocked"];

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending_approval: "statusPendingApproval",
  todo: "statusTodo",
  in_progress: "statusInProgress",
  in_review: "statusInReview",
  done: "statusDone",
  blocked: "statusBlocked",
};

const DIM_LABEL_KEYS: Record<string, string> = {
  functionality: "dimFunctionality",
  dataFlow: "dimDataFlow",
  designAlignment: "dimDesignAlignment",
  craft: "dimCraft",
  edgeCases: "dimEdgeCases",
};

// Live activity: kind → { icon, i18n label key }. Unknown kinds fall back to "tool".
const ACTIVITY_KIND_META: Record<string, { icon: string; labelKey: string }> = {
  command: { icon: "$", labelKey: "activityKindCommand" },
  file_read: { icon: "◎", labelKey: "activityKindFileRead" },
  file_edit: { icon: "✎", labelKey: "activityKindFileEdit" },
  search: { icon: "⌕", labelKey: "activityKindSearch" },
  text: { icon: "…", labelKey: "activityKindText" },
  tool: { icon: "⚙", labelKey: "activityKindTool" },
};

interface ActivityEvent {
  ts: string;
  kind: string;
  detail: string;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  status: string;
  project_id?: string;
  assignee_id: string | null;
  verification_id: string | null;
  target_files?: string | null; // JSON array string
  stack_hint?: string | null;
}

interface Agent {
  id: string;
  name: string;
}

interface Verification {
  id: string;
  verdict: string;
  scope: string;
  severity: string;
  dimensions: Record<string, { value: number; notes: string }>;
  issues: Array<{
    severity: string;
    file?: string;
    line?: number;
    message: string;
    suggestion?: string;
  }>;
  created_at: string;
}

interface TaskDetailProps {
  task: Task;
  agents: Agent[];
  onClose: () => void;
  onUpdate?: () => void;
}

export function TaskDetail({ task, agents, onClose, onUpdate }: TaskDetailProps) {
  const { t } = useTranslation();
  const [verification, setVerification] = useState<Verification | null>(null);
  const [status, setStatus] = useState(task.status);
  const [assigneeId, setAssigneeId] = useState<string>(task.assignee_id ?? "");
  const [rejectReason, setRejectReason] = useState("");
  const [showRejectInput, setShowRejectInput] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Load verification data if task has one
  useEffect(() => {
    if (task.verification_id) {
      api.verifications.listByTask(task.id).then((list) => {
        if (list.length > 0) setVerification(list[0]);
      });
    }
  }, [task.id, task.verification_id]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const handleStatusChange = async (newStatus: string) => {
    setStatus(newStatus);
    await api.tasks.update(task.id, { status: newStatus });
    onUpdate?.();
  };

  const handleAssigneeChange = async (newAgentId: string) => {
    setAssigneeId(newAgentId);
    await api.tasks.update(task.id, { assignee_id: newAgentId || null });
    onUpdate?.();
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      if (task.project_id) {
        await api.orchestration.approveTask(task.project_id, task.id);
      } else {
        await api.tasks.approve(task.id);
      }
      onUpdate?.();
      onClose();
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    setRejecting(true);
    try {
      if (task.project_id) {
        await api.orchestration.rejectTask(task.project_id, task.id, rejectReason || undefined);
      } else {
        await api.tasks.reject(task.id, rejectReason || undefined);
      }
      onUpdate?.();
      onClose();
    } finally {
      setRejecting(false);
    }
  };

  const VERDICT_COLORS: Record<string, string> = {
    pass: "bg-green-100 text-green-700",
    conditional: "bg-yellow-100 text-yellow-700",
    fail: "bg-red-100 text-red-700",
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={handleOverlayClick}
    >
      <div className="relative w-full max-w-lg mx-4 bg-white dark:bg-[#1e1e2e] rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t("taskDetail")}</h2>
          <button
            onClick={onClose}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {t("closeDetail")}
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Title */}
          <div>
            <p className="text-base font-medium text-gray-900 dark:text-gray-100">{task.title}</p>
            {task.description && (
              <div className="mt-3 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-[#1a1a2e] rounded-lg p-4 whitespace-pre-wrap leading-relaxed border border-gray-100 dark:border-gray-700">
                {task.description}
              </div>
            )}
          </div>

          {/* Scope anchor — target files + stack hint (P2) */}
          {(() => {
            let targets: string[] = [];
            try { targets = JSON.parse(task.target_files || "[]"); } catch { /* ignore */ }
            const hint = (task.stack_hint || "").trim();
            if (targets.length === 0 && !hint) return null;
            return (
              <div className="border border-blue-100 dark:border-blue-900/40 bg-blue-50/50 dark:bg-blue-900/10 rounded-lg p-3">
                <h4 className="text-[10px] uppercase tracking-wider text-blue-700 dark:text-blue-400 font-semibold mb-2">
                  {t("scopeAnchorTitle")}
                </h4>
                {targets.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1">{t("scopeTargetFiles")}</p>
                    <ul className="space-y-0.5">
                      {targets.map((f, i) => (
                        <li key={i} className="text-xs font-mono text-gray-700 dark:text-gray-300">
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {hint && (
                  <div>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1">{t("scopeStackHint")}</p>
                    <p className="text-xs text-gray-700 dark:text-gray-300">{hint}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Status + Agent row */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400">{t("taskStatus")}:</span>
              <select
                aria-label={t("taskStatus")}
                value={status}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="text-xs text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(STATUS_LABEL_KEYS[s])}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400">{t("assign")}:</span>
              <select
                aria-label={t("assign")}
                value={assigneeId}
                onChange={(e) => handleAssigneeChange(e.target.value)}
                className="text-xs text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded px-2 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                <option value="">— {t("promptAssignAgent")} —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Live activity — 실행 중인 태스크의 담당 에이전트 실시간 활동 */}
          {(status === "in_progress" || status === "in_review") && assigneeId && (
            // key=agentId → remount (fresh state) when the assignee changes
            <LiveActivity key={assigneeId} agentId={assigneeId} />
          )}

          {/* Approval Gate — pending_approval 상태일 때만 표시 */}
          {task.status === "pending_approval" && (
            <div className="border border-amber-200 dark:border-amber-800 rounded-lg p-4 bg-amber-50 dark:bg-amber-900/20 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                  {t("approvalRequired")}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleApprove}
                  disabled={approving || rejecting}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {approving ? t("approving") : t("approve")}
                </button>
                <button
                  onClick={() => setShowRejectInput((v) => !v)}
                  disabled={approving || rejecting}
                  className="flex-1 px-3 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t("reject")}
                </button>
              </div>
              {showRejectInput && (
                <div className="space-y-2">
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder={t("rejectFeedbackPlaceholder")}
                    rows={3}
                    className="w-full text-sm px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-red-400 resize-none"
                  />
                  <button
                    onClick={handleReject}
                    disabled={rejecting || approving}
                    className="w-full px-3 py-1.5 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {rejecting ? t("rejecting") : t("rejectConfirm")}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Verification results */}
          {!verification && (
            <div className="border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-400 dark:text-gray-500">{t("noVerification")}</p>
            </div>
          )}
          {verification && (
            <div className="border border-gray-100 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50 space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${VERDICT_COLORS[verification.verdict] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {verification.verdict === "pass"
                    ? t("verdictPass")
                    : verification.verdict === "conditional"
                      ? t("verdictConditional")
                      : t("verdictFail")}
                </span>
                <span className="text-xs text-gray-400">{verification.scope}</span>
                <span className="text-xs text-gray-300 dark:text-gray-600 ml-auto">
                  {new Date(verification.created_at).toLocaleString()}
                </span>
              </div>

              {/* 5-Dimension scores */}
              <div>
                <p className="text-[10px] font-medium text-gray-400 uppercase mb-1.5">{t("dimensionScore")}</p>
                <div className="space-y-1.5">
                  {Object.entries(verification.dimensions).map(([key, dim]) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 w-20 shrink-0">
                        {DIM_LABEL_KEYS[key] ? t(DIM_LABEL_KEYS[key]) : key}
                      </span>
                      <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full transition-all ${
                            dim.value >= 8
                              ? "bg-green-400"
                              : dim.value >= 5
                                ? "bg-yellow-400"
                                : "bg-red-400"
                          }`}
                          style={{ width: `${dim.value * 10}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-gray-500 dark:text-gray-400 w-5 text-right">
                        {dim.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Issues list — shows WHY the verification failed */}
              {verification.issues && verification.issues.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-gray-400 uppercase mb-1.5">
                    {t("issues")} ({verification.issues.length})
                  </p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {verification.issues.map((issue, i) => (
                      <div
                        key={i}
                        className={`text-xs p-2 rounded border-l-2 ${
                          issue.severity === "critical"
                            ? "border-red-500 bg-red-50 dark:bg-red-900/20"
                            : issue.severity === "high"
                              ? "border-orange-400 bg-orange-50 dark:bg-orange-900/20"
                              : "border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700/50"
                        }`}
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`text-[10px] font-medium uppercase ${
                            issue.severity === "critical" ? "text-red-600 dark:text-red-400"
                              : issue.severity === "high" ? "text-orange-600 dark:text-orange-400"
                              : "text-gray-500"
                          }`}>
                            {issue.severity}
                          </span>
                          {issue.file && (
                            <span className="text-[10px] text-gray-400 font-mono">
                              {issue.file}{issue.line ? `:${issue.line}` : ""}
                            </span>
                          )}
                        </div>
                        <p className="text-gray-700 dark:text-gray-300">{issue.message}</p>
                        {issue.suggestion && (
                          <p className="text-gray-400 dark:text-gray-500 mt-0.5 italic">{issue.suggestion}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Live activity feed for the task's assigned agent. Fetches the ring buffer on
 * open, then appends `agent:activity` WebSocket events. A 5s local timer keeps
 * the "heartbeat" (time since last activity) fresh without server round-trips.
 */
function LiveActivity({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Load initial buffer + subscribe to live events for this agent.
  // State starts empty on mount; the parent remounts via key={agentId} when the
  // assignee changes, so no manual reset is needed here.
  useEffect(() => {
    let alive = true;
    api.agents.activityLog(agentId).then((data) => {
      if (!alive) return;
      setEvents(data.events);
      setLastEventAt(data.lastEventAt);
    }).catch(() => { /* agent may have no activity yet */ });

    const onActivity = (e: Event) => {
      const detail = (e as CustomEvent).detail as { agentId: string; event: ActivityEvent; lastEventAt: string };
      if (!detail || detail.agentId !== agentId) return;
      setEvents((prev) => [...prev, detail.event].slice(-50));
      setLastEventAt(detail.lastEventAt ?? detail.event.ts);
    };
    window.addEventListener("nova:agent-activity", onActivity);
    return () => {
      alive = false;
      window.removeEventListener("nova:agent-activity", onActivity);
    };
  }, [agentId]);

  // Heartbeat tick — recompute elapsed every 5s
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  // Heartbeat classification: <60s recent (green pulse), <180s idle (gray), else stale (orange)
  const elapsedSec = lastEventAt ? Math.max(0, Math.floor((now - new Date(lastEventAt).getTime()) / 1000)) : null;
  let dotClass = "bg-gray-300 dark:bg-gray-600";
  let heartbeatText = t("activityNone");
  let textClass = "text-gray-400 dark:text-gray-500";
  if (elapsedSec !== null) {
    if (elapsedSec < 60) {
      dotClass = "bg-green-500 animate-pulse";
      textClass = "text-green-600 dark:text-green-400";
      heartbeatText = t("activityRecentSec", { n: elapsedSec });
    } else if (elapsedSec < 180) {
      dotClass = "bg-gray-400 dark:bg-gray-500";
      textClass = "text-gray-500 dark:text-gray-400";
      heartbeatText = t("activityRecentMin", { n: Math.floor(elapsedSec / 60) });
    } else {
      dotClass = "bg-orange-500";
      textClass = "text-orange-600 dark:text-orange-400";
      heartbeatText = t("activityStaleMin", { n: Math.floor(elapsedSec / 60) });
    }
  }

  const recent = events.slice(-15).reverse();

  return (
    <div className="border border-gray-100 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">{t("liveActivityTitle")}</span>
        <span className="flex items-center gap-1.5 ml-auto">
          <span className={`inline-block w-2 h-2 rounded-full ${dotClass}`} />
          <span className={`text-[11px] ${textClass}`}>{heartbeatText}</span>
        </span>
      </div>
      {recent.length > 0 && (
        <ul className="space-y-0.5 max-h-56 overflow-y-auto">
          {recent.map((ev, i) => {
            const meta = ACTIVITY_KIND_META[ev.kind] ?? ACTIVITY_KIND_META.tool;
            return (
              <li key={`${ev.ts}-${i}`} className="flex items-center gap-2 text-[11px] font-mono leading-relaxed">
                <span className="text-gray-400 dark:text-gray-500 shrink-0 tabular-nums">
                  {new Date(ev.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className="text-gray-500 dark:text-gray-400 shrink-0 w-4 text-center" title={t(meta.labelKey)}>
                  {meta.icon}
                </span>
                <span className="text-gray-700 dark:text-gray-300 truncate">{ev.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
