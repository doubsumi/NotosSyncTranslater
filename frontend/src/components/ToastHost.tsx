import { useEffect, useRef, useState } from "react";
import { type ToastMessage } from "../lib/controller";
import { Icon } from "./Icon";

interface Props {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

const AUTO_DISMISS_MS: Record<ToastMessage["kind"], number> = {
  info: 4000,
  success: 2600,
  warning: 6000,
  error: 8000,
};

/**
 * Toast/popup notification centre. Errors and reminders appear here — never
 * inline inside the text panes — per the product requirements. Region is
 * aria-live so screen readers announce new messages.
 */
export function ToastHost({ toasts, onDismiss }: Props): JSX.Element {
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: number) => void;
}): JSX.Element {
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    leaveTimer.current = setTimeout(() => setLeaving(true), AUTO_DISMISS_MS[toast.kind]);
    return () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, [toast.kind]);

  const dismiss = (): void => {
    setLeaving(true);
  };

  return (
    <div
      className={`toast toast-${toast.kind}${leaving ? " toast-leave" : ""}`}
      onAnimationEnd={() => {
        if (leaving) onDismiss(toast.id);
      }}
      role="alert"
    >
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-message">{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.onAction?.();
            dismiss();
          }}
        >
          {toast.actionLabel}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="关闭提示" onClick={dismiss}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
