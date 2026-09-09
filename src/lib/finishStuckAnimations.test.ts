import { describe, expect, it } from "vitest";
import {
  finishStuckAnimations,
  type AnimatedHost,
  type AnimationLike,
} from "./finishStuckAnimations";

function anim(playState: string, iterations: number | undefined = 1) {
  let finished = false;
  const a: AnimationLike & { finished: () => boolean } = {
    playState,
    effect: { getComputedTiming: () => ({ iterations }) },
    finish() {
      finished = true;
    },
    finished: () => finished,
  };
  return a;
}

function host(...animations: AnimationLike[]): AnimatedHost {
  return { getAnimations: () => animations };
}

describe("finishStuckAnimations", () => {
  it("lands a running animation on its end state", () => {
    // The stranded case: mounted while the document was hidden, still on its
    // first keyframe at opacity 0.
    const a = anim("running");
    expect(finishStuckAnimations(host(a))).toBe(1);
    expect(a.finished()).toBe(true);
  });

  it("leaves finished and idle animations alone", () => {
    const done = anim("finished");
    const idle = anim("idle");
    expect(finishStuckAnimations(host(done, idle))).toBe(0);
    expect(done.finished()).toBe(false);
    expect(idle.finished()).toBe(false);
  });

  it("skips endless animations", () => {
    // finish() throws on an infinite effect, and a shimmer has no end state.
    const shimmer = anim("running", Infinity);
    expect(finishStuckAnimations(host(shimmer))).toBe(0);
    expect(shimmer.finished()).toBe(false);
  });

  it("survives an animation that throws on finish", () => {
    const bad: AnimationLike = {
      playState: "running",
      effect: { getComputedTiming: () => ({ iterations: 1 }) },
      finish() {
        throw new Error("nope");
      },
    };
    const good = anim("running");
    expect(finishStuckAnimations(host(bad, good))).toBe(1);
    expect(good.finished()).toBe(true);
  });

  it("survives a host without getAnimations support", () => {
    const legacy = {
      getAnimations() {
        throw new Error("unsupported");
      },
    };
    expect(finishStuckAnimations(legacy)).toBe(0);
  });

  it("does nothing without a host", () => {
    expect(finishStuckAnimations(null)).toBe(0);
  });
});
