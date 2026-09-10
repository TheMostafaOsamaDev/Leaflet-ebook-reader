// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { selectionText } from "./clipboard";
import type { SelectionAnchor } from "./selectionAnchor";

function anchor(texts: string[]): SelectionAnchor {
  return {
    segments: texts.map((text, i) => ({
      paragraphIndex: i,
      charStart: 0,
      charEnd: text.length,
      text,
    })),
    rect: new DOMRect(0, 0, 0, 0),
  };
}

describe("selectionText", () => {
  it("returns a single paragraph's text as-is", () => {
    expect(selectionText(anchor(["واجه الإخوة ميراث"]))).toBe("واجه الإخوة ميراث");
  });

  it("rejoins a multi-paragraph selection with the break the reader sees", () => {
    expect(selectionText(anchor(["first half", "second half"]))).toBe(
      "first half\n\nsecond half",
    );
  });

  it("trims the ragged ends a drag-select leaves behind", () => {
    expect(selectionText(anchor(["  padded  "]))).toBe("padded");
  });

  it("drops segments that are only whitespace", () => {
    // A selection dragged past a paragraph's end picks up the gap
    // between paragraphs; pasting a stray blank line is worse than not.
    expect(selectionText(anchor(["real text", "   ", "more text"]))).toBe(
      "real text\n\nmore text",
    );
  });

  it("returns empty string for an all-whitespace selection", () => {
    expect(selectionText(anchor(["  ", "\n"]))).toBe("");
  });
});
