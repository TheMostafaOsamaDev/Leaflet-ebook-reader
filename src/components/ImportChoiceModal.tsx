// Two-button popup that fronts the .docx import flow. Lets the user pick
// between "drop straight into the library" (the original behavior) and
// "open the manage view first to trim pages / pick a cover".
//
// Buttons are stacked vertically, primary on top, with subtitle copy
// underneath each so the choice is unambiguous on first read. Esc /
// backdrop click cancels.

import { useEffect, useRef } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { FONT_SERIF_DISPLAY, FONT_STACKS, type Theme } from "../styles/tokens";

interface Props {
  theme: Theme;
  onDirect: () => void;
  onManage: () => void;
  onCancel: () => void;
}

export function ImportChoiceModal({
  theme,
  onDirect,
  onManage,
  onCancel,
}: Props) {
  // Focus the primary action by default — Enter imports straight, which
  // matches "I just clicked Import .docx and want it to keep working like
  // it always has".
  const directRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    directRef.current?.focus();
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
      aria-labelledby="import-choice-title"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        // Below the import-progress modal (10000) so a long-running run
        // overlays this if the user happens to re-click during one.
        zIndex: 9700,
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
          width: "min(440px, 100%)",
          background: theme.bg,
          color: theme.ink,
          borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
          border: `0.5px solid ${theme.rule}`,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "22px 22px 8px" }}>
          <div
            id="import-choice-title"
            style={{
              fontFamily: FONT_SERIF_DISPLAY,
              fontStyle: "italic",
              fontSize: 22,
              color: theme.ink,
              letterSpacing: "-0.01em",
              marginBottom: 6,
            }}
          >
            Import a Word document
          </div>
          <div
            style={{
              fontSize: 13,
              color: theme.muted,
              lineHeight: 1.5,
            }}
          >
            How would you like to handle this document?
          </div>
        </div>

        <div
          style={{
            padding: "12px 22px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <ChoiceCard
            theme={theme}
            buttonRef={directRef}
            title="Add directly to library"
            description="Convert and import as-is. The first image becomes the cover."
            icon={<Icon name="download" size={16} />}
            onClick={onDirect}
            primary
          />
          <ChoiceCard
            theme={theme}
            title="Manage before importing"
            description="Pick the cover, trim pages, and review images before adding."
            icon={<Icon name="pencil" size={16} />}
            onClick={onManage}
          />
        </div>

        <div
          style={{
            padding: "10px 22px 16px",
            borderTop: `0.5px solid ${theme.rule}`,
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <Button theme={theme} variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ChoiceCardProps {
  theme: Theme;
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}

function ChoiceCard({
  theme,
  title,
  description,
  icon,
  onClick,
  primary,
  buttonRef,
}: ChoiceCardProps) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      style={{
        textAlign: "left",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "14px 16px",
        // Primary card uses ink-on-bg, secondary uses chrome-on-bg. Same
        // visual rhythm as the Button primary/outline pair so the choice
        // hierarchy reads at a glance.
        background: primary ? theme.ink : theme.chrome,
        color: primary ? theme.bg : theme.ink,
        border: primary ? "none" : `0.5px solid ${theme.rule}`,
        borderRadius: 10,
        fontFamily: "inherit",
        cursor: "pointer",
        transition: "filter 120ms ease, transform 90ms ease",
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.transform = "scale(0.99)";
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = "scale(1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "scale(1)";
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: 8,
          background: primary ? "rgba(255,255,255,0.12)" : theme.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: primary ? theme.bg : theme.ink,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
            fontWeight: 600,
            letterSpacing: "-0.005em",
            marginBottom: 3,
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            color: primary ? "rgba(255,255,255,0.72)" : theme.muted,
            lineHeight: 1.45,
          }}
        >
          {description}
        </span>
      </span>
    </button>
  );
}
