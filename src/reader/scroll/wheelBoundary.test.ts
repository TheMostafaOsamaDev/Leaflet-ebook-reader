import { describe, expect, it } from "vitest";
import {
  baselineEngine,
  lockoutEngine,
  rubberBandEngine,
  velocityEngine,
  type Edges,
  type WheelEngine,
} from "./wheelBoundary";

/**
 * Replays one continuous mouse-wheel spin over a run of chapters that are
 * SHORTER THAN THE VIEWPORT — the case the user hit. A chapter that does not
 * fill the viewport is at its own bottom the instant it mounts, so every
 * chapter after the first flip reports `atBottom` on its very first event.
 *
 * `gapMs` is the spacing between notches; a real spin is 50-90ms apart, and a
 * discrete notch is 100-120px of deltaY in Chromium.
 */
function spinThroughShortChapters(
  engine: WheelEngine,
  { notches, gapMs, notch = 110 }: { notches: number; gapMs: number; notch?: number },
) {
  // Chapter 0 has already been read to the bottom; every chapter after it is
  // too short to scroll, so it is permanently at both edges.
  const edges: Edges = { atTop: true, atBottom: true, canPrev: true, canNext: true };
  const flipTimes: number[] = [];
  let t = 0;

  for (let i = 0; i < notches; i += 1) {
    t += gapMs;
    // The idle pump runs between events, exactly as rAF does in the app.
    const ticked = engine.tick(t, edges);
    if (ticked?.flip) {
      flipTimes.push(t);
      engine.didFlip(t);
    }
    const intent = engine.onWheel({ deltaY: notch, t }, edges);
    if (intent.flip) {
      flipTimes.push(t);
      engine.didFlip(t);
    }
  }

  // Let the gesture end, so release-on-commit engines get to commit.
  for (let i = 0; i < 12; i += 1) {
    t += 60;
    const ticked = engine.tick(t, edges);
    if (ticked?.flip) {
      flipTimes.push(t);
      engine.didFlip(t);
    }
  }

  const gaps = flipTimes.slice(1).map((v, i) => v - flipTimes[i]);
  return {
    flips: flipTimes.length,
    /** Flips landing under 600ms after the previous one — the bug signature. */
    accidental: gaps.filter((g) => g < 600).length,
  };
}

