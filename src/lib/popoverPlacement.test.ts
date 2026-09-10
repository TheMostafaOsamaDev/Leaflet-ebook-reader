import { describe, expect, it } from "vitest";
import { placePopover, type PlacementInput } from "./popoverPlacement";

/** A 200x44 toolbar in a 1000x700 window whose reading region is inset
 *  40px top (chrome bar) and 60px bottom (progress bar). */
function input(over: Partial<PlacementInput> = {}): PlacementInput {
  return {
    anchor: { top: 300, bottom: 320, left: 400, width: 200 },
    size: { width: 200, height: 44 },
    bounds: { top: 40, bottom: 640, left: 0, right: 1000 },
    placement: "auto",
    margin: 8,
    ...over,
  };
}

describe("placePopover", () => {
  it("sits above the selection when there is room", () => {
    const p = placePopover(input());
    // 300 (anchor top) - 44 (height) - 8 (margin)
    expect(p.top).toBe(248);
    expect(p.visible).toBe(true);
  });

  it("centres horizontally on the selection", () => {
    const p = placePopover(input());
    // selection spans 400..600, its centre is 500; a 200-wide toolbar
    // starts 100 left of that.
    expect(p.left).toBe(400);
  });

  it("flips below when the selection is near the top of the reading region", () => {
    const p = placePopover(input({ anchor: { top: 50, bottom: 70, left: 400, width: 200 } }));
    expect(p.top).toBe(78); // anchor.bottom + margin
  });

  it("honours a forced 'below' placement even with room above", () => {
    // The phone reader forces below so we never cover Android's own
    // floating toolbar, which sits above the selected text.
    const p = placePopover(input({ placement: "below" }));
    expect(p.top).toBe(328);
  });

  it("goes back above when below would collide with the bottom chrome", () => {
    const p = placePopover(input({ anchor: { top: 600, bottom: 620, left: 400, width: 200 } }));
    expect(p.top).toBe(548);
  });

  it("clamps to the left edge instead of hanging off it", () => {
    const p = placePopover(input({ anchor: { top: 300, bottom: 320, left: 0, width: 40 } }));
    expect(p.left).toBe(8);
  });

  it("clamps to the right edge instead of hanging off it", () => {
    const p = placePopover(input({ anchor: { top: 300, bottom: 320, left: 960, width: 40 } }));
    // 1000 - 200 - 8
    expect(p.left).toBe(792);
  });

  // ── The scroll bug: the menu must not linger over unrelated text ──
  // once the selection it belongs to has scrolled out of the reading
  // region. `visible: false` is the caller's cue to fade it out.

  it("hides once the selection has scrolled off the top", () => {
    const p = placePopover(input({ anchor: { top: -80, bottom: -60, left: 400, width: 200 } }));
    expect(p.visible).toBe(false);
  });

  it("hides once the selection has scrolled off the bottom", () => {
    const p = placePopover(input({ anchor: { top: 700, bottom: 720, left: 400, width: 200 } }));
    expect(p.visible).toBe(false);
  });

  it("hides a selection hidden behind the chrome bars, not just off-window", () => {
    // Sitting under the top bar is as invisible to the reader as being
    // off-window — the bar is opaque frosted glass.
    const p = placePopover(input({ anchor: { top: 4, bottom: 24, left: 400, width: 200 } }));
    expect(p.visible).toBe(false);
  });

  it("stays visible while the selection is only partly in view", () => {
    // Half a line showing is still a line the reader can see themselves
    // highlighting; yanking the menu away there would feel broken.
    const p = placePopover(input({ anchor: { top: 30, bottom: 55, left: 400, width: 200 } }));
    expect(p.visible).toBe(true);
  });

  it("tracks the selection as it scrolls, keeping the same gap", () => {
    const a = placePopover(input({ anchor: { top: 300, bottom: 320, left: 400, width: 200 } }));
    const b = placePopover(input({ anchor: { top: 225, bottom: 245, left: 400, width: 200 } }));
    expect(a.top - b.top).toBe(75);
  });

  // ── Stability. "It moves suddenly to somewhere else" is a bug in its
  // own right: a toolbar that flips sides mid-scroll is harder to use
  // than one that stays put and slides off. Once a side is chosen it is
  // held, and the toolbar clamps inside the reading region instead.

  it("reports which side it chose", () => {
    expect(placePopover(input()).side).toBe("above");
    expect(
      placePopover(input({ anchor: { top: 50, bottom: 70, left: 400, width: 200 } })).side,
    ).toBe("below");
  });

  it("keeps the side it is already on when room above runs out", () => {
    // Scrolling up-page shrinks the room above. Without the lock this
    // is the frame where the toolbar would jump below the selection.
    const p = placePopover(
      input({
        anchor: { top: 44, bottom: 64, left: 400, width: 200 },
        lockedSide: "above",
      }),
    );
    expect(p.side).toBe("above");
    expect(p.top).toBe(40); // clamped to bounds.top, not flipped to 72
  });

  it("keeps a locked 'below' rather than flipping up near the bottom", () => {
    const p = placePopover(
      input({
        anchor: { top: 600, bottom: 620, left: 400, width: 200 },
        lockedSide: "below",
      }),
    );
    expect(p.side).toBe("below");
    expect(p.top).toBe(596); // clamped to bounds.bottom - height
  });

  it("never places itself outside the reading region", () => {
    for (const top of [-200, -20, 0, 40, 300, 620, 700, 900]) {
      const p = placePopover(
        input({ anchor: { top, bottom: top + 20, left: 400, width: 200 }, lockedSide: "above" }),
      );
      expect(p.top).toBeGreaterThanOrEqual(40);
      expect(p.top + 44).toBeLessThanOrEqual(640);
    }
  });

  it("returns whole pixels, so nothing shimmers as it tracks", () => {
    const p = placePopover(
      input({ anchor: { top: 300.4, bottom: 320.7, left: 400.3, width: 199.5 } }),
    );
    expect(Number.isInteger(p.top)).toBe(true);
    expect(Number.isInteger(p.left)).toBe(true);
  });
});
