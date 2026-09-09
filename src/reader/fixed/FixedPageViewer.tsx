// The fixed-layout viewer: renders a FixedPageSource's pages as either a
// virtualized continuous scroll of page-cards or one page at a time. Handles
// fit-width / fit-page + zoom, RTL page-flip, lazy per-window size measurement
// with height reservation (no layout shift), skeleton placeholders, and reports
// progress + resume location.
//
// Paged flow turns pages with a "peek": at a scroll edge the wheel first pans
// the page, then drags the incoming page in from that edge; a page only turns
// once the reader has pushed past a resistance threshold (so a stray notch
// can't flip by accident). A thin floating scrollbar fades in while scrolling.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readingSurfaces, type Theme, type ThemeKey } from "../../styles/tokens";
import { EASE } from "../../styles/motion";
import { BAR } from "../../styles/overlayScrollbar";
import type { Highlight } from "../../store/library";
import { resolveDocxSelection, type DocxSelectionAnchor } from "./docxHighlight";
import {
  pdfHighlightAt,
  resolvePdfSelection,
  type PdfSelectionAnchor,
} from "./pdfHighlight";
import type {
  FixedFit,
  FixedFlow,
  FixedPageTint,
  ReaderProgress,
} from "../../types/reader";
import type { FixedPageSource } from "./FixedPageSource";

const PAD = 20;
const GAP = 18;
const MAX_W = 860; // cap page display width so wide screens stay readable + light
// At or below this container width the page always spans the full width: a
// phone has no spare room for a side gutter.
const NARROW_VIEWPORT = 520;

// Paged turn feel: TURN_PX is the overscroll (px, accumulated) needed to commit
// a turn — the "strength" that guards against accidental flips. IDLE_MS springs
// a half-finished peek back; ANIM/CANCEL are the slide timings; POST_LOCK eats
// trackpad momentum right after a turn so it doesn't immediately start another.
const TURN_PX = 200;
const IDLE_MS = 170;
const ANIM_MS = 220;
const CANCEL_MS = 190;
const POST_LOCK_MS = 340;
const TURN_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
// A turn released from a drag carries on from the speed the finger had and
// decelerates to rest, so it needs a curve that leaves the gate at roughly
// that speed rather than accelerating into it — the fast-start curve above is
// right for a tap, but after a slow drag it reads as the page being snatched.
const DRAG_SETTLE_EASE = "cubic-bezier(0, 0, 0.35, 1)";
// Coasting to a stop from v0 covers v0*T/2, so reaching the far edge takes
// about twice the distance-over-speed a constant pace would.
const SETTLE_DECEL = 1.9;
// The settle is never shorter than the distance it has to cover deserves: a
// turn released early has most of the page still to travel, and letting a quick
// flick's velocity shorten THAT into a whoosh is what made a short swipe feel
// like the reader had to drag the page most of the way themselves to get a
// smooth turn. So velocity can only ever lengthen the settle, never cut it
// below this floor, which scales from a near-finished turn to a full-width one.
const SETTLE_MIN_MS = 130;
const SETTLE_FULL_MS = 300;
const SETTLE_MAX_MS = 460;

// Touch drag feel. AXIS_LOCK is the travel before a drag commits to an axis (so
// a slightly-diagonal vertical pan isn't stolen as a page turn). On release a
// turn completes if the strip was dragged past SNAP_FRACTION of the viewport OR
// flicked faster than FLING — a quick flick shouldn't need a long drag.
const AXIS_LOCK_PX = 10;
const SNAP_FRACTION = 0.25;
const FLING_PX_MS = 0.45;
// Only the tail of a drag counts toward the fling test, so a long slow pan that
// ends in a flick still throws the page — averaging over the whole gesture
// would drown the flick. (MobileSheet's sheetSnap does the same for its own
// vertical axis; the two aren't shared because the axes and units differ.)
const VELOCITY_WINDOW_MS = 100;
// How long to let the current page settle before warming its neighbours. Short
// enough to keep ahead of quick successive turns — a turn that arrives before
// its page is rasterized animates a blank sheet in and pops the content at the
// end — but not so short that it competes with the page just landed.
// A plain timer rather than requestIdleCallback on purpose: idle callbacks fire
// in the gaps *between* a drag's frames, so the rasterization lands mid-gesture
// and costs more than it saves (measured: ~20 fewer frames delivered per drag).
const PREFETCH_DELAY_MS = 80;
// How many pages to keep warm ahead of the reader. Three covers a burst of
// quick swipes without the incoming page ever arriving unrasterized.
//
// Only ONE is warmed behind, deliberately. Pages you have just come from are
// still in the source's cache — going back is a re-parent, not a render — so
// spending rasterization on them would be work for nothing. The single one is
// for the case where you land somewhere fresh (a jump from the contents) and
// immediately turn back. Memory is bounded by the source's byte budget, not by
// this number; see canvasBudgetBytes in PdfPageSource.
const PREFETCH_AHEAD = 3;
const PREFETCH_BEHIND = 1;
// How long to keep trying to place the scroller after a switch to scroll flow,
// while the virtualized column grows to its full height underneath.
const FLOW_RESTORE_MS = 2500;

/** Signed px/ms across the sample ring, measured over the most recent
 *  VELOCITY_WINDOW_MS. Returns 0 when there's nothing to measure. */
