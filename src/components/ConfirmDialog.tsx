import { useEffect, useRef } from "react";
import { Button, type ButtonVariant } from "./Button";
import { FONT_SERIF_DISPLAY, FONT_STACKS, type Theme } from "../styles/tokens";

interface Props {
  theme: Theme;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  theme,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  onConfirm,
  onCancel,
}: Props) {
  // Focus Cancel by default so a stray Enter press doesn't confirm a
  // destructive action. Esc cancels for keyboard parity with the OS dialog
  // we replaced.
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        // Above EditBookModal (9000) so a confirm raised from the modal
        // sits on top of it rather than behind the backdrop.
        zIndex: 9500,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: FONT_STACKS.sans,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, 100%)",
          background: theme.bg,
          color: theme.ink,
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          border: `0.5px solid ${theme.rule}`,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "20px 22px 16px" }}>
          <div
            id="confirm-dialog-title"
            style={{
              fontFamily: FONT_SERIF_DISPLAY,
              fontStyle: "italic",
              fontSize: 20,
              color: theme.ink,
              marginBottom: 8,
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: 13.5, color: theme.muted, lineHeight: 1.5 }}>
            {message}
          </div>
        </div>
        <div
          style={{
            padding: "12px 22px 16px",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <Button
            ref={cancelRef}
            theme={theme}
            variant="outline"
            size="sm"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            theme={theme}
            variant={confirmVariant}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
