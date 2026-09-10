import { NOTE_SPINE } from "../styles/noteSpine";
import { hlMark, type HighlightColor, type ThemeKey } from "../styles/tokens";
import type { NoteSpine } from "../hooks/useNoteSpines";

interface Props {
  /** Measured by the component that owns the containing block — see
   *  useNoteSpines for why it cannot be measured from in here. */
  spines: NoteSpine[];
  /** The colour of each noted highlight, by id. */
  colorOf: (id: string) => HighlightColor | undefined;
  themeKey: ThemeKey;
}

/**
 * The bar in the margin that says a highlight has a note on it.
 *
 * Out in the margin rather than on the words for two reasons. It never
 * touches the text, so it cannot reflow a paragraph the way padding or
 * an inline glyph would — the failure BookBody's `<mark>` is carefully
 * built to avoid. And it can span a run: a note on six lines gets a bar
 * six lines tall, which an underline cannot say.
 *
 * It is the same colour spine the note popover puts beside the note
 * itself, so the mark in the margin and the thing it opens read as one
 * object. Both take it from `hlMark`.
 */
export function NoteSpines({ spines, colorOf, themeKey }: Props) {
  if (spines.length === 0) return null;
  return (
    <>
      {spines.map((s) => {
        const color = colorOf(s.id);
        if (!color) return null;
        return (
          <span
            key={s.id}
            aria-hidden
            style={{
              position: "absolute",
              // Logical, so it mirrors into the right-hand margin under
              // Arabic without a second code path.
              insetInlineStart: -NOTE_SPINE.offset,
              top: s.top,
              height: s.height,
              width: NOTE_SPINE.width,
              borderRadius: NOTE_SPINE.width / 2,
              background: hlMark(color, themeKey),
              // Out of flow, but say so anyway: nothing here should ever
              // become a click target competing with the mark itself.
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
}
