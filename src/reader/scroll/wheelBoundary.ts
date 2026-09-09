// Candidate wheel behaviours for the chapter boundary in scroll mode.
//
// The bug these exist to kill: in `DesktopReader`'s scroll mode a single
// mouse-wheel spin can advance three chapters. Four things compound —
//
//   1. the flip commits MID-gesture and nothing arms a lockout afterwards
//      (the paginated path has a 380ms cooldown; the scroll path has none),
//   2. a chapter shorter than the viewport satisfies the at-bottom test at
//      scrollTop 0, so it has no scroll distance to absorb the gesture and
//      is already at its own boundary the instant it mounts,
//   3. the 140px threshold is ~1.3 mouse notches (a notch is 100-120px of
//      deltaY in Chromium), and
//   4. the 280ms idle reset is refreshed by every event of a continuous
//      spin, so the whole spin reads as one unbroken intent.
//
// Each engine below is a self-contained answer, sharing one interface so the
// harness can swap them under a live reader and so the winner drops into
// DesktopReader as a contained change. Engines never touch the DOM: they take
// a wheel sample plus the scroller's edge state and return an intent.

export type Dir = "down" | "up";

export type EngineId = "baseline" | "lockout" | "rubberband" | "velocity";

/** Where the scroller is, and whether a chapter exists that way. */
export interface Edges {
  atTop: boolean;
  atBottom: boolean;
  canPrev: boolean;
  canNext: boolean;
}

export interface Sample {
  deltaY: number;
  /**
   * WheelEvent.deltaMode — 0 pixels, 1 lines, 2 pages. Omitted means pixels.
   * Not every device reports pixels, and a "line" counted as a pixel makes a
   * threshold ~40x too easy to reach.
   */
  deltaMode?: number;
  /** ms, monotonic. `performance.now()` in the app, a fake clock in tests. */
  t: number;
}

export interface Intent {
  /** Swallow the browser's own scroll/bounce for this event. */
  preventDefault: boolean;
  /** Edge being pushed against, or null when the gesture is ordinary scroll. */
  dir: Dir | null;
  /** 0..1 — how far the flip is armed. Drives the edge indicator. */
  pct: number;
  /** px to drag the page away from the edge (rubber band). */
  pull: number;
  /** Commit a chapter change, this direction, now. */
  flip: Dir | null;
  /** Animate to this state rather than snapping (spring-back, fade-out). */
  settle: boolean;
  /** One line on what the engine just decided, for the harness trace. */
  note: string;
}

export interface WheelEngine {
  readonly id: EngineId;
  /** A wheel event arrived. */
  onWheel(s: Sample, e: Edges): Intent;
  /** Idle pump (rAF or timer). Returns an intent only when state changed. */
  tick(t: number, e: Edges): Intent | null;
  /** The host tells the engine a chapter change actually landed. */
  didFlip(t: number): void;
  reset(): void;
}

const PASS: Intent = {
  preventDefault: false,
  dir: null,
  pct: 0,
  pull: 0,
  flip: null,
  settle: false,
  note: "scrolling",
};

function idle(note: string): Intent {
  return { ...PASS, settle: true, note };
}

/** Which boundary, if any, this event is pushing against. */
function pushDir(deltaY: number, e: Edges): Dir | null {
  if (deltaY > 0 && e.atBottom && e.canNext) return "down";
  if (deltaY < 0 && e.atTop && e.canPrev) return "up";
  return null;
}

// ---------------------------------------------------------------------------
// Baseline — today's shipped behaviour, ported from DesktopReader.tsx:447-518.
// Kept so the harness measures against the real thing instead of a memory of
// it. This is the engine that skips three chapters.
// ---------------------------------------------------------------------------

