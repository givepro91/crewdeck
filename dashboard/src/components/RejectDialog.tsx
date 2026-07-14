import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalA11y } from "../hooks/useModalA11y";

interface RejectDialogProps {
  taskTitle: string;
  onReject: (feedback: string, autoRerun: boolean) => void;
  onCancel: () => void;
}

export function RejectDialog({ taskTitle, onReject, onCancel }: RejectDialogProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState("");
  const [autoRerun, setAutoRerun] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useModalA11y<HTMLDivElement>(onCancel);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    onReject(feedback.trim(), autoRerun);
  };

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-[#25253d] rounded-xl shadow-lg w-[440px] max-w-[calc(100vw-2rem)] overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("rejectTitle")}
          </h3>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">
            {taskTitle}
          </p>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 block">
              {t("rejectFeedbackLabel")}
            </label>
            <textarea
              ref={textareaRef}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={t("rejectFeedbackPlaceholder")}
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-[#1a1a2e] text-gray-700 dark:text-gray-300 focus:outline-none focus:border-red-400 resize-y leading-relaxed"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
              }}
            />
          </div>

          {/* Auto rerun option */}
          <label className="flex items-start gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={autoRerun}
              onChange={(e) => setAutoRerun(e.target.checked)}
              className="mt-0.5 rounded border-gray-300 text-blue-500 focus:ring-blue-400"
            />
            <div>
              <span className="text-xs text-gray-600 dark:text-gray-300 group-hover:text-gray-800 dark:group-hover:text-gray-100">
                {t("rejectAutoRerun")}
              </span>
              <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5">
                {t("rejectAutoRerunDesc")}
              </p>
            </div>
          </label>

          {/* What happens next */}
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg px-3 py-2.5 border border-gray-100 dark:border-gray-700">
            <p className="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase mb-1">
              {t("rejectNextSteps")}
            </p>
            <ol className="text-[11px] text-gray-500 dark:text-gray-400 space-y-0.5 list-decimal list-inside">
              <li>{t("rejectStep1")}</li>
              <li>{t("rejectStep2")}</li>
              {autoRerun && <li>{t("rejectStep3Auto")}</li>}
              {!autoRerun && <li>{t("rejectStep3Manual")}</li>}
            </ol>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-between items-center">
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            Cmd+Enter
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="text-xs px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 rounded"
            >
              {t("cancel")}
            </button>
            <button
              onClick={handleSubmit}
              className="text-xs px-4 py-1.5 bg-red-500 text-white rounded hover:bg-red-600"
            >
              {t("rejectConfirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
