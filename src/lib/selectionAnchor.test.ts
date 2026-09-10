// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { rangeForSegments, rectForMark } from "./selectionAnchor";

function mountBody(html: string) {
  document.body.innerHTML = `<div data-book-body>${html}</div>`;
}

describe("rangeForSegments", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("rebuilds a single-paragraph range from stored offsets", () => {
    mountBody(`<p data-p-index="0">The quick brown fox</p>`);
    const range = rangeForSegments([
      { paragraphIndex: 0, charStart: 4, charEnd: 9, text: "quick" },
    ]);
    expect(range?.toString()).toBe("quick");
  });

  it("walks into <mark> children when a highlight already splits the text", () => {
    // Re-measuring has to survive the paragraph being re-rendered with
    // marks in it, which is exactly what happens after the first
    // highlight in a paragraph is created.
    mountBody(
      `<p data-p-index="0">The <mark data-h-id="a">quick brown</mark> fox</p>`,
    );
    const range = rangeForSegments([
      { paragraphIndex: 0, charStart: 4, charEnd: 15, text: "quick brown" },
    ]);
    expect(range?.toString()).toBe("quick brown");
  });

  it("spans from the first segment's start to the last segment's end", () => {
    mountBody(
      `<p data-p-index="0">First paragraph</p><p data-p-index="1">Second paragraph</p>`,
    );
    const range = rangeForSegments([
      { paragraphIndex: 0, charStart: 6, charEnd: 15, text: "paragraph" },
      { paragraphIndex: 1, charStart: 0, charEnd: 6, text: "Second" },
    ]);
    expect(range?.toString()).toContain("paragraph");
    expect(range?.toString()).toContain("Second");
  });

  it("returns null when the paragraph is no longer rendered", () => {
    // Turning the page or changing chapter unmounts it. The caller
    // treats null as 'the thing I was pointing at is gone'.
    mountBody(`<p data-p-index="0">Only paragraph</p>`);
    const range = rangeForSegments([
      { paragraphIndex: 7, charStart: 0, charEnd: 4, text: "gone" },
    ]);
    expect(range).toBeNull();
  });

  it("returns null for an empty segment list", () => {
    mountBody(`<p data-p-index="0">Anything</p>`);
    expect(rangeForSegments([])).toBeNull();
  });

  it("clamps offsets past the end of a shortened paragraph", () => {
    // Defensive: a stale anchor should degrade to a shorter range, not
    // throw an IndexSizeError that takes the reader down.
    mountBody(`<p data-p-index="0">Short</p>`);
    const range = rangeForSegments([
      { paragraphIndex: 0, charStart: 2, charEnd: 999, text: "ort…" },
    ]);
    expect(range?.toString()).toBe("ort");
  });
});

describe("rectForMark", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds the mark a highlight rendered", () => {
    mountBody(`<p data-p-index="0">The <mark data-h-id="h1">quick</mark> fox</p>`);
    expect(rectForMark("h1")).not.toBeNull();
  });

  it("reports gone when the highlight is no longer rendered", () => {
    // The action popover fades out on null rather than pointing at a
    // mark that was deleted or whose chapter turned.
    mountBody(`<p data-p-index="0">The <mark data-h-id="h1">quick</mark> fox</p>`);
    expect(rectForMark("h2")).toBeNull();
  });

  it("points at the first mark of a multi-paragraph highlight", () => {
    // One highlight spanning two paragraphs renders one mark each; the
    // popover anchors to the first so it appears at the top of the run.
    mountBody(
      `<p data-p-index="0">tail <mark data-h-id="g1">first</mark></p>` +
        `<p data-p-index="1"><mark data-h-id="g1">second</mark> head</p>`,
    );
    const marks = document.querySelectorAll('[data-h-id="g1"]');
    expect(marks.length).toBe(2);
    expect(rectForMark("g1")).not.toBeNull();
  });
});
