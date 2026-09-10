import { useEffect, useState } from "react";
import { SelectionNoteEditor } from "./SelectionNoteEditor";
import {
  HighlightToolbar,
  NoteFieldButton,
  ToolbarDivider,
  TOOLBAR_ROW_H,
  type ToolbarAnchor,
} from "./HighlightToolbar";
import type { Highlight } from "../store/library";
import { FONT_STACKS, hlMark, type Theme, type ThemeKey } from "../styles/tokens";
import { useI18n } from "../i18n/useI18n";
import { Icon } from "./Icon";

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  highlight: Highlight;
  anchor: ToolbarAnchor;
  onDelete: () => void;
  onUpdateNote: (note: string) => void;
  onDismiss: () => void;
}

/** Past this the note scrolls rather than growing the popover into a
 *  wall over the page. */
const NOTE_MAX_H = 132;

/**
 * What a highlight shows when you tap it.
 *
 * With a note, that is the note — read first, then the row of things
 * you can do to it. Without one, it is just the row, and the note field
 * is an invitation rather than a record. Either way the bottom row is
 * laid out like the selection toolbar's: the same thirds, the same
 * field-shaped button, because this is the same highlight one step
 * later in its life.
 */
export function HighlightActionPopover({
  theme,
  themeKey,
  highlight,
  anchor,
  onDelete,
  onUpdateNote,
  onDismiss,
}: Props) {
  const { tr } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(highlight.note ?? "");
  // Deleting a highlight you have written against throws the writing
  // away, and there is no undo to catch it. So that delete asks first.
  // A bare highlight is one tap to remake, so that one does not.
  const [confirming, setConfirming] = useState(false);

  // Reset when pointed at a different highlight. Both pieces of state
  // above are seeded from props, and a `useState` initialiser does not
  // re-run — so without this the popover would open on a second
  // highlight showing the first one's draft, and with its delete
  // already armed. Doing it here rather than asking every call site
  // for a `key` keeps the component correct however it is mounted.
  const [shownId, setShownId] = useState(highlight.id);
  if (shownId !== highlight.id) {
    setShownId(highlight.id);
    setDraft(highlight.note ?? "");
    setEditing(false);
    setConfirming(false);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Back out one layer at a time: out of the editor, out of the
      // confirm, and only then out of the popover.
      if (editing) {
        e.stopPropagation();
        setEditing(false);
        setDraft(highlight.note ?? "");
      } else if (confirming) {
        e.stopPropagation();
        setConfirming(false);
      } else {
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, confirming, highlight.note, onDismiss]);

  const hasNote = Boolean(highlight.note?.trim());

  return (
    <HighlightToolbar
      theme={theme}
      anchor={anchor}
      dialog={editing}
      label={tr(editing ? "highlights.editNote" : "highlights.actions")}
    >
      {editing ? (
        <SelectionNoteEditor
          theme={theme}
          note={draft}
          onNote={setDraft}
          // No rail: the colour of an existing highlight is not this
          // screen's business, and offering a choice we cannot store
          // would be a lie.
          onBack={() => {
            setEditing(false);
            setDraft(highlight.note ?? "");
          }}
          onSave={() => onUpdateNote(draft)}
        />
      ) : (
        <>
          {hasNote && (
            <div
              style={{
                maxHeight: NOTE_MAX_H,
                overflowY: "auto",
                padding: "10px 12px",
                // The same spine, in the same colour, that marks this
                // highlight out in the margin — so the mark and the
                // thing it opens read as one object.
                borderInlineStart: `3px solid ${hlMark(highlight.color, themeKey)}`,
                fontSize: 13,
                lineHeight: 1.7,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {highlight.note}
            </div>
          )}
          <div style={{ height: 1, background: theme.rule }} />
          <div
            style={{ display: "flex", alignItems: "stretch", height: TOOLBAR_ROW_H }}
          >
            <button
              onClick={() => {
                if (hasNote && !confirming) {
                  setConfirming(true);
                  return;
                }
                onDelete();
              }}
              aria-label={tr(
                confirming ? "highlights.deleteConfirm" : "highlights.delete",
              )}
              style={{
                flex: confirming ? 1 : "0 0 33.333%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                border: "none",
                background: confirming ? theme.danger : "transparent",
                color: confirming ? theme.bg : theme.danger,
                cursor: "pointer",
                fontFamily: FONT_STACKS.sans,
                fontSize: 12.5,
                fontWeight: confirming ? 600 : 500,
                padding: 0,
                whiteSpace: "nowrap",
                transition: "background 160ms ease-out, color 160ms ease-out",
              }}
            >
              <Icon name="trash" size={13} />
              {/* Short label, full sentence for the screen reader: the
                  visible text has a third of 268px to live in. */}
              <span>
                {tr(
                  confirming
                    ? "highlights.deleteConfirm"
                    : "highlights.deleteShort",
                )}
              </span>
            </button>
            {!confirming && (
              <>
                <ToolbarDivider theme={theme} />
                <NoteFieldButton
                  theme={theme}
                  label={tr(
                    hasNote ? "highlights.editNote" : "selection.writeNote",
                  )}
                  filled={hasNote}
                  onClick={() => setEditing(true)}
                />
              </>
            )}
          </div>
        </>
      )}
    </HighlightToolbar>
  );
}
