import { useTranslation } from "react-i18next";
import { useModalA11y } from "../hooks/useModalA11y";

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useModalA11y<HTMLDivElement>(onCancel);

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-[#25253d] rounded-xl shadow-lg w-[380px] overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-5">
          <p className="text-sm text-gray-700 dark:text-gray-300">{message}</p>
        </div>
        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 rounded"
          >
            {t("cancel")}
          </button>
          <button
            onClick={onConfirm}
            className="text-xs px-4 py-1.5 bg-red-500 text-white rounded hover:bg-red-600"
          >
            {t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
