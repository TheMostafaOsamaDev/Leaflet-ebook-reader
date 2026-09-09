import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isReducedMotion,
  setReduceMotionOverride,
  subscribeReducedMotion,
} from "./motion";

afterEach(() => setReduceMotionOverride("auto"));

describe("isReducedMotion", () => {
  // The non-React accessor exists so modules outside the component tree (the
  // overlay scrollbar controller) honour the in-app Reduce motion setting
  // rather than only the OS query. Without it, turning Reduce motion on left
  // that surface still animating.
  it("follows the app-level override in both directions", () => {
    setReduceMotionOverride("on");
    expect(isReducedMotion()).toBe(true);
    setReduceMotionOverride("off");
    expect(isReducedMotion()).toBe(false);
  });

  it("defers to the OS query when the override is auto", () => {
    // No `window` in this environment, so the OS half reads as no-preference.
    setReduceMotionOverride("auto");
    expect(isReducedMotion()).toBe(false);
  });
});

describe("subscribeReducedMotion", () => {
  it("fires on override changes and stops after unsubscribe", () => {
    const seen = vi.fn();
    const unsubscribe = subscribeReducedMotion(seen);

    setReduceMotionOverride("on");
    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    setReduceMotionOverride("off");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the preference is set to what it already was", () => {
    const seen = vi.fn();
    const unsubscribe = subscribeReducedMotion(seen);
    setReduceMotionOverride("auto");
    expect(seen).not.toHaveBeenCalled();
    unsubscribe();
  });
});
