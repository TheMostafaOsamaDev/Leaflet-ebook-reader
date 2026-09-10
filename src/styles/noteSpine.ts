/**
 * The bar in the margin that says a highlight has a note on it.
 *
 * Geometry only — the colour is `hlMark` in tokens, beside the tint it
 * has to hold contrast against.
 *
 * Two painters draw this bar: the reflowable reader's React component
 * (components/NoteSpines) and the DOCX page builder
 * (reader/fixed/docxNoteSpines), which is imperative DOM and cannot use
 * it. They must agree, so both the numbers AND the arithmetic live here
 * rather than twice over.
 *
 * The PDF painter deliberately shares none of this: its overlay is
 * normalized to the page, so it positions in percentages that survive a
 * zoom for free, and it has no layout to measure. Pixels would be the
 * wrong unit there.
 */

/** Where the bar sits relative to the text it belongs to. */
export const NOTE_SPINE = {
  /** Distance from the text edge to the near side of the bar. The
   *  reflowable gutter is readingGutter(contentWidth, 24, 80) and the
   *  DOCX page margin is 56px, so 14 clears the text everywhere and
   *  still leaves air before the page edge. */
  offset: 14,
  width: 3,
} as const;

/** Trimmed off each end so the bar tracks the words rather than the line
 *  box — at line-height 2 the box is nearly twice the glyphs. */
const INSET = 4;
/** A one-word highlight on a small font still needs to read as a bar. */
const MIN_HEIGHT = 8;

export interface SpineBox {
  /** Offset from the top of the containing block. */
  top: number;
  height: number;
}

/**
 * Where the bar goes for one highlight, from its `<mark>`'s line boxes
 * and the block those are measured against.
 *
 * Takes RECTS, not a bounding rect: a mark wrapped across lines is
 * several boxes, and their union would span the whole column. The first
 * and last are what the bar spans — which is the point of putting it in
 * the margin, since a note on six lines then gets a bar six lines tall.
 *
 * Returns null when the mark has no boxes, i.e. it is not laid out yet.
 */
export function noteSpineBox(
  markRects: readonly DOMRect[],
  blockRect: DOMRect,
): SpineBox | null {
  if (markRects.length === 0) return null;
  const first = markRects[0];
  const last = markRects[markRects.length - 1];
  const height = Math.max(last.bottom - first.top, first.height);
  return {
    top: first.top - blockRect.top + INSET,
    height: Math.max(height - INSET * 2, MIN_HEIGHT),
  };
}
