export type ActivePanel =
  | null
  | "toc"
  | "highlights"
  | "settings"
  | "progress";

/**
 * How the chapter is laid out in the reader.
 *
 *  - `paginated-2`: two side-by-side columns that exactly fill the page.
 *    No vertical scroll; left/right arrows flip pages.
 *  - `paginated-1`: single column filling the page, paginated.
 *  - `scroll`: classic vertical scroll, the entire chapter in one column.
 *
 * Position is preserved across modes via the persisted paragraph index —
 * switching modes lands the reader on the same paragraph it was last
 * showing, mapped onto whichever layout is active.
 */
export type ReadingMode = "paginated-2" | "paginated-1" | "scroll";

export interface Tweaks {
  theme: "light" | "sepia" | "dark" | "oled";
  fontFamily: "serif" | "sans" | "dyslexic" | "cairo" | "lateef" | "tajawal";
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  /** "auto" derives alignment from the book's language: justify in LTR
      books, right in RTL books. The explicit values let the user override. */
  textAlign: "auto" | "left" | "justify" | "right";
  readingMode: ReadingMode;
  /** Reading column width in px. Caps the book body in scroll mode; ignored
      in paginated modes where columns fill the container. */
  pageWidth: number;
  /** Reading column width as a percentage of the available container width
      (50–100). Applies in every reading mode on both desktop and mobile,
      letting the user shrink or expand the text column to match their
      screen. Combines with `pageWidth` (which still caps the absolute px
      width in scroll mode). */
  contentWidth: number;
  /** Mobile only — tap the right edge of the book to scroll forward a
      page-worth, the left edge to scroll back. The center third still
      toggles the reader chrome. Ignored on desktop. */
  mobileTapNav: boolean;
}
