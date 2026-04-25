import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { Highlight } from "../store/library";
import { FONT_STACKS, type Theme } from "../styles/tokens";

interface Props {
  theme: Theme;
  highlight: Highlight;
  /** Viewport rect of the clicked <mark> element. */
  anchor: DOMRect;
  onDelete: () => void;
  onUpdateNote: (note: string) => void;
  onDismiss: () => void;
}

export function HighlightActionPopover({
  theme,
  highlight,
  anchor,
  onDelete,
  onUpdateNote,
  onDismiss,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(highlight.note ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const margin = 8;
  const estimatedHeight = editing ? 130 : 40;
  const fitsAbove = anchor.top - estimatedHeight - margin > 8;
  const top = fitsAbove
    ? anchor.top - estimatedHeight - margin
    : anchor.bottom + margin;
  const center = anchor.left + anchor.width / 2;

  return (
    <div
      role="toolbar"
      aria-label="Highlight actions"
      data-popover="highlight"
      onMouseDown={(e) => {
        // Same trick as SelectionPopover — keep focus/selection state
        // stable while clicking inside this toolbar.
        e.preventDefault();
      }}
      style={{
        position: "fixed",
        top,
        left: center,
        transform: "translateX(-50%)",
        zIndex: 9000,
        padding: editing ? "10px 12px" : "4px 6px",
        background: theme.bg,
        color: theme.ink,
        border: `0.5px solid ${theme.rule}`,
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
        fontFamily: FONT_STACKS.sans,
        display: "flex",
        flexDirection: editing ? "column" : "row",
        alignItems: editing ? "stretch" : "center",
        gap: editing ? 8 : 2,
        minWidth: editing ? 260 : undefined,
      }}
    >
      {!editing ? (
        <>
          <button
            onClick={() => setEditing(true)}
            aria-label={highlight.note ? "Edit note" : "Add note"}
            title={highlight.note ? "Edit note" : "Add note"}
            style={iconBtn(theme)}
          >
            <Icon name="pencil" size={14} />
          </button>
          <button
            onClick={onDelete}
            aria-label="Remove highlight"
            title="Remove highlight"
            style={{ ...iconBtn(theme), color: "#c66" }}
          >
            <Icon name="close" size={14} />
          </button>
        </>
      ) : (
        <>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onUpdateNote(draft);
              }
            }}
            placeholder="Why does this matter?"
            rows={3}
            style={{
              width: "100%",
              background: theme.chrome,
              color: theme.ink,
              border: `0.5px solid ${theme.rule}`,
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 12,
              fontFamily: FONT_STACKS.sans,
              outline: "none",
              resize: "vertical",
              minHeight: 60,
            }}
          />
          <div
            style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
          >
            <button
              onClick={() => {
                setEditing(false);
                setDraft(highlight.note ?? "");
              }}
              style={ghostBtn(theme)}
            >
              Cancel
            </button>
            <button
              onClick={() => onUpdateNote(draft)}
              style={primaryBtn(theme)}
            >
              Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function iconBtn(theme: Theme): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    border: "none",
    borderRadius: 6,
    background: "transparent",
    color: theme.ink,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function ghostBtn(theme: Theme): React.CSSProperties {
  return {
    padding: "5px 10px",
    border: `0.5px solid ${theme.rule}`,
    borderRadius: 6,
    background: "transparent",
    color: theme.ink,
    fontSize: 11.5,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: FONT_STACKS.sans,
  };
}

function primaryBtn(theme: Theme): React.CSSProperties {
  return {
    padding: "5px 10px",
    border: "none",
    borderRadius: 6,
    background: theme.ink,
    color: theme.bg,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: FONT_STACKS.sans,
  };
}
