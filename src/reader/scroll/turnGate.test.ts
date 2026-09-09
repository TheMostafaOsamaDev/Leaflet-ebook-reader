import { describe, expect, it } from "vitest";
import { clearPlacedEdge, createTurnGate, directionIsArmed } from "./turnGate";

/**
 * One continuous spin over chapters too short to scroll — the case that used
 * to eat three chapters. Every chapter after the first is at its own edge the
 * instant it mounts, so its card is on screen immediately and the rest of the
 * spin is free to spend on it.
 */
function spinOverShortChapters(notches: number, gapMs: number, delta = 110) {
  const gate = createTurnGate();
  let t = 0;
  let turns = 0;
  for (let i = 0; i < notches; i += 1) {
    t += gapMs;
    if (gate.onWheel(delta, true, t)) {
      turns += 1;
      gate.didTurn(t);
    }
  }
  return turns;
}

describe("createTurnGate", () => {
  it("turns on a single notch past the edge", () => {
    // The card is the affordance, so the gesture does not also have to prove
    // intent the way the old velocity threshold made it.
    const gate = createTurnGate();
    expect(gate.onWheel(110, true, 1000)).toBe(true);
  });

  it("ignores input that is not at an edge", () => {
    const gate = createTurnGate();
    expect(gate.onWheel(110, false, 1000)).toBe(false);
  });

  it("ignores trackpad noise", () => {
    const gate = createTurnGate();
    expect(gate.onWheel(3, true, 1000)).toBe(false);
    expect(gate.onWheel(-2, true, 1020)).toBe(false);
  });

  it("turns exactly once per gesture, however long the spin", () => {
    for (const notches of [4, 12, 30, 80]) {
      expect(spinOverShortChapters(notches, 60)).toBe(1);
    }
  });

  it("holds through a slow spin, where a cooldown would have chained", () => {
    // 250ms between notches is slower than any plausible cooldown but is
    // still one unbroken gesture. A fixed timer would let this turn on every
    // expiry; silence is what distinguishes a gesture from a new request.
    expect(spinOverShortChapters(40, 250)).toBe(1);
  });

  it("holds through a spin whose gaps sit just under the quiet threshold", () => {
    expect(spinOverShortChapters(20, 399)).toBe(1);
  });

  it("turns again once the reader has actually stopped", () => {
    const gate = createTurnGate();
    let turns = 0;
    const feed = (t: number) => {
      if (gate.onWheel(110, true, t)) {
        turns += 1;
        gate.didTurn(t);
      }
    };
    feed(1000); // turn
    feed(1060); // same gesture, locked
    feed(1120);
    feed(2000); // 880ms later: a new request
    expect(turns).toBe(2);
  });

  it("counts the quiet gap from the last event, not the last turn", () => {
    // A gesture that keeps going after a turn must not unlock just because
    // enough time has passed SINCE THE TURN.
    const gate = createTurnGate({ quietMs: 400 });
    let turns = 0;
    let t = 0;
    for (let i = 0; i < 20; i += 1) {
      t += 300; // never quiet, but far past 400ms since the turn
      if (gate.onWheel(110, true, t)) {
        turns += 1;
        gate.didTurn(t);
      }
    }
    expect(turns).toBe(1);
  });

  it("clears on reset, for a chapter change from somewhere else", () => {
    const gate = createTurnGate();
    gate.didTurn(1000);
    expect(gate.onWheel(110, true, 1050)).toBe(false);
    gate.reset();
    expect(gate.onWheel(110, true, 1100)).toBe(true);
  });
});

describe("wheel delta units", () => {
  it("reads line-mode deltas as lines, not pixels", () => {
    // deltaMode 1 means LINES: a deltaY of 3 is about a notch, not 3px.
    // Compared raw against the 8px minimum it was rejected outright, so the
    // reader could scroll at a chapter edge forever and nothing would turn.
    // This is the regression that shipped when the velocity engine — which
    // did normalise deltaMode — was replaced.
    const gate = createTurnGate();
    expect(gate.onWheel(3, true, 1000, 1)).toBe(true);
  });

  it("reads page-mode deltas as pages", () => {
    const gate = createTurnGate();
    expect(gate.onWheel(1, true, 1000, 2)).toBe(true);
  });

  it("still rejects genuine noise in every unit", () => {
    // A tenth of a line is inertia dribble, not a request.
    expect(createTurnGate().onWheel(0.1, true, 1000, 1)).toBe(false);
    expect(createTurnGate().onWheel(3, true, 1000, 0)).toBe(false);
  });

  it("treats a missing deltaMode as pixels", () => {
    expect(createTurnGate().onWheel(110, true, 1000)).toBe(true);
    expect(createTurnGate().onWheel(3, true, 1000)).toBe(false);
  });
});

describe("the arrival guard", () => {
  it("disarms the move that would undo the arrival", () => {
    // Landed on the last pixel after going back: scrolling down to read must
    // not throw them forward again.
    expect(directionIsArmed("bottom", "next")).toBe(false);
    // Landed on the first pixel after going forward: scrolling up must not
    // throw them back.
    expect(directionIsArmed("top", "prev")).toBe(false);
  });

  it("leaves the direction they were travelling armed", () => {
    // Came back a chapter and kept going back: that is not a reversal.
    expect(directionIsArmed("bottom", "prev")).toBe(true);
    expect(directionIsArmed("top", "next")).toBe(true);
  });

  it("arms everything once no arrival is outstanding", () => {
    expect(directionIsArmed(null, "next")).toBe(true);
    expect(directionIsArmed(null, "prev")).toBe(true);
  });

  it("still guards a chapter shorter than the viewport", () => {
    // The case that defeated the first version: a two-paragraph chapter is at
    // its top AND its bottom, so "which edge" cannot tell continuing from
    // reversing. Direction can. Measured in the app: atTop and atBottom both
    // true, armed, and the reader thrown straight back out.
    expect(directionIsArmed("top", "prev")).toBe(false);
    expect(directionIsArmed("top", "next")).toBe(true);
    expect(directionIsArmed("bottom", "next")).toBe(false);
    expect(directionIsArmed("bottom", "prev")).toBe(true);
  });

  it("re-arms once the reader leaves the arrival edge", () => {
    expect(clearPlacedEdge("bottom", false, false)).toBe(null);
    expect(clearPlacedEdge("top", false, false)).toBe(null);
  });

  it("keeps the arrival while the reader still stands on it", () => {
    expect(clearPlacedEdge("bottom", false, true)).toBe("bottom");
    expect(clearPlacedEdge("top", true, false)).toBe("top");
  });

  it("never clears in an unscrollable chapter, which is why direction matters", () => {
    expect(clearPlacedEdge("top", true, true)).toBe("top");
    expect(clearPlacedEdge("bottom", true, true)).toBe("bottom");
  });
});
