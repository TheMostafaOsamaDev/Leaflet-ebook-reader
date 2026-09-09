// Pure helpers for the reader's within-chapter progress bar (Feature A) and
// exact sub-paragraph resume (Feature B). No DOM / React access — keeping the
// math side-effect-free makes it easy to reason about (and to unit-test later,
// if this repo ever grows a test runner).

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Fraction (0..1) of the current chapter scrolled through, in scroll mode.
 *  When there's nothing to scroll — the chapter fits on screen, or (commonly)
 *  its body hasn't laid out yet because a streamed chapter's content loads
 *  async — the reader is still at the top, so this is 0. Returning a full bar
 *  here is wrong: it makes every freshly-opened chapter flash 100% until the
 *  first scroll. The bar grows toward 1 as the user scrolls to the end. */
export function chapterScrollFraction(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const scrollable = scrollHeight - clientHeight;
  if (scrollable <= 0) return 0;
  return clamp01(scrollTop / scrollable);
}

/** Fraction (0..1) of the way the viewport top sits INTO a paragraph.
 *  0 = the paragraph's top is at the viewport top; 1 = its bottom. Normalized
 *  to the paragraph, so it survives reflow (font size / column width changes)
 *  unlike an absolute scrollTop. */
export function paragraphScrollOffset(
  scrollTop: number,
  paragraphTop: number,
  paragraphHeight: number,
): number {
  if (paragraphHeight <= 0) return 0;
  return clamp01((scrollTop - paragraphTop) / paragraphHeight);
}

/** Inverse of paragraphScrollOffset: the scrollTop that lands the viewport at
 *  the saved offset within a paragraph. */
export function restoreScrollTop(
  paragraphTop: number,
  paragraphHeight: number,
  offset: number,
): number {
  return paragraphTop + clamp01(offset) * paragraphHeight;
}

/** Fraction (0..1) of the chapter consumed in paginated mode; last page = 1. */
export function paginatedFraction(page: number, totalPages: number): number {
  if (totalPages <= 0) return 0;
  return clamp01((page + 1) / totalPages);
}

/** Format a 0..1 fraction as a CSS width percentage string. */
export function fractionToWidth(fraction: number): string {
  return `${clamp01(fraction) * 100}%`;
}

/**
 * Whether the reader should land at the BOTTOM of the chapter it just entered.
 *
 * Scrolling up past a chapter's top steps back a chapter and should land at
 * that chapter's end, so reading continues upward mid-flow. The intent has to
 * survive a wait: a streamed chapter arrives empty and its content lands over
 * the network, and the mount effect cannot position anything until the
 * paragraphs exist — so the request outlives the render that made it.
 *
 * It must NOT survive a change of destination. Naming the chapter it was made
 * for is the whole point: a bare boolean, left set while an empty chapter was
 * still fetching, would silently be spent on whatever chapter the reader moved
 * to next — dropping them at the bottom of a chapter they had just turned
 * FORWARD into, which is the bug this replaced.
 */
export function landAtEndFor(
  pending: number | null,
  currentChapter: number,
): boolean {
  return pending !== null && pending === currentChapter;
}
