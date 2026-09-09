/**
 * The minimum an element needs to expose for its animations to be inspected.
 * Narrowed to keep this testable without a DOM.
 */
export interface AnimatedHost {
  getAnimations(options?: { subtree?: boolean }): AnimationLike[];
}

export interface AnimationLike {
  playState: string;
  finish(): void;
  effect?: {
    getComputedTiming(): { iterations?: number };
  } | null;
}

/**
 * Force any animation inside `host` to its end state.
 *
 * WKWebView does not advance CSS animations while the document is hidden, yet
 * it still reports them as `running` — so an element that mounted while the
 * window was occluded holds its FIRST keyframe indefinitely. When that first
 * keyframe is `opacity: 0`, the result is content that is present, laid out and
 * hit-testable but invisible, and it stays that way until something wakes the
 * webview. That was a blank reading pane in this app, caught in its own log at
 * 2.5 seconds into a 280ms animation.
 *
 * The animation that caused it is gone, so this is insurance rather than the
 * fix: called when the document becomes visible again, it lands anything that
 * was queued while hidden, so no future entry animation can strand content.
 *
 * Endless animations — shimmer, spinners — are skipped: `finish()` throws on an
 * infinite effect, and they have no end state to land on anyway.
 *
 * Returns how many were finished, which is what the test asserts on.
 */
export function finishStuckAnimations(host: AnimatedHost | null): number {
  if (!host) return 0;
  let finished = 0;
  let animations: AnimationLike[];
  try {
    animations = host.getAnimations({ subtree: true });
  } catch {
    // Older engines without getAnimations — nothing to do, and nothing worth
    // breaking the reader over.
    return 0;
  }
  for (const a of animations) {
    if (a.playState !== "running") continue;
    const iterations = a.effect?.getComputedTiming().iterations;
    if (iterations === Infinity) continue;
    try {
      a.finish();
      finished += 1;
    } catch {
      // An animation that refuses to finish is not worth a thrown render.
    }
  }
  return finished;
}