/** A deliberate ask: reach the edge, then keep pushing, with a real pause. */
function deliberatePush(engine: WheelEngine, notches: number, gapMs = 80) {
  const edges: Edges = { atTop: false, atBottom: true, canPrev: true, canNext: true };
  let t = 1000;
  let flips = 0;
  for (let i = 0; i < notches; i += 1) {
    t += gapMs;
    const ticked = engine.tick(t, edges);
    if (ticked?.flip) {
      flips += 1;
      engine.didFlip(t);
    }
    const intent = engine.onWheel({ deltaY: 110, t }, edges);
    if (intent.flip) {
      flips += 1;
      engine.didFlip(t);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    t += 60;
    const ticked = engine.tick(t, edges);
    if (ticked?.flip) {
      flips += 1;
      engine.didFlip(t);
    }
  }
  return flips;
}

/**
 * A slow but unbroken spin — ~250ms between notches, the pace of someone
 * turning a wheel steadily rather than flicking it. This is the case that
 * caught the rubber-band engine discarding its stretch between notches (it
 * could never turn the page) and caught it chaining once that was fixed (it
 * needed a post-flip lock after all).
 */
function slowSpinThroughShortChapters(engine: WheelEngine, notches: number) {
  return spinThroughShortChapters(engine, { notches, gapMs: 250 });
}

/** Deliberate push at a slow, human wheel pace. */
function deliberatePushSlow(engine: WheelEngine, notches: number) {
  return deliberatePush(engine, notches, 250);
}

describe("the bug, reproduced", () => {
  it("today's behaviour skips multiple chapters on one spin", () => {
    const result = spinThroughShortChapters(baselineEngine(), {
      notches: 8,
      gapMs: 60,
    });
    // This is the user's report: one spin, several chapters gone.
    expect(result.flips).toBeGreaterThanOrEqual(3);
    expect(result.accidental).toBeGreaterThanOrEqual(2);
  });
});

describe.each([
  ["A · lockout", lockoutEngine],
  ["B · rubber band", rubberBandEngine],
  ["D · velocity-aware", velocityEngine],
])("%s", (_name, create) => {
  it("never flips more than once in a single spin, however long", () => {
    for (const notches of [4, 8, 16, 30]) {
      const result = spinThroughShortChapters(create(), { notches, gapMs: 60 });
      expect(result.flips).toBeLessThanOrEqual(1);
      expect(result.accidental).toBe(0);
    }
  });

  it("survives a fast flick over short chapters without skipping", () => {
    const result = spinThroughShortChapters(create(), {
      notches: 12,
      gapMs: 35,
      notch: 160,
    });
    expect(result.flips).toBeLessThanOrEqual(1);
  });

  it("turns exactly once on a slow, unbroken spin", () => {
    // The wheel goes quiet between notches here, which is precisely when a
    // release-triggered commit is tempted to fire more than once.
    const result = slowSpinThroughShortChapters(create(), 14);
    expect(result.flips).toBeLessThanOrEqual(1);
    expect(result.accidental).toBe(0);
  });

  it("still turns the chapter when the push is deliberate", () => {
    // Six notches of sustained push past the edge has to be enough, or the
    // cure is worse than the disease.
    expect(deliberatePush(create(), 6)).toBe(1);
  });

  it("still turns the chapter for a reader who scrolls slowly", () => {
    // 250ms between notches — slower than every release/idle window in play,
    // so an engine that forgets between notches never turns the page at all.
    expect(deliberatePushSlow(create(), 8)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D specifically — the candidate being shipped, so its own claims get pinned.
// ---------------------------------------------------------------------------

describe("D · velocity-aware", () => {
  /** Push at the edge at a fixed pace, returning how many turns landed. */
  function pushAtEdge(
    engine: WheelEngine,
    { notches, gapMs, delta, deltaMode }: {
      notches: number;
      gapMs: number;
      delta: number;
      deltaMode?: number;
    },
  ) {
    const edges: Edges = { atTop: false, atBottom: true, canPrev: true, canNext: true };
    let t = 1000;
    let flips = 0;
    for (let i = 0; i < notches; i += 1) {
      t += gapMs;
      if (engine.tick(t, edges)?.flip) {
        flips += 1;
        engine.didFlip(t);
      }
      const intent = engine.onWheel({ deltaY: delta, deltaMode, t }, edges);
      if (intent.flip) {
        flips += 1;
        engine.didFlip(t);
      }
    }
    for (let i = 0; i < 10; i += 1) {
      t += 60;
      if (engine.tick(t, edges)?.flip) {
        flips += 1;
        engine.didFlip(t);
      }
    }
    return flips;
  }

  it("charges a flick more than a slow push", () => {
    // Same three notches past the edge. Flicked, it should not be enough;
    // pushed slowly, it should be.
    const flicked = pushAtEdge(velocityEngine(), { notches: 4, gapMs: 35, delta: 110 });
    const pushed = pushAtEdge(velocityEngine(), { notches: 4, gapMs: 300, delta: 110 });
    expect(flicked).toBe(0);
    expect(pushed).toBe(1);
  });

  it("lets the bar fall when a fast arrival settles into a real push", () => {
    // Arrive flicking, then keep going at a deliberate pace. Freezing the
    // requirement at the arrival speed used to strand this reader.
    const engine = velocityEngine();
    const edges: Edges = { atTop: false, atBottom: true, canPrev: true, canNext: true };
    let t = 1000;
    let flips = 0;
    const feed = (delta: number, gap: number) => {
      t += gap;
      if (engine.tick(t, edges)?.flip) {
        flips += 1;
        engine.didFlip(t);
      }
      const intent = engine.onWheel({ deltaY: delta, t }, edges);
      if (intent.flip) {
        flips += 1;
        engine.didFlip(t);
      }
    };
    for (let i = 0; i < 3; i += 1) feed(160, 30); // flicked in
    for (let i = 0; i < 3; i += 1) feed(110, 220); // then meant it
    expect(flips).toBe(1);
  });

  it("feels the same on a device with a different notch size", () => {
    // A machine whose wheel sends 60px per notch and one that sends 200px per
    // notch must need the same NUMBER of notches, not the same pixel count.
    for (const delta of [60, 110, 200]) {
      expect(pushAtEdge(velocityEngine(), { notches: 5, gapMs: 300, delta })).toBe(1);
      expect(pushAtEdge(velocityEngine(), { notches: 2, gapMs: 300, delta })).toBe(0);
    }
  });

  it("reads line-mode deltas as lines, not pixels", () => {
    // deltaMode 1 means lines; three lines is about a notch. Counted as
    // pixels, 3 would look like 3px and nothing would ever turn.
    expect(
      pushAtEdge(velocityEngine(), { notches: 5, gapMs: 300, delta: 3, deltaMode: 1 }),
    ).toBe(1);
  });

  it("turns for a slow scroller at every pace between the two windows", () => {
    // The real app found this: at 300ms between notches — past the 280ms
    // fade but short of the 400ms that means "let go" — the arming used to be
    // torn down every gap, so every notch arrived as a fresh (free) edge and
    // the chapter could never turn however long the reader scrolled. The
    // unit tests had only ever sampled 250ms, on the near side of the fade.
    for (const gapMs of [80, 150, 250, 300, 350, 390]) {
      expect(pushAtEdge(velocityEngine(), { notches: 8, gapMs, delta: 110 })).toBe(1);
    }
  });

  it("forgets the arming once the reader has really let go", () => {
    // Past QUIET_MS it must NOT still be armed, or a push abandoned minutes
    // ago would combine with an unrelated one later.
    expect(pushAtEdge(velocityEngine(), { notches: 8, gapMs: 700, delta: 110 })).toBe(0);
  });

  it("still cannot chain, even with the repeat discount live", () => {
    // The discount is the one addition that could reopen the bug, so this is
    // the same unbroken spin over short chapters, checked again.
    for (const gapMs of [35, 60, 250]) {
      const result = spinThroughShortChapters(velocityEngine(), { notches: 30, gapMs });
      expect(result.flips).toBeLessThanOrEqual(1);
      expect(result.accidental).toBe(0);
    }
  });

  it("makes a deliberate second turn cheaper than the first", () => {
    // Turn once, let the gesture end properly, then ask again: the follow-up
    // should cost less, because the reader has already said what they want.
    const engine = velocityEngine();
    const edges: Edges = { atTop: false, atBottom: true, canPrev: true, canNext: true };
    let t = 1000;
    const turns: number[] = [];
    const feed = (gap: number) => {
      t += gap;
      const ticked = engine.tick(t, edges);
      if (ticked?.flip) {
        turns.push(t);
        engine.didFlip(t);
      }
      const intent = engine.onWheel({ deltaY: 110, t }, edges);
      if (intent.flip) {
        turns.push(t);
        engine.didFlip(t);
      }
      return intent;
    };
    let firstCost = 0;
    while (turns.length === 0 && firstCost < 20) {
      feed(300);
      firstCost += 1;
    }
    // Let the lock lift — a real gesture break, which is what keeps this
    // discount from being the chaining bug in disguise.
    for (let i = 0; i < 10; i += 1) {
      t += 60;
      engine.tick(t, edges);
    }
    let secondCost = 0;
    while (turns.length === 1 && secondCost < 20) {
      feed(300);
      secondCost += 1;
    }
    expect(turns.length).toBe(2);
    expect(secondCost).toBeLessThan(firstCost);
  });
});
