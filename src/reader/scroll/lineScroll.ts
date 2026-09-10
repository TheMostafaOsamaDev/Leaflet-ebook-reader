// Line-aware scrolling for the reading surface.
//
// The reader used to do nothing at all to wheel input — no smoothing, and no
// `scroll-behavior` on the reading surface — so whatever the webview did
// natively was what the reader got. Measured against the real line box
// (27.2px at fontSize 17 / lineHeight 1.6), the device in use produced:
//
//   12-13px per event scrolling slowly       = 0.44-0.48 of a line
//   104-209px per event in a momentum burst, 17ms apart = 3.8-7.7 lines
//
// So slow scrolling left the text grid permanently misaligned, with the top and
// bottom lines half-cut and the eye's anchor drifting by fractions of a line,
// while a flick moved 230-460 lines a second — a blur rather than a scroll.
//
// Two independent fixes, measured separately against the real line box:
//
//   easing    glides to the target instead of applying each delta whole.
//             Worst single-frame movement 209px -> 55px.
//   snapping  comes to rest on a whole line. Alignment at rest 6.5px -> 0.8px.
//
// Snapping ALONE is worse than doing nothing for the blur (77px mean per frame
// against native's 52), which is worth knowing because "just snap to lines" is
// the obvious naive fix. Both together is what reads well.
//
// Everything here is pure. The DOM wiring lives in useLineScroll.

/** How much of the remaining gap a glide closes each frame. */
export const GLIDE_FACTOR = 0.22;
/** Below this the glide lands exactly, rather than crawling toward the target. */
export const GLIDE_SETTLE_PX = 0.5;

/**
 * Wheel deltas do not arrive in one unit. `deltaMode` says which: 0 pixels,
 * 1 lines, 2 pages. A line-mode device reports a deltaY of about 1-3 where a
 * pixel-mode one reports 100+, so treating the raw number as pixels makes a
 * device's scrolling either inert or unusably fast. Chromium reports pixels,
 * which is exactly why this is easy to get wrong and never notice in a
 * browser.
 */
export function wheelDeltaToPixels(deltaY: number, deltaMode = 0): number {
  if (deltaMode === 1) return deltaY * 40; // Chromium's own lines→px factor
  if (deltaMode === 2) return deltaY * 400; // a page, roughly a viewport
  return deltaY;
}

/** The nearest whole-line offset to `top`. */
export function snapToLine(top: number, lineBox: number): number {
  if (!(lineBox > 0)) return top;
  return Math.round(top / lineBox) * lineBox;
}

/**
 * Signed distance from `top` to the nearest line boundary — what a settle has
 * to travel. Never more than half a line in either direction.
 */
export function settleDelta(top: number, lineBox: number): number {
  if (!(lineBox > 0)) return 0;
  const frac = top % lineBox;
  const delta = frac < lineBox / 2 ? -frac : lineBox - frac;
  return delta === 0 ? 0 : delta;
}

/** One frame of exponential glide toward `target`. */
export function glideStep(
  current: number,
  target: number,
  factor = GLIDE_FACTOR,
  settlePx = GLIDE_SETTLE_PX,
): number {
  const gap = target - current;
  if (Math.abs(gap) <= settlePx) return target;
  return current + gap * factor;
}

export interface LineBank {
  /**
   * Add raw travel, and get back the whole-line distance that can be spent
   * now. The remainder is kept for next time.
   */
  spend(px: number, lineBox: number): number;
  reset(): void;
}

/**
 * Banks sub-line travel so quantised scrolling still moves the exact distance
 * the device asked for.
 *
 * Quantising each event on its own does not work, and fails in the worst
 * possible way: this machine's slow scroll is 13px, which rounds to zero whole
 * lines, and since the glide keeps the frame loop alive the next event rounds
 * from the same unmoved target and also gives zero — for ever. Measured before
 * the fix: twelve slow notches moved the page 0px where native moved 156px. Banking the remainder means the reader's total travel is
 * preserved to the pixel while only the resting position is on a line.
 */
export function createLineBank(): LineBank {
  let banked = 0;
  return {
    spend(px, lineBox) {
      if (!(lineBox > 0)) return px;
      banked += px;
      const lines = Math.trunc(banked / lineBox);
      banked -= lines * lineBox;
      return lines === 0 ? 0 : lines * lineBox;
    },
    reset() {
      banked = 0;
    },
  };
}

/**
 * The line box of the text inside a scroller, read from what is actually
 * rendered rather than recomputed from fontSize × lineHeight — the two do not
 * always agree once a font's own metrics are involved.
 *
 * Returns 0 when there is nothing to measure, which callers treat as "do not
 * quantise" rather than guessing a value.
 */
export function measureLineBox(scroller: Element | null): number {
  const p = scroller?.querySelector("p");
  if (!p) return 0;
  const lh = parseFloat(getComputedStyle(p).lineHeight);
  return Number.isFinite(lh) && lh > 0 ? lh : 0;
}
