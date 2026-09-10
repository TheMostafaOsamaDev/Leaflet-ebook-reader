import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { SelectionNoteEditor } from "./SelectionNoteEditor";
import { HighlightColorRail } from "./HighlightColorRail";
import {
  HighlightToolbar,
  NoteFieldButton,
  ToolbarDivider,
  TOOLBAR_ROW_H,
  type ToolbarAnchor,
} from "./HighlightToolbar";
import { FONT_STACKS, type HighlightColor, type Theme } from "../styles/tokens";
import { useI18n } from "../i18n/useI18n";

interface Props {
  theme: Theme;
  /** Where the toolbar sits and what it stays clear of. */
  anchor: ToolbarAnchor;
  onPick: (color: HighlightColor) => void;
  onAddNote: (color: HighlightColor, note: string) => void;
  /** Copy the selected passage. The reader owns this because it holds
   *  the text; the toolbar only reports the tap and shows the
   *  confirmation. */
  onCopy: () => void;
  onDismiss: () => void;
}

const DEFAULT_COLOR: HighlightColor = "yellow";

/** How long the Copy button stays confirmed before returning to its
 *  resting label. Long enough to read, short enough that the toolbar is
 *  usable again straight away. */
const COPIED_MS = 1400;

export function SelectionPopover({
  theme,
  anchor,
  onPick,
  onAddNote,
  onCopy,
  onDismiss,
}: Props) {
  const { tr } = useI18n();
  const [noteMode, setNoteMode] = useState(false);
  // The colour a noted highlight will be painted in. Also the swatch
  // shown as selected once the reader has expressed a preference.
  const [noteColor, setNoteColor] = useState<HighlightColor>(DEFAULT_COLOR);
  // Kept across a trip back to the menu, so returning does not throw a
  // half-written note away.
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);

  // Esc backs out of the note editor first and only dismisses from the
  // menu, so a stray keypress cannot destroy a note being written.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (noteMode) {
        e.stopPropagation();
        setNoteMode(false);
      } else {
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [noteMode, onDismiss]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <HighlightToolbar
      theme={theme}
      anchor={anchor}
      dialog={noteMode}
      label={tr(noteMode ? "selection.noteAriaLabel" : "selection.ariaLabel")}
    >
      {noteMode ? (
        <SelectionNoteEditor
          theme={theme}
          color={noteColor}
          note={note}
          onColor={setNoteColor}
          onNote={setNote}
          onBack={() => setNoteMode(false)}
          onSave={() => onAddNote(noteColor, note)}
        />
      ) : (
        <>
          {/* No selection ring here: in the menu a swatch paints the
              passage the moment it is tapped, so none of them is a
              "current" colour waiting to be confirmed. */}
          <HighlightColorRail theme={theme} onPick={onPick} />
          <div style={{ height: 1, background: theme.rule }} />
          <div
            style={{ display: "flex", alignItems: "stretch", height: TOOLBAR_ROW_H }}
          >
            {/* One third / two thirds, per the design: copy is one word,
                the note field wants room to read as a field. */}
            <button
              onClick={() => {
                onCopy();
                setCopied(true);
              }}
              aria-label={tr("selection.copy")}
              style={{
                flex: "0 0 33.333%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                border: "none",
                background: "transparent",
                color: copied ? theme.ink : theme.chromeInk,
                cursor: "pointer",
                fontFamily: FONT_STACKS.sans,
                fontSize: 12.5,
                fontWeight: 500,
                padding: 0,
                whiteSpace: "nowrap",
                transition: "color 160ms ease-out",
              }}
            >
              {copied && <Icon name="check" size={13} />}
              <span>{tr(copied ? "selection.copied" : "selection.copy")}</span>
            </button>
            <ToolbarDivider theme={theme} />
            <NoteFieldButton
              theme={theme}
              label={note.trim() || tr("selection.writeNote")}
              filled={note.trim().length > 0}
              onClick={() => setNoteMode(true)}
            />
          </div>
        </>
      )}
    </HighlightToolbar>
  );
}