function releaseVelocity(samples: Array<{ x: number; t: number }>): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const s of samples) {
    if (last.t - s.t <= VELOCITY_WINDOW_MS) {
      first = s;
      break;
    }
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export function tintFilter(tint: FixedPageTint): string {
  switch (tint) {
    case "dim":
      return "brightness(0.9) contrast(1.02)";
    case "invert":
      return "invert(1) hue-rotate(180deg)";
    default:
      return "none";
  }
}

/** A pending text selection, tagged by the format that produced it — the two
 *  anchor into a fixed-layout page in fundamentally different ways (a DOCX
 *  block + char range vs. a PDF page + normalized rects), and the reader has to
 *  store whichever it is given. */
export type FixedSelection =
  | ({ kind: "docx" } & DocxSelectionAnchor)
  | ({ kind: "pdf" } & PdfSelectionAnchor);

export interface FixedPageViewerProps {
  source: FixedPageSource;
  flow: FixedFlow;
  fit: FixedFit;
  /** Multiplier on the fit scale (0.5–~2.5). */
  zoom: number;
  tint: FixedPageTint;
  dir: "ltr" | "rtl";
  /** Which way a page turn travels. Mobile turns sideways to match the swipe
   *  that drives it; desktop turns vertically to match the wheel. */
  turnAxis: "x" | "y";
  theme: Theme;
  resume?: { page: number; pageOffset?: number };
  onProgress?: (p: ReaderProgress) => void;
  onLocationChange?: (page: number, pageOffset: number) => void;
  /** Localized page-counter label, e.g. "٧ / ٢٩٨". */
  formatCounter?: (page1: number, total: number) => string;
  reducedMotion?: boolean;
  /** This book's highlights (for DOCX render-back) + the active theme key. */
  highlights: Highlight[];
  themeKey: ThemeKey;
  /** DOCX text selected (or null to dismiss) — the shell shows a color popover. */
  onSelect: (anchor: FixedSelection | null) => void;
  /** An existing highlight `<mark>` was clicked — the shell shows edit/delete. */
  onHighlightClick: (id: string, rect: DOMRect) => void;
}

export interface FixedPageViewerHandle {
  goToPage(i: number): void;
}

let shimmerInjected = false;
function ensureShimmerStyle() {
  if (shimmerInjected || typeof document === "undefined") return;
  shimmerInjected = true;
  const el = document.createElement("style");
  el.textContent =
    "@keyframes fx-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}";
  document.head.appendChild(el);
}

export const FixedPageViewer = forwardRef<
  FixedPageViewerHandle,
  FixedPageViewerProps
>(function FixedPageViewer(props, ref) {
  const {
    source,
    flow,
    fit,
    zoom,
    tint,
    dir,
    turnAxis: axis,
    theme,
    resume,
    onProgress,
    onLocationChange,
    formatCounter,
    reducedMotion,
    highlights,
    themeKey,
    onSelect,
    onHighlightClick,
  } = props;
  const pageCount = source.pageCount;

  // Bumped whenever DOCX highlights/theme change to force a re-render of the
  // visible pages (renderPage re-injects the <mark> spans from the source).
  const [highlightNonce, setHighlightNonce] = useState(0);
  useEffect(() => {
    if (!source.setHighlights) return;
    source.setHighlights(highlights, themeKey);
    // PDF paints its marks as an overlay and has just updated them in place —
    // nothing to re-render, and forcing one would re-rasterize the page for a
    // change that never touched a pixel of it.
    if (source.kind !== "docx") return;
    // DOCX weaves the marks into the text, so the visible pages have to be
    // rebuilt. The per-page render cache is keyed only on scale, which hasn't
    // changed, so without clearing it the render effect would skip these pages.
    // `rendered` is untouched, so no skeleton flashes.
    renderedScale.current.clear();
    setHighlightNonce((n) => n + 1);
  }, [source, highlights, themeKey]);

  // Selecting text is a scroll-mode affordance for now: in paged mode a
  // horizontal drag is a page turn, and the text layer would swallow it.
  useEffect(() => {
    source.setSelectable?.(flow === "scroll");
  }, [source, flow]);

  // Text selection → color popover; clicking an existing highlight → its
  // edit/delete popover. Deferred a tick so the browser finalizes the selection.
  //
  // The two formats differ only in how a selection is anchored and how an
  // existing highlight is found under the pointer. DOCX marks are real
  // elements in the text, so `closest()` finds them; PDF marks are an overlay
  // beneath the text layer and deliberately transparent to the pointer, so
  // they are found by hit test (see pdfHighlightAt).
  const isPdf = source.kind === "pdf";
  useEffect(() => {
    // Paged mode has no selectable text layer to select from (PDF), and turning
    // pages by drag should not raise a colour popover (DOCX).
    if (flow !== "scroll") return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onUp = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      const { clientX, clientY } = e;
      window.setTimeout(() => {
        if (isPdf) {
          const anchor = resolvePdfSelection(scroller);
          if (anchor) {
            onSelect({ kind: "pdf", ...anchor });
            return;
          }
          onSelect(null);
          const hit = pdfHighlightAt(clientX, clientY);
          if (hit) onHighlightClick(hit.id, hit.rect);
          return;
        }
        const anchor = resolveDocxSelection(scroller);
        if (anchor) {
          onSelect({ kind: "docx", ...anchor });
          return;
        }
        onSelect(null);
        const mark = target?.closest?.("[data-h-id]") as HTMLElement | null;
        const id = mark?.getAttribute("data-h-id");
        if (id) onHighlightClick(id, mark!.getBoundingClientRect());
      }, 0);
    };
    scroller.addEventListener("pointerup", onUp);
    return () => scroller.removeEventListener("pointerup", onUp);
  }, [isPdf, flow, onSelect, onHighlightClick]);

  // Reading colours come straight from the theme now. The page is the theme's
  // paper and the surround a shade behind it, so the sheet reads as a sheet
  // without a border; DOCX cards take those through CSS vars.
  const surfaces = readingSurfaces(theme);
  const hostFilter = tintFilter(tint);


  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRefs = useRef(new Map<number, HTMLDivElement>());
  const refCbs = useRef(new Map<number, (el: HTMLDivElement | null) => void>());
  const renderedScale = useRef(new Map<number, number>());
  // Bumped when a mounted host is found empty, to re-run the render effect.
  // See `sweepBlankHosts`.
  const [healNonce, setHealNonce] = useState(0);
  const resumedRef = useRef(false);
  const lastEmitted = useRef(-1);
  const saveTimer = useRef<number | null>(null);

  const [sizes, setSizes] = useState<Array<{ w: number; h: number } | undefined>>(
    () => new Array(pageCount).fill(undefined),
  );
  const [container, setContainer] = useState({ w: 0, h: 0 });
  const [current, setCurrent] = useState(resume?.page ?? 0);
  const [win, setWin] = useState({ start: 0, end: Math.min(pageCount - 1, 2) });
  const [rendered, setRendered] = useState<Set<number>>(() => new Set());

  // Paged turn state. `peek` mounts the incoming page as an overlay and slides
  // it in from the edge; `peekIdx` is the page shown there (stable for the whole
  // turn, so the pdf only renders once).
  //
  // Only the DISCRETE half of a turn lives in React: whether an overlay is up
  // and which way it is going. The continuous part — how far along the turn is
  // — is written straight to the DOM by `writeTurn`, because re-rendering this
  // component once per animation frame is what made a drag feel heavy.
  const [peek, setPeek] = useState<{ dir: 1 | -1 } | null>(null);
  const [peekIdx, setPeekIdx] = useState<number | null>(null);
  // How far along the current turn is, 0..1. Mirrors what `writeTurn` last
  // pushed to the DOM; never triggers a render.
  const revealRef = useRef(0);
  // Live turn geometry, refreshed each render so `writeTurn` can stay stable.
  const turnGeom = useRef({ span: 1, mirror: 1, horizontal: true });
  // True between a turn opening and its layers being released, so a stray
  // write can't shove a settled page around.
  const turnLive = useRef(false);
  // The paged duotone overlay, which has to travel with the page it tints.
  const duotoneRef = useRef<HTMLDivElement>(null);
  // Set below, once the turn helpers exist. Held in a ref so the paged render
  // effect — which is declared before them — can call it without a cycle.
  const dropOverlayRef = useRef<(page: number) => void>(() => {});
  // Live layout inputs for the prefetch effect. Read through refs so it can
  // depend on the page number alone: `sizes` and `layout` change on every
  // measurement, and depending on them restarted the timer faster than it
  // could fire, so on quick page turns the neighbours were never warmed.
  const layoutRef = useRef<{ top: number[] }>({ top: [] });
  const prefetchInputs = useRef<{
    sizes: Array<{ w: number; h: number } | undefined>;
    layout: { displayW: number[] };
    usableW: number;
  }>({ sizes: [], layout: { displayW: [] }, usableW: 0 });
  // Offscreen hosts holding the pages either side of the current one, so a
  // turn has its bitmap ready instead of rasterizing mid-animation.
  const warmRefs = useRef<Array<HTMLDivElement | null>>([]);
  // Which way the reader is travelling, so the warm window leans that way.
  const lastDir = useRef<1 | -1>(1);

  // Where the swapped-in page lands (top normally; bottom when turning back).
  const pendingScroll = useRef<null | "top" | "bottom">(null);
  const turnLockUntil = useRef(0); // momentum guard after a turn
  const accum = useRef(0); // overscroll accumulated toward the current turn
  const peekDir = useRef<0 | 1 | -1>(0);
  const peekNeighbor = useRef(0); // index in the overlay (ref mirror of peekIdx)
  const peekHold = useRef<number | null>(null); // keep overlay until base paints
  const turning = useRef(false); // commit slide in flight
  const idleTimer = useRef<number | null>(null);
  const turnTimer = useRef<number | null>(null);
  const holdTimer = useRef<number | null>(null);
  const peekRaf = useRef(0);
  // Live touch-drag origin + the axis it locked onto ("" until it commits).
  // `samples` is a short ring of recent positions — a flick is judged on the
  // last few milliseconds, not on the whole gesture (see releaseVelocity).
  const touch = useRef({
    x: 0,
    y: 0,
    t: 0,
    axis: "" as "" | "x" | "y",
    pointerId: -1,
    samples: [] as Array<{ x: number; t: number }>,
  });
  // Set while a drag is turning pages, so the trailing click doesn't turn again.
  const suppressClick = useRef(false);
  // How far the current page overflows the viewport horizontally, in px.
  // Derived from LAYOUT, never from `scrollWidth - clientWidth`: a turn
  // translates the base layer, and a transformed child counts toward its
  // scroll container's scrollable overflow — so mid-turn the scroller reports
  // a page-wide overflow and the drag gets mistaken for panning a zoomed page.
  const overflowX = useRef(0);
  const peekHostRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const barIdle = useRef<number | null>(null);

  // Live mirrors the subscribe-once wheel listener reads without re-subscribing.
  const currentRef = useRef(current);
  currentRef.current = current;
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  useEffect(() => ensureShimmerStyle(), []);

  // Measure the container.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainer({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // "Fit width" means exactly that: the page spans the viewport edge to edge,
  // with no side gutter. "Fit page" keeps the inset on a roomy window, where
  // the page is height-bound and the breathing room reads as a margin — but
  // not on a phone, where a decorative gutter is width the words could have
  // had. MAX_W still caps very wide windows so a desktop page stays readable;
  // on a phone the container is far narrower than the cap, so it never binds.
  const padX = fit === "width" || container.w <= NARROW_VIEWPORT ? 0 : PAD;
  const contentW = Math.max(0, container.w - padX * 2);
  const usableW = Math.min(contentW, MAX_W);
  const fallbackRatio = useMemo(() => {
    const m = sizes.find(Boolean);
    return m ? m.h / m.w : 1.414;
  }, [sizes]);

  // Per-page display width/height + top offsets. Unmeasured pages use the
  // fallback aspect ratio so the scroll height is reserved (refines lazily).
  const layout = useMemo(() => {
    const displayW = new Array<number>(pageCount);
    const displayH = new Array<number>(pageCount);
    const top = new Array<number>(pageCount);
    let y = PAD;
    for (let i = 0; i < pageCount; i++) {
      const s = sizes[i];
      let w: number;
      let h: number;
      if (fit === "page" && container.h > 0) {
        const iw = s?.w ?? Math.max(1, usableW);
        const ih = s?.h ?? iw * fallbackRatio;
        const sc = Math.min(usableW / iw, (container.h - PAD * 2) / ih) * zoom;
        w = iw * sc;
        h = ih * sc;
      } else {
        w = usableW * zoom;
        const ratio = s ? s.h / s.w : fallbackRatio;
        h = w * ratio;
      }
      displayW[i] = w;
      displayH[i] = h;
      top[i] = y;
      y += h + GAP;
    }
    return { displayW, displayH, top, totalH: y - GAP + PAD };
  }, [sizes, container.h, zoom, fit, usableW, fallbackRatio, pageCount]);

  prefetchInputs.current = { sizes, layout, usableW };
  // Read by the flow-restore retry loop, which outlives the render it started in.
  layoutRef.current = layout;

  const emit = useCallback(
    (page: number) => {
      if (page === lastEmitted.current) return;
      lastEmitted.current = page;
      onProgress?.({
        page,
        fraction: pageCount > 0 ? (page + 1) / pageCount : 0,
        label: formatCounter
          ? formatCounter(page + 1, pageCount)
          : `${page + 1} / ${pageCount}`,
      });
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const el = scrollRef.current;
        let off = 0;
        if (el && flow === "scroll") {
          off = Math.max(
            0,
            Math.min(1, (el.scrollTop - layout.top[page]) / (layout.displayH[page] || 1)),
          );
        }
        onLocationChange?.(page, off);
      }, 500);
    },
    [onProgress, onLocationChange, formatCounter, pageCount, flow, layout],
  );

  /** Notice a mounted host that has lost its contents.
   *
   *  `renderedScale` records what we ASKED the source for, not what is
   *  actually on screen — a source that caches page bitmaps may drop one
   *  afterwards, and then the render effect skips that page forever because
   *  the cache still says "drawn at this scale". `retain` (below) tells the
   *  source not to do that to an on-screen page; this is the backstop for
   *  when it happens anyway.
   *
   *  Cheap enough to run per scroll frame: one property read per mounted host,
   *  and the window is a handful of pages. State only moves when something is
   *  genuinely blank, so a healthy scroll costs nothing but the reads. */
  const sweepBlankHosts = useCallback(() => {
    let blank = false;
    for (const [i, host] of hostRefs.current) {
      if (host.firstElementChild !== null) continue;
      // Forget the claim so the render effect asks the source again.
      renderedScale.current.delete(i);
      blank = true;
    }
    if (blank) setHealNonce((n) => n + 1);
  }, []);

  // Recompute the render window + current page from scroll position.
  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el || flow !== "scroll") return;
    const st = el.scrollTop;
    const ch = el.clientHeight;
    const lo = st - ch;
    const hi = st + ch * 2;
    let start = pageCount;
    let end = -1;
    let cur = 0;
    let bestD = Infinity;
    const mid = st + ch * 0.35;
    for (let i = 0; i < pageCount; i++) {
      const t = layout.top[i];
      const b = t + layout.displayH[i];
      if (b >= lo && t <= hi) {
        if (i < start) start = i;
        if (i > end) end = i;
      }
      const d = Math.abs(t - mid);
      if (d < bestD) {
        bestD = d;
        cur = i;
      }
    }
    if (end < 0) {
      start = 0;
      end = Math.min(pageCount - 1, 2);
    }
    setWin((w) => (w.start === start && w.end === end ? w : { start, end }));
    setCurrent((c) => (c === cur ? c : cur));
    sweepBlankHosts();
    emit(cur);
  }, [flow, pageCount, layout, emit, sweepBlankHosts]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || flow !== "scroll") return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [flow, recompute]);

  useEffect(() => {
    recompute();
  }, [recompute, container.w, container.h]);

  // Resume once the container has a real size — scroll to the (estimated) offset
  // of the resume page; lazy measurement refines it as pages come into view.
  useEffect(() => {
    if (resumedRef.current || !resume || container.h === 0 || flow !== "scroll") {
      return;
    }
    resumedRef.current = true;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop =
        layout.top[resume.page] +
        (resume.pageOffset ?? 0) * layout.displayH[resume.page];
    }
    emit(resume.page);
  }, [resume, container.h, layout, flow, emit]);

  // Keep your place when the flow changes.
  //
  // One direction needs nothing: `recompute` tracks the current page from
  // scroll position continuously, so paged mode opens on whatever was on
  // screen. Coming back the other way the scroller starts at the top, and the
  // resume effect above has already fired once and latched for the session, so
  // there is nothing to place it — the reader landed on page one every time.
  //
  // It has to keep trying rather than write the offset once. Switching to
  // scroll mounts a virtualized column whose full height only exists a beat
  // later — measured on device, `scrollHeight` was still one viewport 11ms in
  // and only reached its real 150932px after 1.3s. A single write lands in that
  // window and is clamped straight back to zero, which is exactly what a
  // one-shot version of this did.
  //
  // Only fires on an actual flow CHANGE: on first mount the resume effect owns
  // the scroll position and racing it would clobber a restored location.
  const prevFlow = useRef(flow);
  useLayoutEffect(() => {
    if (prevFlow.current === flow) return;
    prevFlow.current = flow;
    if (flow !== "scroll") return;
    const target = currentRef.current;
    const deadline = performance.now() + FLOW_RESTORE_MS;
    let raf = 0;
    const place = () => {
      const el = scrollRef.current;
      const top = layoutRef.current.top[target];
      if (el && top != null) {
        el.scrollTop = top;
        if (Math.abs(el.scrollTop - top) <= 2) return; // the column can hold it
      }
      if (performance.now() < deadline) raf = window.requestAnimationFrame(place);
    };
    raf = window.requestAnimationFrame(place);
    return () => window.cancelAnimationFrame(raf);
  }, [flow]);

  // Tell the source which pages are mounted, so a source that caches page
  // bitmaps never evicts one out from under a live host. Without this, a PDF
  // whose canvases outgrew the cache budget had pages pulled out from under
  // hosts that were still on screen — and because `renderedScale` still said
  // "drawn at this scale", the render effect below skipped them for good. The
  // page stayed a blank sheet no matter how far you scrolled away and back.
  useEffect(() => {
    if (!source.retain) return;
    const pages: number[] = [];
    if (flow === "scroll") {
      for (let i = win.start; i <= win.end; i++) pages.push(i);
    } else {
      // Paged: the page itself plus the neighbours the prefetcher warms — a
      // turn re-parents one of those canvases, so losing one costs a
      // rasterization inside the animation.
      const d = lastDir.current;
      pages.push(current);
      for (let n = 1; n <= PREFETCH_AHEAD; n++) pages.push(current + n * d);
      for (let n = 1; n <= PREFETCH_BEHIND; n++) pages.push(current - n * d);
    }
    source.retain(pages.filter((i) => i >= 0 && i < pageCount));
  }, [source, flow, win, current, pageCount]);

  // Lazily measure + render the visible window (scroll).
  useEffect(() => {
    if (flow !== "scroll") return;
    let cancelled = false;
    (async () => {
      const measured: Array<[number, { w: number; h: number }]> = [];
      for (let i = win.start; i <= win.end; i++) {
        const host = hostRefs.current.get(i);
        if (!host) continue;
        let s = sizes[i];
        if (!s) {
          try {
            s = await source.pageSize(i);
          } catch {
            s = { w: 800, h: 1132 };
          }
          if (cancelled) return;
          measured.push([i, s]);
        }
        const sc = layout.displayW[i] / s.w;
        const want = Math.round(sc * 1000) / 1000;
        // An empty host outranks the cache. `renderedScale` only records what
        // we ASKED for, and the source is free to drop a page's contents
        // afterwards (bitmap eviction under memory pressure). `retain` above
        // stops that happening for on-screen pages, but this is the backstop
        // that keeps a blank sheet from becoming permanent if it ever does:
        // `renderPage` always leaves something in the host synchronously, so
        // an empty one means there is genuinely nothing to show.
        // Same-frame case: the source dropped this page's contents during
        // this very pass. Later ones are caught by `sweepBlankHosts`.
        const blank = host.firstElementChild === null;
        if (renderedScale.current.get(i) !== want || blank) {
          renderedScale.current.set(i, want);
          const pi = i;
          // Let the shimmer back while it redraws — there is no canvas under
          // it to leak around, and a blank sheet reads as a broken page.
          if (blank) setRendered((prev) => {
            if (!prev.has(pi)) return prev;
            const next = new Set(prev);
            next.delete(pi);
            return next;
          });
          void source.renderPage(pi, host, sc).then(() => {
            setRendered((prev) => (prev.has(pi) ? prev : new Set(prev).add(pi)));
          });
        }
      }
      if (!cancelled && measured.length) {
        setSizes((prev) => {
          const next = prev.slice();
          for (const [i, s] of measured) if (!next[i]) next[i] = s;
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [win, layout, sizes, tint, flow, source, highlightNonce, healNonce]);

  // Lazily measure + render the single current page (paged).
  useEffect(() => {
    if (flow !== "paged") return;
    let cancelled = false;
    (async () => {
      const host = hostRefs.current.get(current);
      if (!host) return;
      let s = sizes[current];
      if (!s) {
        try {
          s = await source.pageSize(current);
        } catch {
          s = { w: 800, h: 1132 };
        }
        if (cancelled) return;
        setSizes((prev) => {
          if (prev[current]) return prev;
          const next = prev.slice();
          next[current] = s!;
          return next;
        });
      }
      const sc = layout.displayW[current] / s.w;
      const cur = current;
      void source.renderPage(cur, host, sc).then(() => {
        setRendered((prev) => (prev.has(cur) ? prev : new Set(prev).add(cur)));
        dropOverlayRef.current(cur);
      });
      emit(current);
    })();
    return () => {
      cancelled = true;
    };
  }, [flow, current, layout, sizes, tint, source, emit, highlightNonce]);

  // ---- Paged turn controller ------------------------------------------------

  const clampIdx = useCallback(
    (i: number) => Math.max(0, Math.min(pageCount - 1, i)),
    [pageCount],
  );

  /** Push a turn position straight to the DOM. BOTH layers move as one: the
   *  incoming page enters from the edge while the outgoing leaves by exactly
   *  the distance the incoming covers, so the motion reads as the viewport
   *  travelling along a filmstrip rather than a card being dealt on top.
   *
   *  Deliberately imperative. Driving this through React state re-rendered the
   *  whole viewer once per frame; at a 20x CPU handicap that put p99 frame time
   *  at ~196ms. `will-change` promotes the layers so the compositor moves them
   *  without repainting the page bitmap underneath. */
  const writeTurn = useCallback((
    reveal: number,
    animate: boolean,
    settle?: { ms: number; ease: string },
  ) => {
    if (!turnLive.current) return;
    const { span, mirror, horizontal } = turnGeom.current;
    const d = peekDir.current || 1;
    const at = (px: number) =>
      horizontal ? `translateX(${px}px)` : `translateY(${px}px)`;
    const transition =
      animate && !reducedRef.current
        ? `transform ${settle?.ms ?? ANIM_MS}ms ${settle?.ease ?? TURN_EASE}`
        : "none";
    const basePx = -d * mirror * reveal * span;
    const peekPx = d * mirror * (1 - reveal) * span;
    const outgoing = hostRefs.current.get(currentRef.current);
    for (const el of [outgoing, duotoneRef.current]) {
      if (!el) continue;
      el.style.willChange = "transform";
      el.style.transition = transition;
      el.style.transform = at(basePx);
    }
    const incoming = peekHostRef.current;
    if (incoming) {
      incoming.style.willChange = "transform";
      incoming.style.transition = transition;
      incoming.style.transform = at(peekPx);
    }
    revealRef.current = reveal;
  }, []);

  /** Release the layers once a turn is over — drop `will-change` so the
   *  compositor can reclaim them, and clear the transform so a page that stays
   *  mounted (a cancelled turn) sits exactly where it started. */
  const releaseTurn = useCallback(() => {
    turnLive.current = false;
    revealRef.current = 0;
    for (const el of [
      hostRefs.current.get(currentRef.current),
      duotoneRef.current,
      peekHostRef.current,
    ]) {
      if (!el) continue;
      el.style.willChange = "";
      el.style.transition = "";
      el.style.transform = "";
    }
  }, []);

  // Swap in the peeked page. The overlay is held (fully covering) until the base
  // layer has painted the new page, so a turn never flashes a skeleton.
  const finalize = useCallback((d: 1 | -1) => {
    if (turnTimer.current) {
      window.clearTimeout(turnTimer.current);
      turnTimer.current = null;
    }
    const neighbor = peekNeighbor.current;
    lastDir.current = d;
    turning.current = false;
    accum.current = 0;
    peekDir.current = 0;
    turnLockUntil.current = performance.now() + POST_LOCK_MS;
    pendingScroll.current = d > 0 ? "top" : "bottom";
    peekHold.current = neighbor;
    // The base host is keyed on `current`, so swapping pages hands us a fresh
    // node with no transform — the outgoing page's travel doesn't have to be
    // unwound, and the overlay is still covering while React commits.
    turnLive.current = false;
    revealRef.current = 0;
    setCurrent(neighbor);
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      peekHold.current = null;
      releaseTurn();
      setPeek(null);
      setPeekIdx(null);
    }, 500);
  }, [releaseTurn]);

  /** Finish a turn. `releaseSpeed` (px/ms, unsigned) is the speed the finger
   *  was travelling when it let go; given it, the remaining distance is covered
   *  at roughly that pace so the strip carries on instead of jumping to a fixed
   *  duration. Releasing 40% of the way in used to hand the last 60% to a flat
   *  220ms — about twice the speed the finger had been moving, which is what
   *  made a turn feel like it completed itself out from under you. */
  const commit = useCallback(
    (d: 1 | -1, releaseSpeed?: number) => {
      if (idleTimer.current) {
        window.clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
      // A drag frame queued by `renderPeek` but not yet run would land AFTER
      // the settle below and rewrite `transition: none` plus the old drag
      // position, killing the animation outright — the turn would then sit
      // still until `finalize` swapped the page, with no transition at all.
      // Whether the last touchmove and the release share a frame is down to
      // the pointer's timing, so this is only sometimes reachable.
      if (peekRaf.current) {
        window.cancelAnimationFrame(peekRaf.current);
        peekRaf.current = 0;
      }
      turning.current = true;
      if (reducedRef.current) {
        finalize(d);
        return;
      }
      const span = turnGeom.current.span;
      const left = Math.max(0, 1 - revealRef.current); // fraction still to travel
      // Floor: a full-width settle always gets SETTLE_FULL_MS, a nearly-done one
      // only SETTLE_MIN_MS, scaling between.
      const floorMs = SETTLE_MIN_MS + left * (SETTLE_FULL_MS - SETTLE_MIN_MS);
      // A slow release coasts longer so the strip carries on at the pace the
      // finger set instead of being yanked the rest of the way.
      const byVelocity =
        releaseSpeed && releaseSpeed > 0
          ? Math.min(SETTLE_MAX_MS, (SETTLE_DECEL * left * span) / releaseSpeed)
          : 0;
      const settle = {
        ms: Math.round(Math.max(floorMs, byVelocity)),
        ease: DRAG_SETTLE_EASE,
      };
      writeTurn(1, true, settle);
      if (turnTimer.current) window.clearTimeout(turnTimer.current);
      turnTimer.current = window.setTimeout(() => finalize(d), settle.ms);
    },
    [finalize, writeTurn],
  );

  const cancelPeek = useCallback(() => {
    if (idleTimer.current) {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    // Same hazard as in `commit` — a queued drag frame would undo the
    // spring-back the moment it starts.
    if (peekRaf.current) {
      window.cancelAnimationFrame(peekRaf.current);
      peekRaf.current = 0;
    }
    turning.current = false;
    accum.current = 0;
    if (reducedRef.current) {
      peekDir.current = 0;
      releaseTurn();
      setPeek(null);
      setPeekIdx(null);
      return;
    }
    // Spring back to 0 before clearing `peekDir`, which `writeTurn` reads.
    writeTurn(0, true);
    peekDir.current = 0;
    if (turnTimer.current) window.clearTimeout(turnTimer.current);
    turnTimer.current = window.setTimeout(() => {
      turnTimer.current = null;
      releaseTurn();
      setPeek(null);
      setPeekIdx(null);
    }, CANCEL_MS);
  }, [writeTurn, releaseTurn]);

  const scheduleIdle = useCallback(() => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null;
      if (!turning.current) cancelPeek();
    }, IDLE_MS);
  }, [cancelPeek]);

  // Push the accumulated drag/overscroll into the layers, coalesced to one
  // write per frame. No React state here — see `writeTurn`.
  const renderPeek = useCallback(() => {
    if (peekRaf.current) return;
    peekRaf.current = window.requestAnimationFrame(() => {
      peekRaf.current = 0;
      const d = peekDir.current;
      if (!d) return;
      const reveal = Math.min(1, accum.current / TURN_PX);
      writeTurn(reveal, false);
      if (reveal >= 1) commit(d);
    });
  }, [commit, writeTurn]);

  // Programmatic turn (arrow keys / edge click): slide a full peek 0→1, swap.
  const animateTurn = useCallback(
    (d: 1 | -1) => {
      const dest = clampIdx(currentRef.current + d);
      if (dest === currentRef.current) return;
      peekDir.current = d;
      peekNeighbor.current = dest;
      accum.current = TURN_PX;
      if (reducedRef.current) {
        finalize(d);
        return;
      }
      turning.current = true;
      turnLive.current = true;
      setPeekIdx(dest);
      setPeek({ dir: d });
      window.requestAnimationFrame(() => {
        // Seat the layers at reveal 0, flush, then animate to 1 on the next
        // frame. WKWebView otherwise coalesces the two writes and the slide
        // snaps — see the two-frame gotcha.
        writeTurn(0, false);
        void peekHostRef.current?.offsetHeight;
        window.requestAnimationFrame(() => {
          writeTurn(1, true);
          if (turnTimer.current) window.clearTimeout(turnTimer.current);
          turnTimer.current = window.setTimeout(() => finalize(d), ANIM_MS);
        });
      });
    },
    [clampIdx, finalize, writeTurn],
  );

  const goToPage = useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(pageCount - 1, i));
      if (flow === "scroll") {
        scrollRef.current?.scrollTo({
          top: layout.top[clamped],
          behavior: reducedMotion ? "auto" : "smooth",
        });
        return;
      }
      if (turning.current || peekDir.current) return; // a turn is already running
      const cur = currentRef.current;
      if (clamped === cur) return;
      if (Math.abs(clamped - cur) === 1) {
        animateTurn((clamped - cur) as 1 | -1);
      } else {
        pendingScroll.current = "top"; // multi-page jump: land at the top
        setCurrent(clamped);
      }
    },
    [flow, layout, pageCount, reducedMotion, animateTurn],
  );

  useImperativeHandle(ref, () => ({ goToPage }), [goToPage]);

  const flip = useCallback((delta: number) => goToPage(current + delta), [goToPage, current]);
  useEffect(() => {
    if (flow !== "paged") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") flip(dir === "rtl" ? +1 : -1);
      else if (e.key === "ArrowRight") flip(dir === "rtl" ? -1 : +1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow, dir, flip]);

  // Paged mode: land the swapped-in page at the right edge — top normally,
  // bottom when turning back. Also pins the first paint to the top so a page
  // taller than the viewport opens at its head rather than centered + clipped.
  useLayoutEffect(() => {
    if (flow !== "paged") return;
    const el = scrollRef.current;
    if (!el) return;
    const mode = pendingScroll.current;
    pendingScroll.current = null;
    el.scrollTop = mode === "bottom" ? el.scrollHeight : 0;
  }, [current, flow]);

  // Paged mode: wheel pans a tall page; at the edge it drags the neighbour in
  // (peek) and only turns past TURN_PX of push. Non-passive so we can swallow
  // the event once we take over. Subscribes once — reads live values via refs.
  useEffect(() => {
    if (flow !== "paged") return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // horizontal gesture
      if (turning.current) {
        e.preventDefault();
        return;
      }
      const down = e.deltaY > 0;
      const d: 1 | -1 = down ? 1 : -1;
      // `peekDir` is set synchronously, so back-to-back wheel events in one
      // frame accumulate instead of each restarting the peek (React state would
      // lag a frame). 0 means no peek is open.
      if (peekDir.current === 0) {
        const max = el.scrollHeight - el.clientHeight;
        const TOL = 4; // a page fit to the viewport is often 1-2px taller
        const atEdge =
          max <= TOL || (down ? el.scrollTop >= max - TOL : el.scrollTop <= TOL);
        if (!atEdge) return; // room to pan — let native scroll do it
        const dest = clampIdx(currentRef.current + d);
        if (dest === currentRef.current) return; // first / last page
        if (e.timeStamp < turnLockUntil.current || peekHold.current != null) {
          e.preventDefault(); // still settling the previous turn
          return;
        }
        e.preventDefault();
        if (turnTimer.current) {
          window.clearTimeout(turnTimer.current); // abort a spring-back mid-flight
          turnTimer.current = null;
        }
        peekDir.current = d;
        peekNeighbor.current = dest;
        accum.current = Math.abs(e.deltaY);
        turnLive.current = true;
        setPeekIdx(dest);
        setPeek({ dir: d });
        renderPeek();
        scheduleIdle();
        return;
      }
      // A peek is in progress: grow it in its direction, shrink on reverse.
      e.preventDefault();
      accum.current += (d === peekDir.current ? 1 : -1) * Math.abs(e.deltaY);
      if (accum.current <= 0) {
        cancelPeek();
        return;
      }
      renderPeek();
      scheduleIdle();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.style.cursor = "";
    };
  }, [flow, clampIdx, renderPeek, scheduleIdle, cancelPeek]);

  // Paged mode on touch: a horizontal drag pans the filmstrip 1:1 with the
  // finger and snaps on release. The wheel path above never fires from a finger,
  // so without this a touch device could only turn pages by tapping an edge.
  // Vertical drags are left alone so the native scroller still pans a tall page.
  useEffect(() => {
    if (flow !== "paged") return;
    const el = scrollRef.current;
    if (!el) return;

    const onStart = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (touch.current.pointerId !== -1) return; // a second finger — ignore
      touch.current = {
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
        axis: "",
        pointerId: e.pointerId,
        samples: [{ x: e.clientX, t: e.timeStamp }],
      };
      suppressClick.current = false;
      // A held finger must not be sprung back by the wheel path's idle timer.
      if (idleTimer.current) {
        window.clearTimeout(idleTimer.current);
        idleTimer.current = null;
      }
    };

    const onMove = (e: PointerEvent) => {
      const s = touch.current;
      if (e.pointerId !== s.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;

      if (s.axis === "") {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (s.axis === "x") {
          // Once this is a page turn, pin the gesture to the scroller so the
          // rest of it arrives here no matter what happens to the node under
          // the finger. Not done at pointerdown: before the axis is known the
          // gesture may still be a text selection, and capturing would steal it.
          try {
            el.setPointerCapture(e.pointerId);
          } catch {
            // capture refused — pointer events still hit-test to the scroller
          }
        }
      }
      if (s.axis === "y") return; // let the scroller pan a tall page

      // Zoomed in: pan the page horizontally first, only turn at the edge. The
      // same 4px tolerance the wheel path uses — a page fit to the viewport
      // routinely overflows by a pixel or two, which must not read as "zoomed"
      // and swallow every drag. RTL engines report scrollLeft negative, so
      // compare on distance from the origin edge.
      const TOL = 4;
      const maxX = overflowX.current;
      if (maxX > TOL) {
        const from = Math.abs(el.scrollLeft);
        const atEdge = dx > 0 ? from <= TOL : from >= maxX - TOL;
        if (!atEdge) {
          // We asked for `touch-action: pan-y` so the page-turn drag could
          // claim horizontal gestures, which also means the compositor will
          // NOT pan this axis for us. Drive it by hand, then rebase the origin
          // so the next move is measured from here (and a subsequent turn
          // starts from zero travel rather than inheriting the pan distance).
          // Clamp against the layout-derived range for the same reason maxX is
          // read from layout — scrollLeft's own bounds move during a turn.
          const next = el.scrollLeft - dx;
          el.scrollLeft = el.scrollLeft < 0 || next < 0
            ? Math.max(-maxX, Math.min(0, next))
            : Math.max(0, Math.min(maxX, next));
          s.x = e.clientX;
          s.samples.length = 0;
          s.samples.push({ x: e.clientX, t: e.timeStamp });
          return;
        }
      }
      if (turning.current || peekHold.current != null) return; // still settling

      // Dragging left advances an LTR book; RTL mirrors it.
      const d = ((dx < 0 ? 1 : -1) * (dir === "rtl" ? -1 : 1)) as 1 | -1;
      if (peekDir.current === 0) {
        const dest = clampIdx(currentRef.current + d);
        if (dest === currentRef.current) return; // first / last page
        peekDir.current = d;
        peekNeighbor.current = dest;
        turnLive.current = true;
        setPeekIdx(dest);
        setPeek({ dir: d });
      } else if (peekDir.current !== d) {
        cancelPeek(); // dragged back past the origin
        return;
      }
      suppressClick.current = true;
      s.samples.push({ x: e.clientX, t: e.timeStamp });
      while (s.samples.length > 2 && e.timeStamp - s.samples[0].t > VELOCITY_WINDOW_MS) {
        s.samples.shift();
      }
      // renderPeek derives reveal as accum/TURN_PX, so expressing the travelled
      // fraction of a viewport in that unit makes the strip follow the finger.
      accum.current = Math.min(1, Math.abs(dx) / (el.clientWidth || 1)) * TURN_PX;
      renderPeek();
    };

    const onEnd = (e: PointerEvent) => {
      const s = touch.current;
      if (e.pointerId !== s.pointerId) return;
      const d = peekDir.current;
      const wasDrag = s.axis === "x";
      s.axis = "";
      s.pointerId = -1;
      if (el.hasPointerCapture?.(e.pointerId)) {
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released
        }
      }
      if (!wasDrag || d === 0 || turning.current) return;
      const dragged = accum.current / TURN_PX; // 0..1 of a viewport
      // A flick only counts toward the turn it was already heading into —
      // `d` is the direction the peek opened in, so require the tail velocity
      // to point the same way before treating it as a throw.
      const vx = releaseVelocity(s.samples);
      const towards = dir === "rtl" ? d : -d; // strip travel sign for this turn
      const flicked = Math.sign(vx) === Math.sign(towards) &&
        Math.abs(vx) >= FLING_PX_MS;
      s.samples = [];
      if (dragged >= SNAP_FRACTION || flicked) commit(d, Math.abs(vx));
      else cancelPeek();
    };

    // Pointer events rather than touch events, because a touch event is
    // delivered to whatever node the gesture STARTED on for its whole life. A
    // DOCX page is a DOM subtree that gets rebuilt on every render, so that
    // node is routinely torn out mid-drag — and the touchend then dispatches
    // into a detached tree and never reaches this listener. The drag was left
    // half-open and the next swipe inherited it, which is why turning a DOCX
    // page took two swipes. Pointer events hit-test each event on its own, and
    // capture (taken at the axis lock above) pins the rest of the gesture here
    // regardless.
    //
    // Passive on purpose: a non-passive move listener takes scrolling off the
    // compositor, and nothing here cancels anything — `touch-action: pan-y`
    // already stops the browser panning horizontally, so the page-turn drag is
    // unopposed while vertical panning stays threaded.
    el.addEventListener("pointerdown", onStart, { passive: true });
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerup", onEnd, { passive: true });
    el.addEventListener("pointercancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onStart);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onEnd);
      el.removeEventListener("pointercancel", onEnd);
    };
  }, [flow, dir, clampIdx, renderPeek, cancelPeek, commit]);

  // Render the peeked page into the overlay host (once per turn — keyed on the
  // page index, not the reveal, so dragging doesn't re-render the pdf).
  useEffect(() => {
    if (peekIdx == null) return;
    const host = peekHostRef.current;
    if (!host) return;
    let cancelled = false;
    (async () => {
      let s = sizes[peekIdx];
      if (!s) {
        try {
          s = await source.pageSize(peekIdx);
        } catch {
          s = { w: 800, h: 1132 };
        }
        if (cancelled) return;
        setSizes((prev) => {
          if (prev[peekIdx]) return prev;
          const next = prev.slice();
          next[peekIdx] = s!;
          return next;
        });
      }
      const sc = (layout.displayW[peekIdx] || usableW) / s.w;
      await source.renderPage(peekIdx, host, sc);
    })();
    return () => {
      cancelled = true;
    };
  }, [peekIdx, layout, sizes, tint, source, usableW]);

  // Whether the page on screen has painted — the gate for warming its
  // neighbours. A boolean, not the cumulative `rendered` Set, so it settles
  // once per page instead of churning.
  const currentRendered = rendered.has(current);

  // Warm the neighbours. Rasterizing a PDF page costs tens of milliseconds on
  // a phone, and doing it when the turn starts lands that cost squarely inside
  // the animation — the single worst frame of a drag. Rendering ahead of time
  // means `renderPage` finds the canvas already drawn at the right scale and
  // just re-parents it (see PdfPageSource), which is free.
  //
  // Held off until the current page is on screen so it never competes with the
  // page the reader is actually looking at, and skipped mid-turn because
  // re-parenting a canvas would yank it out of the overlay using it.
  useEffect(() => {
    if (flow !== "paged" || !currentRendered) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const { sizes: sz, layout: lay, usableW: uw } = prefetchInputs.current;
      // Bias the window towards where the reader is going: the next pages
      // first, then one behind for a change of mind.
      const d = lastDir.current;
      const wanted: number[] = [];
      for (let n = 1; n <= PREFETCH_AHEAD; n++) wanted.push(current + n * d);
      for (let n = 1; n <= PREFETCH_BEHIND; n++) wanted.push(current - n * d);
      for (let k = 0; k < wanted.length; k++) {
        const i = wanted[k];
        const host = warmRefs.current[k];
        if (cancelled || !host || i < 0 || i >= pageCount) continue;
        if (turnLive.current) return; // a turn owns the canvases right now
        let size = sz[i];
        if (!size) {
          try {
            size = await source.pageSize(i);
          } catch {
            continue;
          }
          if (cancelled) return;
        }
        try {
          await source.renderPage(i, host, (lay.displayW[i] || uw) / size.w);
        } catch {
          // a newer render superseded this one — nothing to do
        }
      }
    }, PREFETCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flow, current, currentRendered, pageCount, source]);

  // Seat a freshly-mounted overlay at the turn's current position before the
  // browser paints it. Without this it would appear at the settled spot for one
  // frame and flash. Layout effect so it lands in the same commit as the mount.
  useLayoutEffect(() => {
    if (!peek || !turnLive.current) return;
    writeTurn(revealRef.current, false);
  }, [peek, writeTurn]);

  // Drop the covering overlay the moment the base layer has the page in hand.
  //
  // The overlay exists so a turn never flashes a skeleton, but with canvas
  // reuse the base render RE-PARENTS the bitmap out of the overlay — so once
  // that has happened the overlay is an empty box sitting on top of a page
  // that is ready to show, and holding it is the flash. It must be released on
  // the render completing, not on some derived state changing: this used to
  // key off the cumulative `rendered` Set, which does not change when the page
  // has been visited before, so the drop fell through to the 500ms fallback
  // timer and left an empty overlay covering the reader for half a second.
  const dropOverlayFor = useCallback(
    (page: number) => {
      if (peekHold.current !== page) return;
      peekHold.current = null;
      if (holdTimer.current) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
      releaseTurn();
      setPeek(null);
      setPeekIdx(null);
    },
    [releaseTurn],
  );
  dropOverlayRef.current = dropOverlayFor;

  // ---- Floating scrollbar ---------------------------------------------------

  const updateBar = useCallback(() => {
    const el = scrollRef.current;
    const bar = barRef.current;
    if (!el || !bar) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 2) {
      bar.style.opacity = "0";
      return;
    }
    // Track geometry comes from `BAR` (not the page's PAD) so this bar matches
    // the app-wide overlay one — see styles/overlayScrollbar.ts.
    const trackH = clientHeight - BAR.pad * 2;
    const thumbH = Math.max(
      BAR.minThumb,
      (clientHeight / scrollHeight) * trackH,
    );
    const top = (scrollTop / (scrollHeight - clientHeight)) * (trackH - thumbH);
    bar.style.height = `${thumbH}px`;
    bar.style.transform = `translateY(${BAR.pad + Math.max(0, top)}px)`;
  }, []);

  const flashBar = useCallback(() => {
    const el = scrollRef.current;
    const bar = barRef.current;
    if (!el || !bar || el.scrollHeight <= el.clientHeight + 2) return;
    bar.style.opacity = String(BAR.rest);
    if (barIdle.current) window.clearTimeout(barIdle.current);
    barIdle.current = window.setTimeout(() => {
      if (barRef.current) barRef.current.style.opacity = "0";
    }, BAR.idleMs);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      flashBar();
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        updateBar();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [updateBar, flashBar]);

  useEffect(() => {
    updateBar();
  }, [updateBar, container.w, container.h, current, layout, flow]);

  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      for (const t of [idleTimer, turnTimer, holdTimer, barIdle]) {
        if (t.current) window.clearTimeout(t.current);
      }
      if (peekRaf.current) window.cancelAnimationFrame(peekRaf.current);
    },
    [],
  );

  // Stable ref callback per page index — avoids detach/reattach churn (which
  // would otherwise re-trigger renders on every re-render).
  const hostCb = useCallback((i: number) => {
    let cb = refCbs.current.get(i);
    if (!cb) {
      cb = (el: HTMLDivElement | null) => {
        if (el) hostRefs.current.set(i, el);
        else {
          hostRefs.current.delete(i);
          renderedScale.current.delete(i);
        }
      };
      refCbs.current.set(i, cb);
    }
    return cb;
  }, []);

  // Paged mode: click the left / right edge (18%) to turn. Direction follows
  // reading order and matches the arrow keys — RTL left edge is "next".
  const edgeSideAt = useCallback((clientX: number): -1 | 0 | 1 => {
    const el = scrollRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const frac = (clientX - r.left) / r.width;
    if (frac <= 0.18) return -1;
    if (frac >= 0.82) return 1;
    return 0;
  }, []);
  const onPagedClick = useCallback(
    (e: React.MouseEvent) => {
      if (suppressClick.current) {
        // Trailing click of a drag that already turned the page.
        suppressClick.current = false;
        return;
      }
      const edge = edgeSideAt(e.clientX);
      if (edge !== 0) flip(edge * (dir === "rtl" ? -1 : 1));
    },
    [edgeSideAt, flip, dir],
  );
  const onPagedMove = useCallback(
    (e: React.MouseEvent) => {
      const el = scrollRef.current;
      if (el) el.style.cursor = edgeSideAt(e.clientX) === 0 ? "default" : "pointer";
    },
    [edgeSideAt],
  );

  const skeletonStyle = (
    w: number,
    h: number,
    animate: boolean,
  ): React.CSSProperties => ({
    width: w,
    height: h,
    // No outline on the page itself — the sheet of paper is the content, and a
    // rule around it just reads as chrome. The drop shadow is what separates
    // the page from the background, so it's kept wherever there's a gutter for
    // it to fall into; full-bleed (fit: width) has none, so it's dropped too.
    boxShadow: padX > 0 ? "0 8px 30px rgba(0,0,0,0.22)" : "none",
    backgroundColor: theme.chrome,
    // The shimmer is a loading affordance, so it is only ever painted while
    // there is genuinely nothing to show. A page host is sized from the
    // ESTIMATED layout while its canvas is sized from the real render, and the
    // two disagree by a pixel or two — so an animated gradient underneath a
    // mounted canvas leaks around the edges as a travelling band.
    ...(animate && !reducedMotion
      ? {
          backgroundImage: `linear-gradient(100deg, ${theme.chrome} 30%, ${theme.hover} 50%, ${theme.chrome} 70%)`,
          backgroundSize: "200% 100%",
          animation: "fx-shimmer 1.3s linear infinite",
        }
      : null),
  });

  const visible: number[] = [];
  if (flow === "scroll") {
    for (let i = win.start; i <= win.end; i++) visible.push(i);
  }

  // Keep the touch handler's overflow measure in sync (see `overflowX`).
  overflowX.current = Math.max(0, (layout.displayW[current] || 0) - contentW);

  const nIdx = peekIdx ?? 0;

  // A turn pans across a filmstrip of pages: BOTH layers move as one, the
  // incoming page entering from the edge while the outgoing leaves by exactly
  // the distance the incoming covers. Nothing is dealt on top of a frozen
  // page, so the motion reads as the viewport travelling along the strip.
  //
  // The strip runs sideways on mobile (matching the swipe) and vertically on
  // desktop (matching the wheel) — see the `turnAxis` prop. `mirror` flips a
  // horizontal strip for RTL books, where the next page sits to the left; the
  // same mapping edge-taps already use. A vertical strip is never mirrored:
  // "next" is down in both scripts. Once the base has swapped to the new page
  // (`swapped`) it sits at rest; the overlay still covers at that point, so
  // the reset is never visible.
  const horizontal = axis === "x";
  turnGeom.current = {
    horizontal,
    mirror: horizontal && dir === "rtl" ? -1 : 1,
    span: (horizontal ? container.w : container.h) || 1,
  };

  return (
    <div
      dir={dir}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        // The surround sits a shade behind the page so the sheet reads as a
        // sheet — three of the four themes give `paper` and `bg` the same
        // value, so without this the page vanished into its background once
        // the border and the fit-width gutter were gone.
        background: surfaces.surround,
        // DOCX cards paint themselves from these.
        ...({
          ["--reading-ink"]: theme.ink,
          ["--reading-paper"]: surfaces.page,
        } as React.CSSProperties),
      }}
    >
      <div
        ref={scrollRef}
        className="no-scrollbar"
        // This viewer draws its own floating bar (below), so the app-wide
        // overlay one must not paint a second one over the same container.
        data-no-overlay-scrollbar
        onClick={flow === "paged" ? onPagedClick : undefined}
        onMouseMove={flow === "paged" ? onPagedMove : undefined}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "auto",
          overscrollBehavior: "contain",
          background: theme.bg,
          // Paged: claim horizontal gestures for the page-turn drag. Without
          // this the compositor can take the pan before the touch handler sees
          // it, and the strip never follows the finger.
          touchAction: flow === "paged" ? "pan-y" : undefined,
          // Paged: a scrollable flex box. The page uses margin:auto, so it
          // centers when it fits and pins to the top-start (fully scrollable,
          // head never clipped) when it's taller / wider than the viewport.
          ...(flow === "paged"
            ? { display: "flex", padding: `${PAD}px ${padX}px` }
            : null),
        }}
      >
        {flow === "scroll" ? (
          <div style={{ position: "relative", width: "100%", height: layout.totalH }}>
            {visible.map((i) => (
              <div
                key={i}
                ref={hostCb(i)}
                style={{
                  position: "absolute",
                  top: layout.top[i],
                  left: `calc(50% - ${layout.displayW[i] / 2}px)`,
                  filter: hostFilter,
                  ...skeletonStyle(layout.displayW[i], layout.displayH[i], !rendered.has(i)),
                }}
              />
            ))}
          </div>
        ) : (
          <>
            <div
              key={current}
              ref={hostCb(current)}
              style={{
                margin: "auto",
                flexShrink: 0,
                filter: hostFilter,
                // transform/transition intentionally absent — `writeTurn`
                // owns them, and React must not fight it mid-turn.
                ...skeletonStyle(
                  layout.displayW[current] || 0,
                  layout.displayH[current] || 0,
                  !rendered.has(current),
                ),
              }}
            />
            {/* Offscreen holders for the warmed neighbour pages. Kept out of
                layout and out of the paint — they exist only to own a canvas
                until a turn re-parents it. */}
            {Array.from({ length: PREFETCH_AHEAD + PREFETCH_BEHIND }, (_, k) => (
              <div
                key={`warm-${k}`}
                ref={(el) => {
                  warmRefs.current[k] = el;
                }}
                aria-hidden
                style={{
                  position: "absolute",
                  width: 0,
                  height: 0,
                  overflow: "hidden",
                  visibility: "hidden",
                  pointerEvents: "none",
                }}
              />
            ))}
          </>
        )}
      </div>

      {/* Peek overlay: the incoming page, sliding in from the edge as the turn
          progresses. Pointer-events off so the wheel keeps reaching the scroller
          underneath (which drives the peek). */}
      {flow === "paged" && peek && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
            zIndex: 5,
            display: "flex",
            // Mirror the base scroller's box exactly (flex + PAD + margin:auto
            // on the child) so the page lands where the settled page sits and
            // the swap is invisible.
            padding: `${PAD}px ${padX}px`,
          }}
        >
          <div
            ref={peekHostRef}
            style={{
              margin: "auto",
              flexShrink: 0,
              // transform/transition are written by `writeTurn`; a layout
              // effect seats this at reveal 0 the moment it mounts so it never
              // flashes at the settled position.
              //
              // Never shimmers. The canvas is re-parented into this host
              // synchronously while any React state saying so would land frames
              // later, so a shimmer here ran underneath a page that was already
              // there — leaking round its edges for as long as 450ms. A turn is
              // far too short to want a loading affordance anyway: an
              // unrendered page reads better as a plain sheet than a flashing
              // one.
              // The sliding peek page keeps the same tonal filter as the settled
              // pages (grayscale/invert for a color duotone; else the tint), so
              // it doesn't flash its original colors mid-turn. The colored blend
              // overlays are omitted here — the page picks them up once it lands.
              filter: hostFilter,
              ...skeletonStyle(
                layout.displayW[nIdx] || 0,
                layout.displayH[nIdx] || 0,
                false,
              ),
            }}
          />
        </div>
      )}

      {/* Floating scrollbar — driven imperatively (no re-render), fades out ~0.8s
          after scrolling stops. */}
      <div
        ref={barRef}
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          insetInlineEnd: BAR.inset,
          width: BAR.width,
          height: BAR.minThumb,
          borderRadius: BAR.width,
          background: theme.muted,
          opacity: 0,
          transition: `opacity ${BAR.fadeOutMs}ms ${EASE.out}`,
          pointerEvents: "none",
          zIndex: 6,
        }}
      />
    </div>
  );
});
