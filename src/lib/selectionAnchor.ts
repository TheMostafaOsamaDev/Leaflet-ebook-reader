/**
 * Helpers for resolving a window Selection inside the reader to a
 * paragraph-anchored highlight range we can persist and re-render.
 *
 * The book body renders each paragraph as `<p data-p-index="N">…</p>`,
 * with optional `<mark>` spans inside for already-persisted highlights.
 * We translate the Selection's start/end (which may land inside a `<mark>`
 * descendant) into character offsets within the paragraph's plain text.
 */

export interface SelectionAnchor {
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
  text: string;
  rect: DOMRect;
}

/** Walk up to the nearest `<p data-p-index>` ancestor, or null if the
 *  node isn't inside a rendered paragraph (e.g. selection in chrome). */
function findParagraph(node: Node | null): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && n.dataset.pIndex !== undefined) return n;
    n = n.parentNode;
  }
  return null;
}

/** Character offset of `(node, offset)` within `paragraph` — sums up the
 *  text content of every preceding text node in document order. Works
 *  whether the cursor lands directly in the `<p>`'s text or inside a
 *  nested `<mark>` span. */
function charOffsetWithin(
  paragraph: HTMLElement,
  node: Node,
  offset: number,
): number {
  // If the cursor is on an element node, treat `offset` as a child index
  // — sum the text length of every child before that index.
  if (node.nodeType !== Node.TEXT_NODE) {
    let pos = 0;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let t: Node | null;
    while ((t = walker.nextNode())) {
      // The cursor's position is "before child index `offset` of `node`".
      // A text node `t` is "before" that point if its position relative
      // to (node, offset) is < 0.
      const cmp = node.compareDocumentPosition(t);
      if (
        cmp & Node.DOCUMENT_POSITION_CONTAINED_BY ||
        cmp & Node.DOCUMENT_POSITION_PRECEDING
      ) {
        // Contained-by means t is a descendant of node — we need to
        // check whether it's inside a child whose index < offset.
        // Compare against the child at `offset` instead.
        const boundary = node.childNodes[offset] ?? null;
        if (boundary && boundary.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING) {
          pos += t.textContent?.length ?? 0;
        } else if (!boundary) {
          // offset is past the last child — every text node counts
          pos += t.textContent?.length ?? 0;
        }
      }
    }
    return pos;
  }

  // Text node case: walk all text nodes up to (and including a prefix of)
  // the target node, summing lengths.
  let pos = 0;
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  let t: Node | null;
  while ((t = walker.nextNode())) {
    if (t === node) return pos + offset;
    pos += t.textContent?.length ?? 0;
  }
  return pos;
}

/**
 * Resolve the current selection to a paragraph-anchored range. Returns
 * null if the selection is empty/collapsed, spans multiple paragraphs,
 * or doesn't lie inside a rendered paragraph at all (e.g. the user
 * dragged across chrome).
 */
export function resolveSelectionAnchor(): SelectionAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  const startP = findParagraph(range.startContainer);
  const endP = findParagraph(range.endContainer);
  if (!startP || !endP || startP !== endP) return null;

  const paragraphIndex = Number(startP.dataset.pIndex);
  if (!Number.isFinite(paragraphIndex)) return null;

  const a = charOffsetWithin(startP, range.startContainer, range.startOffset);
  const b = charOffsetWithin(startP, range.endContainer, range.endOffset);
  const charStart = Math.min(a, b);
  const charEnd = Math.max(a, b);
  if (charEnd <= charStart) return null;

  const text = sel.toString();
  const rect = range.getBoundingClientRect();
  return { paragraphIndex, charStart, charEnd, text, rect };
}
