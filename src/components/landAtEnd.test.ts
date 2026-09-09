import { describe, expect, it } from "vitest";
import { landAtEndFor } from "./readerProgress";

describe("landAtEndFor", () => {
  it("lands at the end of the chapter the request was made for", () => {
    // Scrolled up out of chapter 8 → the request names chapter 7.
    expect(landAtEndFor(7, 7)).toBe(true);
  });

  it("survives a chapter that is still fetching its content", () => {
    // The mount effect cannot position an empty chapter, so it leaves the
    // request pending and re-runs when the paragraphs arrive. Same chapter,
    // so the request is still good.
    expect(landAtEndFor(7, 7)).toBe(true);
  });

  it("is NOT spent on a chapter the reader moved to instead", () => {
    // The bug: scroll back into chapter 7 (empty, still fetching), then turn
    // FORWARD to 8 before it arrives. A bare boolean was still set here, and
    // dropped the reader at the bottom of 8. Verified against the real
    // DesktopReader before this fix: scrollTop 2404 of 2403, chapter heading
    // 2255px above the viewport.
    expect(landAtEndFor(7, 8)).toBe(false);
    expect(landAtEndFor(7, 6)).toBe(false);
  });

  it("does nothing when no request is outstanding", () => {
    expect(landAtEndFor(null, 0)).toBe(false);
    // Chapter 0 is a real chapter index, not an absent request — a
    // truthiness check here would break landing at the end of the first
    // chapter.
    expect(landAtEndFor(0, 0)).toBe(true);
  });
});
