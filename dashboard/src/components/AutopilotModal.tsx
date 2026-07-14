import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalA11y } from "../hooks/useModalA11y";

type AutopilotMode = "off" | "goal" | "full";

interface AutopilotModalProps {
  currentMode: AutopilotMode;
  hasMission: boolean;
  hasCto: boolean;
  /** Number of existing todo tasks (for context when switching modes) */
  todoCount?: number;
  /** Number of tasks currently running */
  runningCount?: number;
  onConfirm: (mode: AutopilotMode) => void;
  onClose: () => void;
}

const MODES: { id: AutopilotMode; color: string; activeColor: string; border: string }[] = [
  { id: "off", color: "text-gray-600 dark:text-gray-300", activeColor: "bg-gray-100 dark:bg-gray-700 border-gray-400 dark:border-gray-500", border: "border-gray-200 dark:border-gray-700" },
  { id: "goal", color: "text-blue-600 dark:text-blue-400", activeColor: "bg-blue-50 dark:bg-blue-900/30 border-blue-500 dark:border-blue-400", border: "border-gray-200 dark:border-gray-700" },
  { id: "full", color: "text-orange-600 dark:text-orange-400", activeColor: "bg-orange-50 dark:bg-orange-900/20 border-orange-500 dark:border-orange-400", border: "border-gray-200 dark:border-gray-700" },
];

export function AutopilotModal({ currentMode, hasMission, hasCto, todoCount = 0, runningCount = 0, onConfirm, onClose }: AutopilotModalProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<AutopilotMode>(currentMode);
  const dialogRef = useModalA11y<HTMLDivElement>(onClose);

  const fullDisabled = !hasMission || !hasCto;
  const changed = selected !== currentMode;

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-[#25253d] rounded-xl shadow-lg w-[480px] overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {t("autopilotModalTitle")}
          </h3>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            {t("autopilotModalDesc")}
          </p>
        </div>

        {/* Mode Cards */}
        <div className="px-6 py-4 space-y-3">
          {MODES.map((mode) => {
            const isSelected = selected === mode.id;
            const isDisabled = mode.id === "full" && fullDisabled;

            return (
              <button
                key={mode.id}
                onClick={() => !isDisabled && setSelected(mode.id)}
                disabled={isDisabled}
                className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all ${
                  isDisabled
                    ? "opacity-40 cursor-not-allowed border-gray-200 dark:border-gray-700"
                    : isSelected
                      ? mode.activeColor
                      : `${mode.border} hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer`
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Radio indicator */}
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    isSelected ? "border-current" : "border-gray-300 dark:border-gray-600"
                  } ${mode.color}`}>
                    {isSelected && <div className="w-2 h-2 rounded-full bg-current" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${mode.color}`}>
                        {t(`autopilotMode_${mode.id}`)}
                      </span>
                      {mode.id === "goal" && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-500 dark:text-blue-400 rounded font-medium">
                          {t("recommended")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                      {t(`autopilotModeDesc_${mode.id}`)}
                    </p>
                  </div>
                </div>

                {/* Full mode warnings */}
                {mode.id === "full" && fullDisabled && (
                  <div className="mt-2 ml-7 text-[11px] text-red-400 dark:text-red-500">
                    {!hasMission && <div>{t("autopilotFullNeedsMission")}</div>}
                    {!hasCto && <div>{t("autopilotFullNeedsCto")}</div>}
                  </div>
                )}

                {/* Full mode safety notice */}
                {mode.id === "full" && !fullDisabled && isSelected && (
                  <div className="mt-2 ml-7 text-[11px] text-orange-500 dark:text-orange-400 space-y-0.5">
                    <div>{t("autopilotFullSafety1")}</div>
                    <div>{t("autopilotFullSafety2")}</div>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Transition context banners */}
        {changed && (
          <div className="px-6 pb-1 space-y-2">
            {/* off → goal/full: explain what happens to existing tasks */}
            {currentMode === "off" && selected !== "off" && todoCount > 0 && (
              <div className="px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-[11px] text-blue-700 dark:text-blue-300">
                {t("autopilotSwitchOnWithTasks", { count: todoCount })}
              </div>
            )}
            {/* goal/full → off: explain running tasks won't stop immediately */}
            {currentMode !== "off" && selected === "off" && runningCount > 0 && (
              <div className="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-[11px] text-amber-700 dark:text-amber-300">
                {t("autopilotSwitchOffWithRunning", { count: runningCount })}
              </div>
            )}
            {currentMode !== "off" && selected === "off" && runningCount === 0 && (
              <div className="px-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-[11px] text-gray-500 dark:text-gray-400">
                {t("autopilotSwitchOffClean")}
              </div>
            )}
            {/* goal → full or full → goal */}
            {currentMode === "goal" && selected === "full" && (
              <div className="px-3 py-2 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg text-[11px] text-orange-700 dark:text-orange-300">
                {t("autopilotGoalToFull")}
              </div>
            )}
            {currentMode === "full" && selected === "goal" && (
              <div className="px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-[11px] text-blue-700 dark:text-blue-300">
                {t("autopilotFullToGoal")}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 rounded"
          >
            {t("cancel")}
          </button>
          <button
            onClick={() => onConfirm(selected)}
            disabled={!changed}
            className="text-xs px-4 py-1.5 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded hover:bg-gray-700 dark:hover:bg-gray-100 disabled:opacity-40 font-medium"
          >
            {t("apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
