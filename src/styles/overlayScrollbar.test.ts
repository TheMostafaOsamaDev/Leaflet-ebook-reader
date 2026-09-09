import { describe, expect, it } from "vitest";
import { BAR, thumbGeometry, type ScrollMetrics } from "./overlayScrollbar";

/** A 400x600 container at (100, 50) holding 2400px of content. */
function metrics(over: Partial<ScrollMetrics> = {}): ScrollMetrics {
  return {
    scrollTop: 0,
    scrollHeight: 2400,
    clientHeight: 600,
    top: 50,
    left: 100,
    width: 400,
    height: 600,
    direction: "ltr",
    ...over,
  };
}

describe("thumbGeometry", () => {
  it("returns null when the content fits", () => {
    expect(thumbGeometry(metrics({ scrollHeight: 600 }))).toBeNull();
    // Within the 2px slack that guards sub-pixel layout rounding.
    expect(thumbGeometry(metrics({ scrollHeight: 601 }))).toBeNull();
  });

  it("returns null for a collapsed container", () => {
    expect(thumbGeometry(metrics({ height: 0, clientHeight: 0 }))).toBeNull();
    expect(thumbGeometry(metrics({ width: 0 }))).toBeNull();
  });

  it("sizes the thumb in proportion to the visible fraction", () => {
    const track = 600 - BAR.pad * 2;
    const g = thumbGeometry(metrics());
    // A quarter of the content is visible, so a quarter of the track.
    expect(g?.height).toBeCloseTo(track / 4);
  });

  it("never shrinks the thumb below the minimum grab height", () => {
    const g = thumbGeometry(metrics({ scrollHeight: 200_000 }));
    expect(g?.height).toBe(BAR.minThumb);
  });

  it("caps the thumb at the track when the container is tiny", () => {
    const g = thumbGeometry(
      metrics({ height: 20, clientHeight: 20, scrollHeight: 400 }),
    );
    expect(g?.height).toBe(20 - BAR.pad * 2);
  });

  it("parks the thumb at the top of the track at scrollTop 0", () => {
    const g = thumbGeometry(metrics());
    expect(g?.top).toBe(50 + BAR.pad);
  });

  it("parks the thumb flush with the bottom of the track at the end", () => {
    const g = thumbGeometry(metrics({ scrollTop: 2400 - 600 }));
    const bottom = (g?.top ?? 0) + (g?.height ?? 0);
    expect(bottom).toBeCloseTo(50 + 600 - BAR.pad);
  });

  it("puts the thumb at the track midpoint halfway through the scroll", () => {
    const g = thumbGeometry(metrics({ scrollTop: (2400 - 600) / 2 }));
    const track = 600 - BAR.pad * 2;
    const travel = track - (g?.height ?? 0);
    expect(g?.top).toBeCloseTo(50 + BAR.pad + travel / 2);
  });

  it("clamps overscroll bounce instead of pushing the thumb out of the track", () => {
    // iOS/Android rubber-banding reports scrollTop outside [0, max].
    const up = thumbGeometry(metrics({ scrollTop: -220 }));
    expect(up?.top).toBe(50 + BAR.pad);
    const down = thumbGeometry(metrics({ scrollTop: 2400 }));
    const bottom = (down?.top ?? 0) + (down?.height ?? 0);
    expect(bottom).toBeCloseTo(50 + 600 - BAR.pad);
  });

  it("keeps the track out of the container's vertical padding", () => {
    // The reader columns pad their content clear of the floating frosted
    // chrome; without this the bar would run across that chrome.
    const g = thumbGeometry(metrics({ paddingTop: 100, paddingBottom: 60 }));
    expect(g?.top).toBe(50 + 100 + BAR.pad);
    expect(g?.track).toBe(600 - 100 - 60 - BAR.pad * 2);
  });

  it("keeps the padded track's bottom clear of the padding too", () => {
    const g = thumbGeometry(
      metrics({ scrollTop: 2400 - 600, paddingTop: 100, paddingBottom: 60 }),
    );
    const bottom = (g?.top ?? 0) + (g?.height ?? 0);
    expect(bottom).toBeCloseTo(50 + 600 - 60 - BAR.pad);
  });

  it("ignores padding that would leave no usable track", () => {
    // A short, heavily padded box: a stub of a bar is worse than one that
    // overlaps the padding a little, so fall back to the whole box.
    const g = thumbGeometry(
      metrics({ height: 120, clientHeight: 120, paddingTop: 55, paddingBottom: 55 }),
    );
    expect(g?.top).toBe(50 + BAR.pad);
    expect(g?.track).toBe(120 - BAR.pad * 2);
  });

  it("insets the bar from the trailing edge, not flush against it", () => {
    const g = thumbGeometry(metrics());
    expect(g?.left).toBe(100 + 400 - BAR.inset - BAR.width);
    // The whole bar sits inside the container.
    expect((g?.left ?? 0) + BAR.width).toBeLessThan(100 + 400);
  });

  it("moves the bar to the left edge under dir=rtl", () => {
    const g = thumbGeometry(metrics({ direction: "rtl" }));
    expect(g?.left).toBe(100 + BAR.inset);
  });

  it("keeps the hit area inside the container on both edges", () => {
    // The invisible grab target is wider than the bar; it must not spill out
    // of the container, or it would swallow clicks on adjacent chrome.
    const overhang = (BAR.hit - BAR.width) / 2;
    expect(overhang).toBeLessThanOrEqual(BAR.inset);
  });

  it("stays slim and translucent", () => {
    expect(BAR.width).toBeLessThanOrEqual(4);
    expect(BAR.rest).toBeLessThanOrEqual(0.3);
    expect(BAR.rest).toBeLessThan(BAR.persistent);
    expect(BAR.persistent).toBeLessThan(BAR.hover);
    expect(BAR.hover).toBeLessThan(BAR.drag);
  });

  it("keeps the interactive states above the 3:1 non-text contrast floor", () => {
    // Measured against all four themes' `muted` over their page colour: 0.7 is
    // exactly 3.0:1 in the worst of them. Lowering either value silently turns
    // a draggable control into one that fails WCAG 1.4.11 — so pin them.
    expect(BAR.hover).toBeGreaterThanOrEqual(0.7);
    expect(BAR.drag).toBeGreaterThanOrEqual(BAR.hover);
  });
});
