// PDF-backed FixedPageSource: opens books/<id>/book.pdf with pdf.js and
// renders pages to <canvas> on demand. Page bitmaps are expensive, so mounted
// canvases are LRU-evicted to keep memory bounded on long books.
//
// The file is streamed, not read: pdf.js pulls byte ranges through Rust (see
// pdf/rangeSource.ts). Reading the whole thing meant opening a 200 MB book
// cost ~400 MB of webview heap before the first page was drawn.

import { BaseDirectory, stat } from "@tauri-apps/plugin-fs";
import { openPdfDocument, type PdfDoc } from "../../pdf/pdfjs";
import { bookDir, type Highlight, type PdfBook } from "../../store/library";
import { hlBg, hlMark, type ThemeKey } from "../../styles/tokens";

import type { FixedPageSource } from "./FixedPageSource";

const BASE = BaseDirectory.AppData;
// Never evict below this: the page on screen, the one sliding in, and one
// neighbour. Dropping any of those guarantees a rasterization mid-turn.
/** Where the note bar sits in the page margin, as a share of the page
 *  width. A page's own margin is part of its bitmap and is proportional
 *  to it — typically 5-10% — so 1.6% in lands on paper rather than on
 *  the words, at any page size or zoom. */
const MARGIN_BAR_INSET = 1.6;
const MARGIN_BAR_WIDTH = 0.45;

const MIN_MOUNTED = 3;
// Hard ceiling on the number of live canvases, independent of their size —
// a backstop for pages small enough that the byte budget alone wouldn't bite.
const MAX_MOUNTED = 14;

/** How many bytes of canvas we're willing to hold.
 *
 *  Counting canvases is the wrong unit: a page at 100% on a phone is ~3MB
 *  while the same page zoomed to 250% is ~20MB, so a fixed count either wastes
 *  memory at low zoom or blows past a safe footprint at high zoom. Budget the
 *  bytes instead and let the count fall out of it.
 *
 *  `deviceMemory` is coarse (rounded to a power of two, capped at 8) and absent
 *  outside Chromium, which is fine — it only has to separate a 2GB phone from
 *  an 8GB one. The clamp keeps both ends sane when it's missing or lying. */
function canvasBudgetBytes(): number {
  const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  const guess = typeof gb === "number" && gb > 0 ? gb * 8 : 48; // MB
  return Math.min(96, Math.max(24, guess)) * 1024 * 1024;
}

/** A page we have already rasterized, plus the scale its pixels were drawn at.
 *  Keeping the scale lets `renderPage` re-mount a page somewhere else without
 *  redrawing it — see the note there.
 *
 *  The three layers, bottom to top:
 *
 *    wrap      shrink-wraps the canvas, so its box IS the page box. Highlight
 *              rects are stored normalized (0..1), so they are positioned in
 *              percentages against this and need no repaint on zoom or resize.
 *    marks     painted highlights. `pointer-events: none` — see `pdfHighlightAt`.
 *    text      pdf.js's transparent, selectable text layer, on top so a drag
 *              across the page selects text rather than the marks under it.
 */
interface Mounted {
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement;
  marks: HTMLDivElement;
  text: HTMLDivElement;
  scale: number;
  /** Backing-store bytes, so eviction can budget by memory rather than count. */
  bytes: number;
}

/** RGBA backing store of a canvas, in bytes. */
function canvasBytes(c: HTMLCanvasElement): number {
  return c.width * c.height * 4;
}

/** Scale comparisons go through the same rounding the viewer uses, so a float
 *  that differs in the 4th decimal doesn't force a pointless re-render. */
function quantize(scale: number): number {
  return Math.round(scale * 1000) / 1000;
}

export async function createPdfPageSource(
  book: PdfBook,
): Promise<FixedPageSource> {
  const path = `${bookDir(book.id)}/book.pdf`;
  const info = await stat(path, { baseDir: BASE });
  return createPdfPageSourceFrom(await openPdfDocument({ path, length: info.size }));
}

