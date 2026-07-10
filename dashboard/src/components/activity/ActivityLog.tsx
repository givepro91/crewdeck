import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getProviderActivityDetails, useActivityStore } from "../../stores/activityStore";
import { REASON_LABEL_KEYS, providerEngineName } from "../../lib/providerActivity";
import type { ActivityLogEntry } from "../../types";

interface ActivityLogProps {
  projectId: string;
}

function formatTime(iso: string): string {
  const normalized = iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`;
  return new Date(normalized).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function humanizeMessage(message: string): string {
  return message
    .replace(/\[CLI_EXIT_NONZERO\]:\s*/gi, "에이전트 실행 실패: ")
    .replace(/Agent CLI exited with code \d+/gi, "에이전트가 비정상 종료됨")
    .replace(/rate limit/gi, "사용량 한도");
}

function ActivityRow({ activity }: { activity: ActivityLogEntry }) {
  const { t } = useTranslation();
  const providerDetails = getProviderActivityDetails(activity);
  const isProviderFailover = providerDetails?.event === "provider:failover";
  const isProviderRedispatch = providerDetails?.event === "provider:redispatched";
  const dotClass = providerDetails
    ? "bg-orange-500"
    : activity.type === "system:error"
      ? "bg-red-500"
      : "bg-gray-300 dark:bg-gray-600";

  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <div className="min-w-0 flex-1 space-y-1">
        {providerDetails && (isProviderFailover || isProviderRedispatch) && (
          <div className="flex flex-wrap items-center gap-1">
            {(providerDetails.fromProvider || providerDetails.toProvider) && (
              <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                {providerEngineName(providerDetails.fromProvider)} → {providerEngineName(providerDetails.toProvider)}
              </span>
            )}
            {providerDetails.reasonCode && (
              <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
                {t(REASON_LABEL_KEYS[providerDetails.reasonCode])} · reasonCode={providerDetails.reasonCode}
              </span>
            )}
            {providerDetails.loopGuardBlocked && (
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {t("failoverLoopGuardBlocked")}
              </span>
            )}
          </div>
        )}
        <p
          className={`break-words leading-relaxed ${
            activity.type === "system:error"
              ? "text-red-600 dark:text-red-400"
              : "text-gray-700 dark:text-gray-300"
          }`}
        >
          {humanizeMessage(activity.message)}
        </p>
      </div>
      <span className="shrink-0 tabular-nums text-gray-300 dark:text-gray-600">
        {formatTime(activity.createdAt || activity.created_at)}
      </span>
    </div>
  );
}

export function ActivityLog({ projectId }: ActivityLogProps) {
  const { t } = useTranslation();
  const activities = useActivityStore((s) => s.activities);
  const loading = useActivityStore((s) => s.loading);

  useEffect(() => {
    if (!projectId) return;
    useActivityStore.getState().loadActivities(projectId);
  }, [projectId]);

  if (loading) {
    return <p className="text-xs italic text-gray-400">{t("loadingActivity")}</p>;
  }

  if (activities.length === 0) {
    return <p className="text-xs italic text-gray-400">{t("noActivity")}</p>;
  }

  return (
    <div className="space-y-1.5 px-3 py-2">
      {activities.map((activity) => (
        <ActivityRow key={activity.id} activity={activity} />
      ))}
    </div>
  );
}
