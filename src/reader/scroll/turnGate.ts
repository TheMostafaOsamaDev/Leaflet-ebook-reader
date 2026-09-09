/**
 * Decides whether a wheel event at a chapter's edge should turn the chapter.
 *
 * This replaces a 200-line velocity engine, and the reason it can be this
 * small is the end-of-chapter card. That engine had to INFER intent from the
 * gesture — scaling a threshold with wheel speed, discarding momentum tails,
 * charging 1.6-4.6 notches — because the turn was invisible and the only
 * evidence of intent was how the reader moved the wheel. A card the reader can
 * see and has scrolled up to carries that intent itself, so the gesture no
 * longer has to prove anything and one notch past the end is enough.
 *
 * What CANNOT be dropped is the lock, and it has to be silence-based rather
 * than a cooldown. A fixed cooldown lets one continuous spin turn again every
 * time it expires, which is how a single flick used to eat three chapters: a
 * chapter shorter than the viewport shows its own card immediately, so the
 * rest of the spin would spend on it. Requiring the wheel to actually GO QUIET
 * means one turn per gesture, however long the gesture runs.
 *
 * The lock lifts lazily, on the first event after a quiet gap, so this needs
 * no timer and no animation frame of its own.
 */
/**
 * Wheel deltas do not arrive in one unit. `deltaMode` says which: 0 pixels,
 * 1 lines, 2 pages. A line-mode event carries a deltaY of about 1-3 where a
 * pixel-mode one carries 100+, so comparing the raw number against a pixel
 * threshold silently rejects every event on a device that reports lines — the
 * reader scrolls at the edge and nothing happens, in either direction.
 *
 * Chromium reports pixels, so this is invisible in a browser and only shows
 * up in the app. The engine this gate replaced normalised deltaMode and had a
 * test for it; dropping that was a regression, and this is it restored.
 */
export function wheelDeltaToPixels(deltaY: number, deltaMode = 0): number {
  if (deltaMode === 1) return deltaY * 40; // Chromium's own lines→px factor
  if (deltaMode === 2) return deltaY * 400; // a page, roughly a viewport
  return deltaY;
}

export interface TurnGate {
  /**
   * Feed every wheel event, at the edge or not — the gate needs to see the
   * whole gesture to know when it ended. Returns true when the chapter should
   * turn now.
   *
   * `deltaMode` comes straight from the WheelEvent; omitting it means pixels.
   */
  onWheel(deltaY: number, atEdge: boolean, t: number, deltaMode?: number): boolean;
  /** The host confirms a turn landed, arming the lock. */
  didTurn(t: number): void;
  /** Forget everything — for a chapter change from elsewhere (TOC, scrubber). */
  reset(): void;
}

export interface TurnGateOptions {
  /** Ignore anything smaller: trackpad noise and inertia dribble. */
  minDelta?: number;
  /** Silence that ends a gesture and lifts the lock. */
  quietMs?: number;
}

export function createTurnGate(options: TurnGateOptions = {}): TurnGate {
  const minDelta = options.minDelta ?? 8;
  const quietMs = options.quietMs ?? 400;

  let locked = false;
  let lastEvent = -Infinity;

  return {
    onWheel(deltaY, atEdge, t, deltaMode) {
      const gap = t - lastEvent;
      lastEvent = t;
      // Lift the lock only once the wheel has genuinely stopped. Checked
      // against the gap BEFORE this event, so a gesture that never pauses
      // never unlocks.
      if (locked && gap >= quietMs) locked = false;
      if (!atEdge) return false;
      if (Math.abs(wheelDeltaToPixels(deltaY, deltaMode)) < minDelta) return false;
      return !locked;
    },
    didTurn(t) {
      locked = true;
      lastEvent = t;
    },
    reset() {
      locked = false;
      lastEvent = -Infinity;
    },
  };
}

/** Where a chapter opened the reader: on its first pixel, or its last. */
export type Arrival = "top" | "bottom";

/** Which way the reader is asking to go. */
export type Direction = "next" | "prev";

/**
 * Whether the reader's push is a genuine request, or would simply undo the
 * move that just brought them here.
 *
 * Turning back a chapter lands them on its last pixel; turning forward lands
 * them on its first. Both are edges, so without this the very next scroll
 * reverses the turn: land at the end, scroll down, get thrown forward; land at
 * the top, scroll up, get thrown back. Measured in the app — four turns in ten
 * seconds, alternating, never more than 359px into a chapter.
 *
 * The guard is on the DIRECTION, not the edge. A first attempt disarmed "the
 * edge you were placed on", which is the same thing while a chapter is long
 * enough to scroll — and useless when it is not. A chapter shorter than the
 * viewport sits at its top and its bottom simultaneously, so "which edge" no
 * longer distinguishes continuing from reversing, and a two-paragraph chapter
 * threw the reader straight back out the way they came in.
 *
 * Direction always distinguishes them: the way they were already travelling
 * stays open, and only the reversal waits until they have moved off the
 * arrival edge (see clearPlacedEdge) or use the visible prev/next affordance.
 */
export function directionIsArmed(
  placedAt: Arrival | null,
  pushing: Direction,
): boolean {
  if (placedAt === null) return true;
  // Placed on the first pixel = arrived going forward; "prev" would undo it.
  if (placedAt === "top") return pushing !== "prev";
  // Placed on the last pixel = arrived going back; "next" would undo it.
  return pushing !== "next";
}

/**
 * Forget the arrival once the reader has moved off that edge, which re-arms
 * the reversal for when they scroll back to it deliberately.
 *
 * A chapter with nothing to scroll never clears — the reader cannot move off
 * an edge that is also the other edge. That is intended: the direction they
 * were travelling stays armed regardless, so they are never stuck, and going
 * back is a click on the affordance rather than a twitch of the wheel.
 */
export function clearPlacedEdge(
  placedAt: Arrival | null,
  atTop: boolean,
  atBottom: boolean,
): Arrival | null {
  if (placedAt === "top" && !atTop) return null;
  if (placedAt === "bottom" && !atBottom) return null;
  return placedAt;
}