export function baselineEngine(): WheelEngine {
  const THRESHOLD = 140;
  const RELEASE_MS = 280;
  let acc = 0;
  let dir: Dir | null = null;
  let lastEvent = 0;

  const reset = () => {
    acc = 0;
    dir = null;
  };

  return {
    id: "baseline",
    reset,
    // Today's code has no post-flip hook at all — that absence IS the bug,
    // so the baseline deliberately does nothing here.
    didFlip() {},
    onWheel(s, e) {
      lastEvent = s.t;
      const d = pushDir(s.deltaY, e);
      if (d === null) {
        if (dir !== null) reset();
        return PASS;
      }
      if (dir !== d) {
        dir = d;
        acc = 0;
      }
      // Note the arrival event pays into the accumulator immediately, and
      // nothing checks how long we have been at the edge.
      acc = Math.min(THRESHOLD * 1.05, acc + Math.abs(s.deltaY));
      const pct = Math.min(1, acc / THRESHOLD);
      if (acc >= THRESHOLD) {
        const flip = dir;
        reset();
        return {
          preventDefault: true,
          dir: flip,
          pct: 1,
          pull: 0,
          flip,
          settle: false,
          note: `140px reached mid-gesture — flip ${flip}`,
        };
      }
      return {
        preventDefault: true,
        dir,
        pct,
        pull: 0,
        flip: null,
        settle: false,
        note: `arming ${Math.round(acc)}/${THRESHOLD}px`,
      };
    },
    tick(t) {
      if (dir === null) return null;
      if (t - lastEvent < RELEASE_MS) return null;
      reset();
      return idle("idle 280ms — indicator faded");
    },
  };
}

// ---------------------------------------------------------------------------
// A — Gesture lockout + edge dwell.
//
// One flip per gesture, guaranteed: after a flip, boundary input is dead until
// the wheel has been quiet for QUIET_MS, so the tail of the spin that caused
// the flip can never pay for the next one. The event that CARRIES you to the
// edge is also free, and a short dwell follows it, so arriving at a boundary
// is never itself most of a flip — which is what makes short chapters safe.
// ---------------------------------------------------------------------------

export function lockoutEngine(): WheelEngine {
  const THRESHOLD = 320; // ~3 mouse notches of deliberate push
  const DWELL_MS = 90; // must hold the edge this long before arming
  const QUIET_MS = 400; // silence that ends a gesture and lifts the lock
  const FADE_MS = 280;

  let acc = 0;
  let dir: Dir | null = null;
  let edgeSince = 0;
  let lastEvent = 0;
  let locked = false;

  const soft = () => {
    acc = 0;
    dir = null;
  };

  return {
    id: "lockout",
    reset() {
      soft();
      locked = false;
    },
    didFlip(t) {
      soft();
      locked = true;
      lastEvent = t;
    },
    onWheel(s, e) {
      lastEvent = s.t;
      const d = pushDir(s.deltaY, e);
      if (d === null) {
        if (dir !== null) soft();
        return PASS;
      }
      // Hold the browser's bounce even while locked, otherwise the swallowed
      // gesture leaks into a rubber-band flash at the window edge.
      if (locked) {
        return {
          ...PASS,
          preventDefault: true,
          note: "locked — same gesture still running",
        };
      }
      if (dir !== d) {
        dir = d;
        acc = 0;
        edgeSince = s.t;
        return {
          preventDefault: true,
          dir,
          pct: 0,
          pull: 0,
          flip: null,
          settle: false,
          note: "reached the edge — this event is free",
        };
      }
      if (s.t - edgeSince < DWELL_MS) {
        return {
          preventDefault: true,
          dir,
          pct: 0,
          pull: 0,
          flip: null,
          settle: false,
          note: `dwell ${Math.round(s.t - edgeSince)}/${DWELL_MS}ms`,
        };
      }
      acc += Math.abs(s.deltaY);
      if (acc >= THRESHOLD) {
        const flip = dir;
        return {
          preventDefault: true,
          dir: flip,
          pct: 1,
          pull: 0,
          flip,
          settle: false,
          note: `pushed ${THRESHOLD}px past the edge — flip ${flip}`,
        };
      }
      return {
        preventDefault: true,
        dir,
        pct: Math.min(1, acc / THRESHOLD),
        pull: 0,
        flip: null,
        settle: false,
        note: `arming ${Math.round(acc)}/${THRESHOLD}px`,
      };
    },
    tick(t) {
      if (locked) {
        if (t - lastEvent < QUIET_MS) return null;
        locked = false;
        return idle(`quiet ${QUIET_MS}ms — gesture ended, unlocked`);
      }
      if (dir === null) return null;
      if (t - lastEvent < FADE_MS) return null;
      soft();
      return idle("released short — indicator faded");
    },
  };
}

