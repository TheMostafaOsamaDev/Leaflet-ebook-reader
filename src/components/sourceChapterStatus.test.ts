import { describe, expect, it } from "vitest";
import { chapterOverlay } from "./sourceChapterStatus";

const none = new Set<number>();
const noErrors = new Map<number, string>();

describe("chapterOverlay", () => {
  it("shows loading while the chapter on screen is empty and fetching", () => {
    expect(chapterOverlay(5, 0, new Set([5]), noErrors)).toEqual({ kind: "loading" });
  });

  it("keeps showing loading when a prefetch of the NEXT chapter finishes first", () => {
    // The bug: chapter 5 is still fetching, the prefetch of 6 resolves from
    // cache almost immediately, and a single shared boolean went false — so
    // the overlay vanished and chapter 5 read as a blank page. Chapter 6
    // finishing is not information about chapter 5.
    const inFlight = new Set([5]); // 6 has already completed and left the set
    expect(chapterOverlay(5, 0, inFlight, noErrors)).toEqual({ kind: "loading" });
  });

  it("never covers a chapter that has content", () => {
    // A background refetch of the chapter being read must not blank it out.
    expect(chapterOverlay(5, 12, new Set([5]), noErrors)).toEqual({ kind: "none" });
    expect(chapterOverlay(5, 12, none, new Map([[5, "boom"]]))).toEqual({ kind: "none" });
  });

  it("does not raise the next chapter's failure over this one", () => {
    // A failed prefetch of 6 is not an error the reader of 5 can act on.
    expect(chapterOverlay(5, 0, new Set([5]), new Map([[6, "boom"]]))).toEqual({
      kind: "loading",
    });
    expect(chapterOverlay(5, 0, none, new Map([[6, "boom"]]))).toEqual({ kind: "none" });
  });

  it("reports this chapter's own failure once nothing is in flight", () => {
    expect(chapterOverlay(5, 0, none, new Map([[5, "boom"]]))).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("prefers a retry in flight over the error it is retrying", () => {
    expect(chapterOverlay(5, 0, new Set([5]), new Map([[5, "boom"]]))).toEqual({
      kind: "loading",
    });
  });
});
