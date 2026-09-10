import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { useTrackedAnchor } from "../hooks/useTrackedAnchor";
import { FONT_STACKS, type Theme } from "../styles/tokens";

/** Toolbar width. Narrow enough for a phone, wide enough that the note
 *  field reads as a field — and, by design, narrower than the colour
 *  rail's contents, which is what makes the rail scroll. */
export const TOOLBAR_WIDTH = 268;
/** Height of the action row at the foot of both toolbars. */
export const TOOLBAR_ROW_H = 44;

export interface ToolbarAnchor {
  /** Re-measures what the toolbar is attached to, every scroll frame. */
  getAnchor: () => DOMRect | null;
  /** "auto": above the anchor if it fits, else below.
   *  "below": always below — the phone reader forces this so the
   *  toolbar never overlaps Android's native floating toolbar, which
   *  sits above the selected text. Once open the side is held either
   *  way; see lib/popoverPlacement. */
  placement?: "auto" | "below";
  /** The reader's chrome heights, so the toolbar stays inside ITS
   *  reading region. See useTrackedAnchor. */
  insets: { top: number; bottom: number };
}

/**
 * The surface both highlight toolbars are drawn on.
 *
 * They are the same object at two moments in its life — one offers a
 * passage a colour, the other shows what came of that — so they are one
 * width, one radius, one shadow. Keeping that in two files meant every
 * visual change had to be made twice, and a reader watches one turn
 * into the other.
 */
export function HighlightToolbar({
  theme,
  anchor,
  dialog,
  label,
  children,
}: {
  theme: Theme;
  anchor: ToolbarAnchor;
  /** True while the note editor is open: the surface is then a dialog
   *  rather than a toolbar, and says so. */
  dialog: boolean;
  label: string;
  children: ReactNode;
}) {
  const track = useTrackedAnchor({
    getAnchor: anchor.getAnchor,
    placement: anchor.placement ?? "auto",
    insets: anchor.insets,
  });

  return (
    <div
      role={dialog ? "dialog" : "toolbar"}
      aria-label={label}
      data-popover="highlight"
      ref={track.ref}
      onMouseDown={(e) => {
        // Keep the underlying selection alive while the user works our
        // controls — without this, mousedown collapses the selection
        // before we can read its anchor. The note editor is exempt:
        // preventing default there would stop the textarea taking focus
        // and the caret would never appear.
        if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
      }}
      style={{
        ...track.style,
        zIndex: 9000,
        width: TOOLBAR_WIDTH,
        maxWidth: "calc(100vw - 24px)",
        background: theme.bg,
        color: theme.ink,
        border: `0.5px solid ${theme.rule}`,
        borderRadius: 14,
        boxShadow: "0 12px 32px rgba(0,0,0,0.24)",
        fontFamily: FONT_STACKS.sans,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/** The hairline between the two halves of an action row. */
export function ToolbarDivider({ theme }: { theme: Theme }) {
  return <div style={{ width: 1, background: theme.rule, margin: "9px 0" }} />;
}

/**
 * The note control: reads as a text field, behaves as a button.
 *
 * Styled as a field on purpose, and that is only acceptable because the
 * thing it opens IS one, immediately, with the caret already in it.
 */
export function NoteFieldButton({
  theme,
  label,
  /** True once there is a note to show, which makes the label a record
   *  rather than an invitation — and worth full ink. */
  filled,
  onClick,
}: {
  theme: Theme;
  label: string;
  filled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-haspopup="dialog"
      aria-label={label}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        gap: 7,
        border: "none",
        background: "transparent",
        color: filled ? theme.chromeInk : theme.muted,
        cursor: "text",
        fontFamily: FONT_STACKS.sans,
        fontSize: 12.5,
        textAlign: "start",
        padding: "0 12px",
        minWidth: 0,
        whiteSpace: "nowrap",
      }}
    >
      <Icon name="pencil" size={13} style={{ flexShrink: 0, opacity: 0.8 }} />
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </button>
  );
}
