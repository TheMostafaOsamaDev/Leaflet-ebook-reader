import { Icon } from "./Icon";
import { HighlightColorRail } from "./HighlightColorRail";
import {
  FONT_STACKS,
  type HighlightColor,
  type Theme,
} from "../styles/tokens";
import { useI18n } from "../i18n/useI18n";

/**
 * The note bar. It replaces the colour menu in place, and the back
 * arrow returns to it with whatever has been typed still in hand.
 */
export function SelectionNoteEditor({
  theme,
  color,
  note,
  onColor,
  onNote,
  onBack,
  onSave,
}: {
  theme: Theme;
  /** Ringed in the rail. Only meaningful alongside `onColor`. */
  color?: HighlightColor;
  note: string;
  /** Omit where the colour is not the caller's to change — editing the
   *  note on an existing highlight, say. The rail is then not drawn at
   *  all, rather than drawn and inert. */
  onColor?: (c: HighlightColor) => void;
  onNote: (v: string) => void;
  onBack: () => void;
  onSave: () => void;
}) {
  const { tr } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Header: the way back, and the title. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 36,
          padding: "0 4px 0 8px",
          borderBottom: `1px solid ${theme.rule}`,
        }}
      >
        <button
          onClick={onBack}
          aria-label={tr("common.back")}
          title={tr("common.back")}
          style={{
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            borderRadius: 7,
            background: "transparent",
            color: theme.ink,
            cursor: "pointer",
            padding: 0,
          }}
        >
          {/* Back points toward the start of the line: left in
              English, right in Arabic. `rtl-flip-x` does the mirroring. */}
          <Icon name="arrowL" size={16} className="rtl-flip-x" />
        </button>
        <span
          style={{
            flex: 1,
            fontSize: 11.5,
            fontWeight: 600,
            color: theme.chromeInk,
            letterSpacing: 0.2,
          }}
        >
          {tr("highlights.addNote")}
        </span>
      </div>
      {/* The colour the note will be filed under. Same rail as the
          menu's, so the swatches stay finger-sized and in the same
          place — ringed here, because this one IS a pending choice. */}
      {onColor && (
        <HighlightColorRail theme={theme} selected={color} onPick={onColor} />
      )}
      <textarea
        autoFocus
        value={note}
        onChange={(e) => onNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          }
        }}
        placeholder={tr("highlights.whyMatterPlaceholder")}
        rows={3}
        style={{
          margin: "8px 10px 0",
          background: "transparent",
          color: theme.ink,
          border: "none",
          outline: "none",
          padding: 0,
            fontSize: 13,
          lineHeight: 1.6,
          fontFamily: FONT_STACKS.sans,
          resize: "none",
          minHeight: 62,
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 6,
          padding: "6px 8px 8px",
        }}
      >
        <button
          onClick={onSave}
          disabled={!note.trim()}
          style={{
            padding: "6px 14px",
            border: "none",
            borderRadius: 8,
            // Ink, not the highlight colour: white on these fills
            // measures 2.2-3.9:1, all of it under AA. Which colour the
            // note is filed under is already shown, ringed, in the rail
            // directly above.
            background: note.trim() ? theme.ink : theme.chrome,
            color: note.trim() ? theme.bg : theme.muted,
            fontSize: 12,
            fontWeight: 600,
            cursor: note.trim() ? "pointer" : "default",
            fontFamily: FONT_STACKS.sans,
            transition: "background 160ms ease-out, color 160ms ease-out",
          }}
        >
          {tr("common.save")}
        </button>
      </div>
    </div>
  );
}
