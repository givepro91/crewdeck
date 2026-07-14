import { useEffect, useRef } from "react";

/**
 * Shared modal accessibility: document-level ESC-to-close, focus return, and
 * initial focus into the dialog. Modals were hand-rolled and inconsistent —
 * some closed on ESC (ConfirmDialog), some didn't (AutopilotModal), and none
 * returned focus to the trigger on close. This centralizes that behavior.
 *
 * Usage: attach the returned ref (with `tabIndex={-1}`) to the dialog's content
 * box. Keeps working alongside a modal's own autoFocus input — container focus
 * is only applied when nothing inside is focused yet.
 */
export function useModalA11y<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  // Keep the latest onClose without re-running the mount-only effect below
  // (which would re-trigger focus handling / focus-return on every change).
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Move focus into the dialog if a field inside hasn't already claimed it.
    if (el && !el.contains(document.activeElement)) {
      el.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Return focus to whatever opened the modal, if it's still in the DOM.
      if (prevFocused && document.contains(prevFocused)) prevFocused.focus();
    };
  }, []);

  return ref;
}