async function createPdfPageSourceFrom(doc: PdfDoc): Promise<FixedPageSource> {
  const sizeCache = new Map<number, { w: number; h: number }>();
  // Insertion-ordered so the first key is the oldest — cheap LRU.
  const mounted = new Map<number, Mounted>();
  const budget = canvasBudgetBytes();
  // Pages the viewer has mounted right now (see FixedPageSource.retain).
  // Off-limits to the evictor at any budget: a page whose canvas is pulled out
  // from under a live host renders as a blank sheet, and the viewer's own
  // "already drawn at this scale" cache means it is never asked for again.
  //
  // This is what MIN_MOUNTED could not do. Three was the right floor for PAGED
  // mode (the page, the one sliding in, one neighbour) but scroll mode keeps a
  // window of three viewport heights on screen — five pages or more on a tall
  // desktop window — so the floor sat below the working set and eviction ate
  // pages the reader was looking at.
  let retained: ReadonlySet<number> = new Set<number>();
  // Current highlights + theme, pushed in by the viewer via setHighlights.
  let curHighlights: Highlight[] = [];
  let curThemeKey: ThemeKey = "light";
  // Whether the text layer should accept the pointer. Off in paged mode, where
  // a horizontal drag is a page turn and would otherwise be swallowed by a text
  // selection. The spans are still built either way — building them costs one
  // getTextContent() per page, and keeping the layer identical across flows
  // means switching flow never has to rebuild it.
  let selectable = true;

  /** Build the three-layer page element. Empty until renderPage fills it. */
  function makeMount(i: number): Mounted {
    const wrap = document.createElement("div");
    // A PDF carries its own text positions; an RTL ancestor would otherwise
    // scramble both the canvas draw and the text layer's span placement.
    wrap.dir = "ltr";
    wrap.setAttribute("data-page-index", String(i));
    // line-height:0 so the wrap shrink-wraps the canvas exactly, with no
    // inline-descender strip under it throwing the normalized rects off.
    wrap.style.cssText = "position:relative; line-height:0; direction:ltr;";
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    const marks = document.createElement("div");
    marks.style.cssText =
      "position:absolute; inset:0; pointer-events:none; overflow:hidden;";
    const text = document.createElement("div");
    // `.textLayer` in global.css styles the SPANS pdf.js creates (it owns their
    // creation, so they can only be reached from a stylesheet). The container's
    // own geometry is set here instead: it is structural — the layer has to sit
    // exactly over the canvas for a selection's rects to mean anything — and
    // leaving it to a global stylesheet meant anything rendering a page
    // without importing global.css laid the layer out in flow BELOW the page,
    // doubling the wrap's height and putting every glyph elsewhere.
    text.className = "textLayer";
    text.style.cssText =
      "position:absolute; inset:0; overflow:clip; line-height:1; " +
      "text-align:initial; transform-origin:0 0; z-index:1;";
    wrap.append(canvas, marks, text);
    applySelectable(text);
    return { wrap, canvas, marks, text, scale: 0, bytes: 0 };
  }

  function applySelectable(text: HTMLDivElement) {
    text.style.pointerEvents = selectable ? "auto" : "none";
    text.style.userSelect = selectable ? "text" : "none";
    text.style.webkitUserSelect = selectable ? "text" : "none";
  }

  /** Repaint one page's marks from the current highlight set. Positions are
   *  percentages of the page box, so this never needs redoing on a scale
   *  change — only when the highlights or the theme change. */
  function paintMarks(i: number, m: Mounted) {
    m.marks.textContent = "";
    for (const hl of curHighlights) {
      if (hl.fixed?.fmt !== "pdf" || hl.fixed.page !== i) continue;
      for (const r of hl.fixed.rects) {
        const el = document.createElement("div");
        el.setAttribute("data-h-id", hl.id);
        el.style.cssText =
          `position:absolute; left:${r.x * 100}%; top:${r.y * 100}%; ` +
          `width:${r.w * 100}%; height:${r.h * 100}%; ` +
          // Multiply, not a flat fill: the page is a bitmap underneath, and an
          // opaque block would bury the very words being highlighted.
          `background:${hlBg(hl.color, curThemeKey)}; mix-blend-mode:multiply; ` +
          `border-radius:2px;`;
        m.marks.appendChild(el);
      }
      // A bar in the page margin saying this highlight has a note, the
      // same mark the reflowable reader puts there. Nothing needs
      // measuring: the rects are already normalized to the page, so the
      // run's extent is arithmetic, and everything stays correct through
      // a zoom because it is all percentages.
      if (hl.note?.trim() && hl.fixed.rects.length > 0) {
        let top = Infinity;
        let bottom = -Infinity;
        for (const r of hl.fixed.rects) {
          if (r.y < top) top = r.y;
          if (r.y + r.h > bottom) bottom = r.y + r.h;
        }
        const bar = document.createElement("div");
        bar.setAttribute("aria-hidden", "true");
        bar.style.cssText =
          // Logical, so an RTL book puts it in the right-hand margin.
          // The inset is a share of the page, not pixels: a PDF page's
          // own margin is part of the bitmap and is proportional to it.
          `position:absolute; inset-inline-start:${MARGIN_BAR_INSET}%; ` +
          `top:${top * 100}%; height:${(bottom - top) * 100}%; ` +
          `width:${MARGIN_BAR_WIDTH}%; border-radius:1px; pointer-events:none; ` +
          `background:${hlMark(hl.color, curThemeKey)};`;
        m.marks.appendChild(bar);
      }
    }
  }

  function heldBytes(): number {
    let n = 0;
    for (const m of mounted.values()) n += m.bytes;
    return n;
  }

  /** Drop least-recently-used canvases until we're inside both the byte budget
   *  and the count ceiling, never touching `keep` or anything the viewer has
   *  retained, and never going below MIN_MOUNTED — a turn's working set
   *  outranks the budget. */
  function evict(keep: number) {
    let bytes = heldBytes();
    while (
      mounted.size > MIN_MOUNTED &&
      (mounted.size > MAX_MOUNTED || bytes > budget)
    ) {
      // Oldest first, but step over the page we were just asked to keep
      // instead of giving up on it — otherwise one pinned entry at the head
      // stalls eviction entirely and the budget is never enforced.
      let victim: number | undefined;
      for (const key of mounted.keys()) {
        if (key !== keep && !retained.has(key)) {
          victim = key;
          break;
        }
      }
      // Everything left is on screen. Hold the extra bytes rather than blank a
      // page the reader is looking at — the working set is bounded by the
      // viewport, so this cannot grow without limit.
      if (victim === undefined) break;
      const m = mounted.get(victim)!;
      bytes -= m.bytes;
      m.wrap.remove();
      mounted.delete(victim);
    }
  }

  return {
    kind: "pdf",
    pageCount: doc.pageCount,
    outline: doc.outline,
    hasTextLayer: doc.hasTextLayer,

    retain(pages) {
      retained = new Set(pages);
    },

    setHighlights(highlights, themeKey) {
      curHighlights = highlights;
      curThemeKey = themeKey;
      // Repaint in place. Unlike DOCX — whose marks are spans woven into the
      // text and so only appear on a re-render — these are an overlay, so a new
      // highlight can show up without touching the rasterized page at all.
      for (const [i, m] of mounted) paintMarks(i, m);
    },

    setSelectable(on) {
      if (selectable === on) return;
      selectable = on;
      for (const m of mounted.values()) applySelectable(m.text);
    },

    async pageSize(i) {
      const cached = sizeCache.get(i);
      if (cached) return cached;
      const vp = await doc.pageViewport(i, 1);
      const size = { w: vp.width, h: vp.height };
      sizeCache.set(i, size);
      return size;
    },

    async renderPage(i, host, scale) {
      const want = quantize(scale);
      const entry = mounted.get(i);
      if (entry) {
        // MOVE the existing page element rather than building a new one. A page
        // turn hands the same page from the overlay host to the base host, and
        // a fresh canvas there meant rasterizing the page a second time — the
        // single most expensive thing a turn did, and it landed mid-animation.
        // Re-parenting keeps the pixels (and the text layer), so the second
        // mount is free.
        if (entry.wrap.parentElement !== host) {
          host.textContent = "";
          host.appendChild(entry.wrap);
        }
        // Refresh LRU order.
        mounted.delete(i);
        mounted.set(i, entry);
        // Same scale → the bitmap is still correct, nothing to redraw.
        if (entry.scale === want) return;
        entry.scale = want;
        await doc.renderPage(i, entry.canvas, scale);
        await doc.renderTextLayer(i, entry.text, scale);
        entry.bytes = canvasBytes(entry.canvas); // scale changed the backing store
        evict(i);
        return;
      }

      // Fresh host (or recycled by the virtualizer) — reset it. The element is
      // attached BEFORE the awaits below, so the viewer (which reads an empty
      // host as "this page still needs drawing") never asks twice.
      host.textContent = "";
      const created = makeMount(i);
      created.scale = want;
      host.appendChild(created.wrap);
      mounted.set(i, created);
      paintMarks(i, created);
      await doc.renderPage(i, created.canvas, scale);
      await doc.renderTextLayer(i, created.text, scale);
      created.bytes = canvasBytes(created.canvas);
      evict(i);
    },

    destroy() {
      for (const m of mounted.values()) m.wrap.remove();
      mounted.clear();
      doc.destroy();
    },
  };
}
