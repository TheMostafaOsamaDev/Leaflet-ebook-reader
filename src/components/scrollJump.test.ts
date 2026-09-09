import { describe, expect, it } from "vitest";
import { jumpScrollTop, type Scrollable } from "./scrollJump";

/** Records every value assigned, so the whole sequence can be asserted. */
function tracker(initial = 0, max = Infinity) {
  const seen: number[] = [];
  const el: Scrollable = {
    get scrollTop() {
      return seen.length ? seen[seen.length - 1] : initial;
    },
    set scrollTop(v: number) {
      // Clamp the way a real scroller does.
      seen.push(Math.max(0, Math.min(max, v)));
    },
  };
  return { el, seen };
}

/** Runs scheduled callbacks immediately, so frames are deterministic. */
const now = (fn: () => void) => fn();

describe("jumpScrollTop", () => {
  it("lands on the requested position", () => {
    const { el, seen } = tracker();
    jumpScrollTop(el, 9741, now);
    expect(seen[0]).toBe(9741);
    expect(el.scrollTop).toBe(9741);
  });

  it("nudges one pixel and back, so the region is painted", () => {
    // The jump alone leaves WKWebView with an untiled region and a blank
    // window; a real one-pixel scroll is what invalidates it.
    const { el, seen } = tracker();
    jumpScrollTop(el, 9741, now);
    expect(seen).toEqual([9741, 9740, 9741]);
  });

  it("does not nudge when jumping to the top", () => {
    // Tiles at 0 are already there, and 0 - 1 would clamp back to 0 without
    // generating a scroll anyway.
    const { el, seen } = tracker();
    jumpScrollTop(el, 0, now);
    expect(seen).toEqual([0]);
  });

  it("nudges from where the browser actually landed, not the request", () => {
    // `scrollTop = scrollHeight` is the idiom for "go to the end", and the
    // browser clamps it. Nudging from the requested value would scroll the
    // page to a position the reader never asked for.
    const { el, seen } = tracker(0, 2403);
    jumpScrollTop(el, 99999, now);
    expect(seen).toEqual([2403, 2402, 2403]);
    expect(el.scrollTop).toBe(2403);
  });

  it("ends where it started, however the frames interleave", () => {
    const { el } = tracker(0, 5000);
    const queue: (() => void)[] = [];
    jumpScrollTop(el, 4000, (fn) => queue.push(fn));
    // The jump is applied immediately; the nudge waits for frames.
    expect(el.scrollTop).toBe(4000);
    while (queue.length) queue.shift()!();
    expect(el.scrollTop).toBe(4000);
  });
});
