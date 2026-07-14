import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalA11y } from "../hooks/useModalA11y";

interface InputDialogProps {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function InputDialog({
  title,
  placeholder,
  defaultValue = "",
  submitLabel,
  cancelLabel,
  onSubmit,
  onCancel,
}: InputDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalA11y<HTMLDivElement>(onCancel);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (value.trim()) onSubmit(value.trim());
  };

  return (
    <div
      className="fixed inset-0 bg-black/20 dark:bg-black/50 flex items-center justify-center z-50"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-white dark:bg-[#25253d] rounded-xl shadow-lg w-[420px] overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">
            {title}
          </h3>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
              if (e.key === "Escape") onCancel();
            }}
            placeholder={placeholder}
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-[#1a1a2e] text-gray-800 dark:text-gray-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400"
          />
        </div>
        <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 rounded"
          >
            {cancelLabel ?? t("cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="text-xs px-4 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-40"
          >
            {submitLabel ?? t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
