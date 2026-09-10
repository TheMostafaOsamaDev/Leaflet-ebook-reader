/**
 * Note bars for the DOCX reader.
 *
 * The reflowable reader draws these from React (components/NoteSpines),
 * but the DOCX page is built imperatively — blocks are cloned into a
 * page card and `<mark>` spans are injected into them — so this is the
 * same idea in plain DOM. Geometry comes from the shared `noteSpineBox`
 * and colour from `hlMark`, because a note should not look different
 * depending on which format the book happens to be in.
 *
 * The bar goes in the page's own margin: a DOCX page here is 760px wide
 * with a 56px margin, so a bar 14px out from the block edge sits well
 * inside the paper rather than on top of the words.
 */

import { NOTE_SPINE, noteSpineBox } from "../../styles/noteSpine";
import { hlMark, type HighlightColor, type ThemeKey } from "../../styles/tokens";

/** Marks the elements this module owns, so a repaint can clear its own
 *  bars without touching the page's real content. */
const SPINE_ATTR = "data-note-spine";

export interface SpineTarget {
  id: string;
  color: HighlightColor;
}

/**
 * Draw a bar beside every noted highlight under `root`, and keep them
 * placed as the card reflows.
 *
 * Returns a teardown: pages are rebuilt as the reader turns, and an
 * observer outliving its card would measure a page that is gone.
 */
export function paintDocxNoteSpines(
  root: HTMLElement,
  targets: SpineTarget[],
  themeKey: ThemeKey,
): () => void {
  if (targets.length === 0) return () => {};

  const paint = () => {
    for (const stale of Array.from(root.querySelectorAll(`[${SPINE_ATTR}]`))) {
      stale.remove();
    }
    // Two passes. Reading layout after a write forces a synchronous
    // reflow, so measuring all of them first costs one reflow for the
    // page instead of one per noted highlight.
    const measured: { block: HTMLElement; target: SpineTarget; top: number; height: number }[] = [];
    for (const target of targets) {
      const mark = root.querySelector<HTMLElement>(`[data-h-id="${target.id}"]`);
      const block = mark?.parentElement;
      if (!mark || !block) continue;
      const box = noteSpineBox(
        Array.from(mark.getClientRects()),
        block.getBoundingClientRect(),
      );
      if (box) measured.push({ block, target, ...box });
    }
    for (const m of measured) {
      const bar = document.createElement("span");
      bar.setAttribute(SPINE_ATTR, m.target.id);
      bar.setAttribute("aria-hidden", "true");
      bar.style.cssText =
        `position:absolute; inset-inline-start:${-NOTE_SPINE.offset}px; ` +
        `top:${m.top}px; height:${m.height}px; width:${NOTE_SPINE.width}px; ` +
        `border-radius:${NOTE_SPINE.width / 2}px; pointer-events:none; ` +
        `background:${hlMark(m.target.color, themeKey)};`;
      m.block.appendChild(bar);
    }
  };

  paint();
  // The card is attached before this runs, so the first pass normally
  // lands. The observer is for what comes after: a late image, a
  // webfont, a zoom — the same reflows the reflowable painter watches
  // for, which a fixed retry budget would have missed by seconds.
  const ro = new ResizeObserver(paint);
  ro.observe(root);
  document.fonts?.ready.then(paint).catch(() => {});
  return () => ro.disconnect();
}