// ---------------------------------------------------------------------------
// B — Rubber band, commit on release.
//
// Nothing commits while wheel events are arriving. The page drags back against
// the wheel on a real rubber-band curve, and the flip lands only once the wheel
// has gone quiet, and only if the pull got past the line.
//
// Two things the harness taught this engine, neither of which was obvious:
//
//   - Releasing must DECAY the stretch, not discard it. A reader spinning a
//     mouse wheel slowly leaves 250ms between notches, which is longer than
//     the release window — with a hard reset, every notch was its own gesture
//     and released short, so a slow deliberate push could never turn the page
//     at all. The band now bleeds off over ~1s, so consecutive slow notches
//     still add up the way the reader expects them to.
//   - "Commit on release cannot chain" is only true of a FAST spin. On a slow
//     continuous scroll the wheel goes quiet between notches often enough to
//     commit repeatedly, so this engine needs the same post-flip quiet lock as
//     A and D. The interaction shape alone does not save it.
// ---------------------------------------------------------------------------

export function rubberBandEngine(): WheelEngine {
  const COMMIT = 240; // px of accumulated delta needed at release
  const MAX_PULL = 76; // px the page can be dragged off its edge
  const STIFFNESS = 210; // rubber-band curve constant
  const RELEASE_MS = 180; // silence that counts as letting go
  const DECAY_PER_MS = 0.25; // px of stretch bled off per ms once released
  const QUIET_MS = 400; // silence that ends a gesture and lifts the lock

  let acc = 0;
  let dir: Dir | null = null;
  let lastEvent = 0;
  let released = false;
  let lastDecay = 0;
  let locked = false;

  const soft = () => {
    acc = 0;
    dir = null;
    released = false;
  };

  /** Diminishing-returns pull, so the band stiffens as it stretches. */
  const pullFor = (a: number) => MAX_PULL * (1 - Math.exp(-a / STIFFNESS));

  return {
    id: "rubberband",
    reset() {
      soft();
      locked = false;
    },
    didFlip(t) {
      soft();
      locked = true;
      lastEvent = t;
    },
    onWheel(s, e) {
      lastEvent = s.t;
      const d = pushDir(s.deltaY, e);
      if (d === null) {
        if (dir !== null) {
          soft();
          return idle("left the edge — band released");
        }
        return PASS;
      }
      if (locked) {
        return {
          ...PASS,
          preventDefault: true,
          note: "locked — same gesture still running",
        };
      }
      if (dir !== d) {
        dir = d;
        acc = 0;
      }
      released = false;
      acc += Math.abs(s.deltaY);
      const pct = Math.min(1, acc / COMMIT);
      return {
        preventDefault: true,
        dir,
        pct,
        pull: pullFor(acc),
        flip: null,
        settle: false,
        note:
          pct >= 1
            ? "past the line — let go to turn"
            : `stretching ${Math.round(acc)}/${COMMIT}px`,
      };
    },
    tick(t) {
      if (locked) {
        if (t - lastEvent < QUIET_MS) return null;
        locked = false;
        return idle(`quiet ${QUIET_MS}ms — gesture ended, unlocked`);
      }
      if (dir === null) return null;
      if (t - lastEvent < RELEASE_MS) return null;

      if (!released) {
        if (acc >= COMMIT) {
          const flip = dir;
          soft();
          return {
            preventDefault: false,
            dir: flip,
            pct: 0,
            pull: 0,
            flip,
            settle: true,
            note: `released past the line — flip ${flip}`,
          };
        }
        // Let go short: the band springs back, but how hard the reader has
        // been pushing bleeds off rather than vanishing.
        released = true;
        lastDecay = t;
        return {
          preventDefault: false,
          dir,
          pct: Math.min(1, acc / COMMIT),
          pull: 0,
          flip: null,
          settle: true,
          note: `released short at ${Math.round(acc)}px — bleeding off`,
        };
      }

      acc -= DECAY_PER_MS * (t - lastDecay);
      lastDecay = t;
      if (acc > 0) return null;
      soft();
      return idle("stretch fully bled off");
    },
  };
}

