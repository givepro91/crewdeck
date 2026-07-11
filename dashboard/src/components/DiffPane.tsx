import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

/**
 * goal worktree의 unified diff를 파일별·라인 색으로 렌더한다 (읽기 전용).
 * hunk별 유지/되돌리기 + 인라인 코멘트는 Phase 3b(후속).
 */
export function DiffPane({ goalId }: { goalId: string }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ diff: string; truncated: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    api.goals
      .getDiff(goalId)
      .then((r) => { if (alive) setResult(r); })
      .catch(() => { if (alive) setResult({ diff: "", truncated: false }); });
    return () => { alive = false; };
  }, [goalId]);

  if (result === null) return <div className="p-4 text-xs text-gray-400">{t("loading")}</div>;
  if (!result.diff) return <div className="p-4 text-xs text-gray-400">{t("wsDiffEmpty")}</div>;
  const { diff, truncated } = result;

  // 파일 단위 분할: "diff --git" 경계 (앞을 lookahead로 남겨 헤더 보존)
  const files = diff.split(/(?=^diff --git )/m).filter((f) => f.trim());

  return (
    <div className="text-xs font-mono h-full">
      {truncated && (
        <div className="px-3 py-1 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10">
          {t("wsDiffTruncated")}
        </div>
      )}
      {files.map((f, i) => <DiffFile key={i} text={f} />)}
    </div>
  );
}

function DiffFile({ text }: { text: string }) {
  const lines = text.split("\n");
  const header = lines[0]?.replace("diff --git a/", "").replace(/ b\/.*/, "") ?? "file";
  return (
    <div className="border-b border-gray-100 dark:border-gray-800">
      <div className="sticky top-0 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 font-semibold text-gray-700 dark:text-gray-300 border-b border-gray-100 dark:border-gray-700 truncate">
        {header}
      </div>
      <div>
        {lines.slice(1).map((ln, i) => {
          const cls =
            ln.startsWith("+") && !ln.startsWith("+++")
              ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300"
              : ln.startsWith("-") && !ln.startsWith("---")
                ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
                : ln.startsWith("@@")
                  ? "text-indigo-500 dark:text-indigo-400 bg-indigo-50/50 dark:bg-indigo-500/5"
                  : "text-gray-500 dark:text-gray-400";
          return (
            <div key={i} className={`px-3 whitespace-pre-wrap break-all ${cls}`}>
              {ln || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}
