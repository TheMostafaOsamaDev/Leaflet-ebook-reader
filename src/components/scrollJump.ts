/** The minimum an element needs on hand to be scrolled. Keeps this testable. */
export interface Scrollable {
  scrollTop: number;
}

/**
 * Move a scroller to a position programmatically, and make sure the result is
 * actually painted.
 *
 * WKWebView does not paint a large programmatic jump into freshly-mounted
 * content. The chapter is in the DOM, laid out, positioned and hit-testable —
 * text at the new offset can be selected and hovered — but the region was
 * never tiled by the compositor and nothing about assigning `scrollTop`
 * queues an invalidation for it. What the reader sees is an empty page that
 * stays empty until they scroll, at which point the real scroll invalidates
 * the region and the text appears all at once.
 *
 * Measured in the app at the moment it happened: 91 items in React, 90 in the
 * DOM, 7 paragraphs inside the viewport, `opacity: 1`, `visibility: visible`,
 * `scrollTop` 9741 of 9741 — and a blank window.
 *
 * So the jump is followed by a one-pixel round trip on the next two frames.
 * That is a genuine scroll as far as the compositor is concerned, so it tiles
 * and paints the region, and at 1px across ~32ms it is not perceptible. Only
 * jumps away from the top need it: at 0 the tiles are already there, and
 * `0 - 1` clamps back to 0 without generating anything.
 */
export function jumpScrollTop(
  el: Scrollable,
  top: number,
  schedule: (fn: () => void) => void = (fn) => {
    requestAnimationFrame(fn);
  },
): void {
  el.scrollTop = top;
  if (top <= 0) return;
  schedule(() => {
    // Read back rather than trusting `top`: the browser clamps to the
    // scrollable range, and nudging from a stale value would move the page.
    const landed = el.scrollTop;
    if (landed <= 0) return;
    el.scrollTop = landed - 1;
    schedule(() => {
      el.scrollTop = landed;
    });
  });
}