// ---------------------------------------------------------------------------
// D — Velocity-aware threshold, on top of A's lockout. The candidate that won.
//
// The idea it started from: a fast flick has to travel further than a slow
// deliberate push, so a flick that overshoots the end of a chapter does not
// read as a request for the next one. Four things were wrong with the first
// version, and the harness found all four:
//
//   1. It measured intent in PIXELS. Pixels per wheel notch are not a
//      constant — 100-120px in Chromium on macOS, ~100 on Windows, "lines"
//      rather than pixels when deltaMode is 1, and the OS wheel-speed slider
//      scales all of it by up to 3x. A 320px threshold is three notches on one
//      machine and one on another. It now measures in NOTCHES, with the notch
//      size learned from the device's own event stream.
//   2. The threshold was frozen at the instant the edge was reached, so a
//      reader who arrived fast and then settled into a deliberate push was
//      still held to the flick's high bar for the rest of the gesture. The
//      requirement is now re-read continuously and only ever falls: slowing
//      down at the edge IS the expression of intent.
//   3. Coasting was detected by three strictly-decreasing samples, which a
//      real momentum tail rarely is — it wobbles. It now compares a smoothed
//      magnitude against the gesture's peak, so a noisy tail is still caught.
//   4. Turning several chapters on purpose was punishingly expensive, because
//      every turn cost full deliberation. A push that follows a completed turn
//      within REPEAT_MS — and only across a real gesture break, never inside
//      one — now needs less, since the reader has already said what they want.
// ---------------------------------------------------------------------------

