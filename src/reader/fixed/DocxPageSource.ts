// DOCX-backed FixedPageSource: paginates the sanitized HTML into fixed page
// cards. The document is flowed at a fixed page content-width in an offscreen
// measuring container; top-level blocks are greedily packed into pages at block
// boundaries (no mid-line cuts), heading anchors are mapped to page numbers for
// the outline, and each page renders as a white card scaled to fit the viewport.
// Text stays real HTML — selectable + searchable, and Arabic shapes natively.

import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import {
  bookDir,
  chapterImageSrcFor,
  type DocxBook,
  type Highlight,
} from "../../store/library";
import { FONT_STACKS, type ThemeKey } from "../../styles/tokens";
import type { TocEntry } from "../../types/reader";
import type { FixedPageSource } from "./FixedPageSource";
import { applyHighlightsToBlock, type BlockMark } from "./docxHighlight";
import { paintDocxNoteSpines, type SpineTarget } from "./docxNoteSpines";

const BASE = BaseDirectory.AppData;

// Fixed page geometry (intrinsic CSS px). The viewer scales the whole card to
// fit the viewport, so pagination stays stable regardless of zoom/fit.
const PAGE_W = 760;
const PAGE_H = Math.round(PAGE_W * 1.414); // A-series ratio ≈ 1075
const MARGIN = 56;
const CW = PAGE_W - MARGIN * 2;
const CH = PAGE_H - MARGIN * 2;
const FONT = FONT_STACKS.serif;
const FONT_SIZE = 17;
const LINE_HEIGHT = 1.7;

interface DocxParts {
  /** Body HTML with `<img>` srcs already resolved to loadable
   *  asset:// URLs. */
  html: string;
  dir: "ltr" | "rtl";
  outline: { title: string; level: number; anchorId: string }[];
}

const IMG_CONSTRAIN = (img: HTMLImageElement) => {
  img.style.maxWidth = "100%";
  img.style.maxHeight = `${CH}px`;
  img.style.height = "auto";
};

/** Core paginator — runs in any browser (no Tauri), which is what keeps it
 *  testable. Used by the app via createDocxPageSource. */
