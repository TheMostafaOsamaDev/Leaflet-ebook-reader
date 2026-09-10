// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { noteSpineBox } from "./noteSpine";
import { hlMark, HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_ORDER } from "./tokens";

/** Relative luminance, for asserting a direction of travel. */
function lum(hex: string): number {
  const h = hex.replace("#", "");
  const parts = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = parts.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const rect = (top: number, height: number) =>
  new DOMRect(0, top, 100, height);

describe("noteSpineBox", () => {
  const block = rect(100, 400);

  it("returns null for a mark with no boxes — it is not laid out yet", () => {
    expect(noteSpineBox([], block)).toBeNull();
  });

  it("measures a one-line mark relative to its block", () => {
    const box = noteSpineBox([rect(140, 30)], block);
    // 40 into the block, trimmed by the 4px inset at each end.
    expect(box).toEqual({ top: 44, height: 22 });
  });

  it("spans first line to last, which is the point of a margin bar", () => {
    // Three lines of 30px starting 40 into the block: the bar covers
    // all three, not just the first.
    const box = noteSpineBox(
      [rect(140, 30), rect(170, 30), rect(200, 30)],
      block,
    );
    expect(box?.top).toBe(44);
    expect(box?.height).toBe(82);
  });

  it("never collapses below a readable minimum", () => {
    // A one-word highlight in a small font: the inset would eat it.
    const box = noteSpineBox([rect(140, 6)], block);
    expect(box?.height).toBe(8);
  });

  it("ignores rects between the first and last", () => {
    // Client rects are in line order; a wide middle line must not
    // stretch the bar beyond the run.
    const a = noteSpineBox([rect(140, 20), rect(160, 20)], block);
    const b = noteSpineBox([rect(140, 20), rect(150, 90), rect(160, 20)], block);
    expect(a).toEqual(b);
  });
});

describe("hlMark", () => {
  it("darkens the marker on the pale themes", () => {
    // Measured: an untouched swatch colour is 1.68:1 against its own
    // tint on sepia paper. Darkening is what makes the marker visible.
    for (const key of ["sepia", "light"] as const) {
      for (const c of HIGHLIGHT_COLOR_ORDER) {
        expect(lum(hlMark(c, key))).toBeLessThan(lum(HIGHLIGHT_COLORS[c].dot));
      }
    }
  });

  it("lifts it on the dark themes instead", () => {
    // The same darkening would hide it there — pink falls to 1.81:1.
    // This asymmetry is the whole reason it takes a theme.
    for (const key of ["dark", "oled"] as const) {
      for (const c of HIGHLIGHT_COLOR_ORDER) {
        expect(lum(hlMark(c, key))).toBeGreaterThan(
          lum(HIGHLIGHT_COLORS[c].dot),
        );
      }
    }
  });

  it("keeps every marker in its own highlight's colour family", () => {
    // Two noted highlights on one screen are told apart by colour, so
    // the marker cannot collapse to a single neutral ink.
    const marks = HIGHLIGHT_COLOR_ORDER.map((c) => hlMark(c, "sepia"));
    expect(new Set(marks).size).toBe(HIGHLIGHT_COLOR_ORDER.length);
  });
});

describe("HIGHLIGHT_COLOR_ORDER", () => {
  it("covers the whole palette, derived rather than repeated", () => {
    expect([...HIGHLIGHT_COLOR_ORDER].sort()).toEqual(
      Object.keys(HIGHLIGHT_COLORS).sort(),
    );
  });

  it("starts at yellow and reads round the hue wheel", () => {
    expect(HIGHLIGHT_COLOR_ORDER[0]).toBe("yellow");
    expect(HIGHLIGHT_COLOR_ORDER).toHaveLength(8);
  });
});