export function velocityEngine(): WheelEngine {
  /** Notches of push past the edge, when the wheel is barely moving. */
  const MIN_NOTCHES = 1.6;
  /** Notches of push past the edge, at full flick speed. */
  const MAX_NOTCHES = 4.6;
  /** Wheel speed treated as "flicking", in notches/sec. */
  const FAST_NOTCHES_PER_S = 14;
  const QUIET_MS = 400; // silence that ends a gesture and lifts the lock
  const FADE_MS = 280;
  const COAST_RATIO = 0.45; // smoothed magnitude below this share of peak
  const COAST_MIN_MS = 120; // ...for at least this long into the gesture
  /** Notches of arming lost per second once the reader lets go. */
  const DECAY_NOTCHES_PER_S = 1.2;
  const REPEAT_MS = 1600; // a follow-up push still counts as the same intent
  const REPEAT_DISCOUNT = 0.6;
  const EMA_ALPHA = 0.35;
  const DEFAULT_NOTCH_PX = 110; // also what a trackpad's travel is scored at
  const MIN_NOTCH_PX = 60;
  const MAX_NOTCH_PX = 240;
  const WINDOW = 5; // samples kept for the speed estimate

  let notchPx = DEFAULT_NOTCH_PX;
  let notchLearned = false;
  let bleeding = false;
  let lastBleed = 0;
  let acc = 0; // notches pushed past the edge
  let need = MAX_NOTCHES;
  let dir: Dir | null = null;
  let lastEvent = 0;
  let edgeSince = 0;
  let locked = false;
  let peak = 0; // px, this gesture's largest single delta
  let ema = 0; // px, smoothed delta magnitude
  let recent: { px: number; t: number }[] = [];
  let lastFlipAt = -Infinity;
  let discounted = false;

  /** Wheel deltas arrive in pixels, lines or pages. Normalise to pixels. */
  const toPx = (s: Sample) => {
    const mode = s.deltaMode ?? 0;
    if (mode === 1) return s.deltaY * 40; // Chromium's own lines→px factor
    if (mode === 2) return s.deltaY * 400; // a page, roughly a viewport
    return s.deltaY;
  };

  /**
   * Learn this device's notch size. Only events that look like a discrete
   * detent teach it — big enough to be a notch, and spaced far enough apart
   * that they are not one trackpad flick's worth of pixel dribble. A trackpad
   * therefore keeps the default, which scores its continuous travel at a
   * sensible px-per-notch instead of pretending it has detents.
   */
  const learnNotch = (px: number, gapMs: number) => {
    const mag = Math.abs(px);
    if (mag < 40 || gapMs < 25) return;
    const clamped = Math.min(MAX_NOTCH_PX, Math.max(MIN_NOTCH_PX, mag));
    // Seed from the FIRST detent seen rather than easing toward it. Easing
    // in at a quarter per event meant a 60px-per-notch mouse was still being
    // scored against 97px several notches later, so the same physical spin
    // bought a different amount of progress depending on how recently the
    // engine had been reset.
    notchPx = notchLearned ? notchPx + 0.5 * (clamped - notchPx) : clamped;
    notchLearned = true;
  };

  /** Wheel speed over the retained window, in notches/sec. */
  const speed = () => {
    if (recent.length < 2) return 0;
    const span = recent[recent.length - 1].t - recent[0].t;
    if (span <= 0) return 0;
    let travelled = 0;
    for (let i = 1; i < recent.length; i += 1) travelled += Math.abs(recent[i].px);
    return travelled / notchPx / (span / 1000);
  };

  /** What this gesture has to spend, at the speed it is moving right now. */
  const requirement = () => {
    const v = Math.min(1, speed() / FAST_NOTCHES_PER_S);
    return MIN_NOTCHES + (MAX_NOTCHES - MIN_NOTCHES) * v;
  };

  /** A momentum tail: smoothed magnitude well under the gesture's peak. */
  const coasting = (t: number) =>
    peak > 0 && t - edgeSince > COAST_MIN_MS && ema < peak * COAST_RATIO;

  const soft = () => {
    acc = 0;
    dir = null;
    need = MAX_NOTCHES;
    discounted = false;
    bleeding = false;
  };

  const endGesture = () => {
    peak = 0;
    ema = 0;
    recent = [];
  };

  return {
    id: "velocity",
    reset() {
      soft();
      endGesture();
      locked = false;
      lastFlipAt = -Infinity;
      notchPx = DEFAULT_NOTCH_PX;
      notchLearned = false;
    },
    didFlip(t) {
      soft();
      locked = true;
      lastEvent = t;
      lastFlipAt = t;
    },
    onWheel(s, e) {
      const px = toPx(s);
      const gap = s.t - lastEvent;
      lastEvent = s.t;
      learnNotch(px, gap);

      // Speed has to be tracked through ordinary scrolling too, or the speed
      // of the gesture that reached the edge is unknown at the edge.
      recent.push({ px, t: s.t });
      if (recent.length > WINDOW) recent.shift();
      peak = Math.max(peak, Math.abs(px));
      ema = ema === 0 ? Math.abs(px) : ema + EMA_ALPHA * (Math.abs(px) - ema);

      const d = pushDir(px, e);
      if (d === null) {
        if (dir !== null) soft();
        return PASS;
      }
      // Hold the browser's bounce even while locked, otherwise the swallowed
      // gesture leaks into a rubber-band flash at the window edge.
      if (locked) {
        return {
          ...PASS,
          preventDefault: true,
          note: "locked — same gesture still running",
        };
      }

      if (dir !== d) {
        // Arrival. This event is free: it is the one that carried the reader
        // to the edge, and charging for it is how a chapter too short to
        // scroll ends up paying for its own exit.
        dir = d;
        acc = 0;
        bleeding = false;
        edgeSince = s.t;
        // With fewer than two samples there is no speed to read yet — a
        // reader who paused at the edge and then flicked arrives with no
        // history at all. Start at the flick price and let the requirement
        // FALL as real speed becomes measurable; starting at the floor
        // instead let a flick from rest turn the page in two notches.
        need = recent.length >= 2 ? requirement() : MAX_NOTCHES;
        discounted = s.t - lastFlipAt < REPEAT_MS;
        if (discounted) need = Math.max(1, need * REPEAT_DISCOUNT);
        return {
          preventDefault: true,
          dir,
          pct: 0,
          pull: 0,
          flip: null,
          settle: false,
          note: `edge at ${speed().toFixed(1)} notch/s — needs ${need.toFixed(1)}${
            discounted ? " (repeat)" : ""
          }`,
        };
      }

      if (coasting(s.t)) {
        return {
          preventDefault: true,
          dir,
          pct: Math.min(1, acc / need),
          pull: 0,
          flip: null,
          settle: false,
          note: `coasting (${Math.round(ema)} < ${Math.round(peak * COAST_RATIO)}px) — ignored`,
        };
      }

      bleeding = false;
      // Re-read the requirement every event, and only ever let it fall.
      // Slowing down at the edge is the reader saying "I mean this"; having
      // arrived fast should not hold them to the flick's price forever.
      let now = requirement();
      if (discounted) now = Math.max(1, now * REPEAT_DISCOUNT);
      need = Math.min(need, now);

      acc += Math.abs(px) / notchPx;
      if (acc >= need) {
        const flip = dir;
        return {
          preventDefault: true,
          dir: flip,
          pct: 1,
          pull: 0,
          flip,
          settle: false,
          note: `${acc.toFixed(1)} notches past the edge — flip ${flip}`,
        };
      }
      return {
        preventDefault: true,
        dir,
        pct: Math.min(1, acc / need),
        pull: 0,
        flip: null,
        settle: false,
        note: `arming ${acc.toFixed(1)}/${need.toFixed(1)} notches`,
      };
    },
    tick(t) {
      if (locked) {
        if (t - lastEvent < QUIET_MS) return null;
        locked = false;
        endGesture();
        return idle(`quiet ${QUIET_MS}ms — gesture ended, unlocked`);
      }
      if (dir === null) {
        // A gesture that never reached an edge still has to end, or its peak
        // leaks into the next one and the coast detector mis-fires.
        if (peak !== 0 && t - lastEvent >= QUIET_MS) endGesture();
        return null;
      }

      // Only real silence ends the gesture. Two separate windows matter here,
      // and collapsing them into one is what made a slow deliberate push
      // impossible to perform:
      //
      //   FADE_MS  — the pill has stopped being useful, so fade it and start
      //              bleeding the arming off.
      //   QUIET_MS — the reader has actually let go, so forget everything.
      //
      // A reader turning a wheel steadily but slowly leaves ~300ms between
      // notches, which is longer than the fade but shorter than real silence.
      // Tearing the arming down at the fade meant every notch arrived as a
      // fresh edge, and a fresh arrival is deliberately free — so the total
      // never grew and the chapter could never turn, however long they
      // scrolled. Between the two windows the arming stays armed.
      if (t - lastEvent >= QUIET_MS) {
        soft();
        endGesture();
        return idle(`quiet ${QUIET_MS}ms — let go, arming dropped`);
      }
      if (t - lastEvent < FADE_MS) return null;

      if (!bleeding) {
        bleeding = true;
        lastBleed = t;
        return {
          preventDefault: false,
          dir,
          pct: Math.min(1, acc / need),
          pull: 0,
          flip: null,
          settle: true,
          note: `paused at ${acc.toFixed(1)} notches — bleeding off`,
        };
      }
      acc = Math.max(0, acc - DECAY_NOTCHES_PER_S * ((t - lastBleed) / 1000));
      lastBleed = t;
      return null;
    },
  };
}