export async function createDocxPageSourceFromParts(
  parts: DocxParts,
): Promise<FixedPageSource> {
  const parsed = new DOMParser().parseFromString(parts.html, "text/html");

  // Offscreen measuring container, styled exactly like the render card so
  // measured heights match what the reader will show.
  const meas = document.createElement("div");
  meas.setAttribute("dir", parts.dir);
  meas.style.cssText =
    `position:fixed; left:-100000px; top:0; width:${CW}px; visibility:hidden; ` +
    `font-family:${FONT}; font-size:${FONT_SIZE}px; line-height:${LINE_HEIGHT}; box-sizing:border-box;`;
  while (parsed.body.firstChild) meas.appendChild(parsed.body.firstChild);
  meas.querySelectorAll("img").forEach(IMG_CONSTRAIN);
  document.body.appendChild(meas);

  // Correct heights need the reading font + images loaded first (both bounded
  // so a slow font/broken image can't hang pagination).
  try {
    if (document.fonts?.ready) await Promise.race([document.fonts.ready, delay(2000)]);
  } catch {
    /* fonts API unavailable — fall through */
  }
  await Promise.all(
    [...meas.querySelectorAll("img")].map((img) =>
      (img as HTMLImageElement).complete
        ? Promise.resolve()
        : new Promise<void>((res) => {
            const done = () => res();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
            setTimeout(done, 3000);
          }),
    ),
  );

  // Greedy element-boundary pagination.
  const blocks = [...meas.children] as HTMLElement[];
  const pages: Node[][] = [[]];
  const headingPage: Record<string, number> = {};
  // Stable block id → page. Ids are assigned here (before cloning) so a
  // highlight anchored to a block survives re-pagination when the page box
  // changes — it just resolves to a different page.
  const blockPage: Record<string, number> = {};
  let curH = 0;
  blocks.forEach((blk, blockIndex) => {
    const rect = blk.getBoundingClientRect();
    const cs = getComputedStyle(blk);
    const h =
      rect.height +
      (parseFloat(cs.marginTop) || 0) +
      (parseFloat(cs.marginBottom) || 0);
    if (curH > 0 && curH + h > CH) {
      pages.push([]);
      curH = 0;
    }
    const pageIdx = pages.length - 1;
    const blockId = `b${blockIndex}`;
    blk.setAttribute("data-block-id", blockId);
    blockPage[blockId] = pageIdx;
    if (blk.id && blk.id.startsWith("docx-h-")) headingPage[blk.id] = pageIdx;
    blk.querySelectorAll("[id^='docx-h-']").forEach((el) => {
      headingPage[el.id] = pageIdx;
    });
    pages[pageIdx].push(blk.cloneNode(true));
    curH += h;
  });
  document.body.removeChild(meas);

  const outline: TocEntry[] = parts.outline.map((o) => ({
    title: o.title,
    level: o.level,
    dest: { fmt: "page", page: headingPage[o.anchorId] ?? 0 },
  }));

  // Current highlights + theme, pushed in by the viewer via setHighlights. Read
  // fresh on every renderPage so a newly-created highlight shows on re-render.
  let curHighlights: Highlight[] = [];
  let curThemeKey: ThemeKey = "light";
  /** Tears down the note bars' reflow observer. A page is rebuilt on
   *  every turn, and an observer outliving its card would measure a
   *  page that is gone. */
  let cancelSpines: (() => void) | undefined;

  return {
    kind: "docx",
    pageCount: pages.length,
    outline,
    hasTextLayer: true,
    pageForBlock(blockId) {
      return blockPage[blockId];
    },
    setHighlights(hs, themeKey) {
      curHighlights = hs;
      curThemeKey = themeKey;
    },
    async pageSize() {
      return { w: PAGE_W, h: PAGE_H };
    },
    async renderPage(i, host, scale) {
      host.style.overflow = "hidden";
      const card = document.createElement("div");
      card.setAttribute("dir", parts.dir);
      // RTL blocks narrower/wider than the host anchor to the inline-start (right)
      // edge, so the scale origin must match that edge — otherwise the scaled card
      // overflows the host's clip box on the start side. LTR anchors left.
      const originX = parts.dir === "rtl" ? "right" : "left";
      // Colors read from CSS vars set on the viewer (see FixedPageViewer), so
      // the "Page color" / "Text color" reading settings restyle the cards live
      // — no re-pagination. Fallbacks preserve the original white page + near-
      // black text when no override / theme is in effect.
      card.style.cssText =
        `width:${PAGE_W}px; height:${PAGE_H}px; box-sizing:border-box; padding:${MARGIN}px; ` +
        `background:var(--reading-paper, #ffffff); color:var(--reading-ink, #1b1b1b); overflow:hidden; ` +
        `font-family:${FONT}; font-size:${FONT_SIZE}px; line-height:${LINE_HEIGHT}; ` +
        `transform: scale(${scale}); transform-origin: top ${originX};`;
      for (const n of pages[i] || []) card.appendChild(n.cloneNode(true));
      card.querySelectorAll("img").forEach(IMG_CONSTRAIN);
      // Inject highlight <mark>s for any block on this page (before attaching,
      // so the mutation isn't visible mid-render).
      const noted: SpineTarget[] = [];
      if (curHighlights.length > 0) {
        card.querySelectorAll<HTMLElement>("[data-block-id]").forEach((blockEl) => {
          const blockId = blockEl.getAttribute("data-block-id");
          if (!blockId) return;
          const marks: BlockMark[] = [];
          for (const hl of curHighlights) {
            if (hl.fixed?.fmt === "docx" && hl.fixed.blockId === blockId) {
              marks.push({
                id: hl.id,
                charStart: hl.fixed.charStart,
                charEnd: hl.fixed.charEnd,
                color: hl.color,
              });
              if (hl.note?.trim()) {
                noted.push({ id: hl.id, color: hl.color });
                // Containing block for the note bar, set by the builder
                // that owns this block's styling rather than patched on
                // from the painter afterwards.
                blockEl.style.position = "relative";
              }
            }
          }
          if (marks.length) applyHighlightsToBlock(blockEl, marks, curThemeKey);
        });
      }
      host.replaceChildren(card);
      // Note bars come AFTER attaching: a bar's position can only be
      // measured once the card is in the document and its marks are
      // laid out. The previous page's observer is dropped first.
      cancelSpines?.();
      cancelSpines =
        noted.length > 0
          ? paintDocxNoteSpines(card, noted, curThemeKey)
          : undefined;
    },
    destroy() {
      cancelSpines?.();
      cancelSpines = undefined;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** App entry: read the stored HTML, resolve image srcs to asset:// URLs, and
 *  paginate. */
export async function createDocxPageSource(
  book: DocxBook,
): Promise<FixedPageSource> {
  const html = await readTextFile(`${bookDir(book.id)}/content.html`, {
    baseDir: BASE,
  });
  const parsed = new DOMParser().parseFromString(html, "text/html");
  await Promise.all(
    [...parsed.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src");
      if (src) img.setAttribute("src", await chapterImageSrcFor(book.id, src));
    }),
  );
  return createDocxPageSourceFromParts({
    html: parsed.body.innerHTML,
    dir: book.dir,
    outline: book.outline,
  });
}
