import { describe, expect, it } from "vitest";
import {
  createLineBank,
  glideStep,
  settleDelta,
  snapToLine,
  wheelDeltaToPixels,
} from "./lineScroll";

const LINE = 27.2; // the reader's real line box at fontSize 17 / lineHeight 1.6

describe("wheelDeltaToPixels", () => {
  it("passes pixel deltas through", () => {
    expect(wheelDeltaToPixels(13, 0)).toBe(13);
    expect(wheelDeltaToPixels(13)).toBe(13);
  });

  it("reads line-mode deltas as lines", () => {
    // A deltaY of 3 in line mode is about a notch, not 3px. Treated as pixels
    // it is below every sane threshold and the surface barely moves.
    expect(wheelDeltaToPixels(3, 1)).toBe(120);
  });

  it("reads page-mode deltas as pages", () => {
    expect(wheelDeltaToPixels(1, 2)).toBe(400);
  });
});

describe("snapToLine", () => {
  it("lands on the nearest whole line", () => {
    expect(snapToLine(0, LINE)).toBe(0);
    expect(snapToLine(13, LINE)).toBe(0);
    expect(snapToLine(15, LINE)).toBeCloseTo(LINE, 5);
    expect(snapToLine(LINE * 4 + 1, LINE)).toBeCloseTo(LINE * 4, 5);
  });

  it("leaves the position alone when there is no line box to snap to", () => {
    // Nothing rendered to measure — guessing a line box would move the
    // reader's position for no reason.
    expect(snapToLine(123.4, 0)).toBe(123.4);
  });
});

describe("settleDelta", () => {
  it("travels to the nearer boundary, never more than half a line", () => {
    expect(settleDelta(0, LINE)).toBe(0);
    // Just past a boundary: pull back.
    expect(settleDelta(2, LINE)).toBeCloseTo(-2, 5);
    // Most of the way to the next: push on.
    expect(settleDelta(25, LINE)).toBeCloseTo(LINE - 25, 5);
    for (const top of [0, 5, 13.5, 14, 27, 100, 1234.56]) {
      expect(Math.abs(settleDelta(top, LINE))).toBeLessThanOrEqual(LINE / 2 + 1e-9);
    }
  });

  it("does nothing without a line box", () => {
    expect(settleDelta(99, 0)).toBe(0);
  });
});

describe("glideStep", () => {
  it("closes a fraction of the gap each frame", () => {
    expect(glideStep(0, 100, 0.25)).toBe(25);
    expect(glideStep(25, 100, 0.25)).toBe(43.75);
  });

  it("lands exactly rather than crawling", () => {
    // Without this an exponential glide never arrives, and the loop never
    // stands down.
    expect(glideStep(99.9, 100, 0.22, 0.5)).toBe(100);
  });

  it("works in both directions", () => {
    expect(glideStep(100, 0, 0.25)).toBe(75);
  });

  it("converges in a bounded number of frames", () => {
    let at = 0;
    let frames = 0;
    while (at !== 1000 && frames < 200) {
      at = glideStep(at, 1000);
      frames += 1;
    }
    expect(at).toBe(1000);
    // ~35 frames at 60fps is a little over half a second for a huge jump;
    // an ordinary notch settles in a handful.
    expect(frames).toBeLessThan(60);
  });
});

describe("createLineBank", () => {
  it("spends nothing until a whole line has accumulated", () => {
    // The bug this exists to prevent: a 13px notch is 0.48 of a line, and
    // quantising it on its own yields zero — for ever. Measured before the
    // fix: twelve slow notches moved the page 0px against native's 156px.
    const bank = createLineBank();
    expect(bank.spend(13, LINE)).toBe(0); // 13 banked
    expect(bank.spend(13, LINE)).toBe(0); // 26 banked, still under a line
    expect(bank.spend(13, LINE)).toBeCloseTo(LINE, 5); // 39 → one line, 11.8 kept
  });

  it("preserves the total distance the device asked for", () => {
    const bank = createLineBank();
    let moved = 0;
    for (let i = 0; i < 12; i += 1) moved += bank.spend(13, LINE);
    const asked = 12 * 13;
    // Everything except the unspent remainder, which is under one line.
    expect(moved).toBeLessThanOrEqual(asked);
    expect(asked - moved).toBeLessThan(LINE);
    expect(moved % LINE).toBeCloseTo(0, 5);
  });

  it("spends several lines at once on a burst", () => {
    const bank = createLineBank();
    expect(bank.spend(209, LINE)).toBeCloseTo(LINE * 7, 5);
  });

  it("banks in both directions", () => {
    const bank = createLineBank();
    expect(bank.spend(-13, LINE)).toBe(0);
    expect(bank.spend(-13, LINE)).toBe(0);
    expect(bank.spend(-13, LINE)).toBeCloseTo(-LINE, 5);
  });

  it("does not swallow travel when reversing", () => {
    // Scroll down half a line, then back up: the reader should end where they
    // started, not half a line adrift.
    const bank = createLineBank();
    bank.spend(13, LINE);
    expect(bank.spend(-13, LINE)).toBe(0);
    expect(bank.spend(-LINE, LINE)).toBeCloseTo(-LINE, 5);
  });

  it("passes travel straight through with no line box", () => {
    const bank = createLineBank();
    expect(bank.spend(37, 0)).toBe(37);
  });

  it("forgets banked travel on reset", () => {
    const bank = createLineBank();
    bank.spend(20, LINE);
    bank.reset();
    expect(bank.spend(13, LINE)).toBe(0);
  });
});