export interface EngineSpec {
  id: EngineId;
  name: string;
  /** One line for the picker. */
  tagline: string;
  /** What it does differently, and what it costs. */
  detail: string;
  create: () => WheelEngine;
}

export const ENGINES: readonly EngineSpec[] = [
  {
    id: "baseline",
    name: "Today",
    tagline: "140px accumulator, flips mid-gesture, no lockout",
    detail:
      "The shipped behaviour. One spin can flip repeatedly because the flip commits mid-gesture and the chapter it lands in is already at its own boundary.",
    create: baselineEngine,
  },
  {
    id: "lockout",
    name: "A · Gesture lockout",
    tagline: "One flip per gesture · 320px push · free arrival event",
    detail:
      "After a flip, boundary input is dead until the wheel is quiet 400ms, so the rest of the spin cannot spend on the next chapter. The event that reached the edge is free, then a 90ms dwell, then 320px of deliberate push.",
    create: lockoutEngine,
  },
  {
    id: "rubberband",
    name: "B · Pull and release",
    tagline: "Page drags back · flip commits when you let go",
    detail:
      "Nothing commits while events are arriving. The page rubber-bands against the wheel and turns on release, if you got past the line, and the stretch bleeds off over ~1s so a slow deliberate push still adds up. Costs a beat of latency, and a long trackpad momentum tail delays the commit.",
    create: rubberBandEngine,
  },
  {
    id: "velocity",
    name: "D · Velocity-aware",
    tagline: "Measured in notches · bar falls as you slow · repeat is cheaper",
    detail:
      "A's lockout plus a requirement that scales 1.6→4.6 wheel notches with speed, so overshooting the end of a chapter at pace is not read as asking for the next one. Notch size is learned from the device, so the feel survives a different mouse or OS wheel setting. The bar is re-read every event and only falls, so arriving fast and then pushing deliberately works. Momentum tails are dropped, and a follow-up push within 1.6s of a turn costs 40% less.",
    create: velocityEngine,
  },
] as const;
