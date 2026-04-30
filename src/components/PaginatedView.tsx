import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Paginated layout for the reader. Lays the chapter content into CSS
 * columns sized so exactly N columns fit the visible area, then paginates
 * by translating the inner element horizontally one page-stride at a time.
 *
 * Page stride is `containerWidth + columnGap`, not just `containerWidth` —
 * CSS multicol places a `gap` between columns, which means jumping to the
 * next page also has to skip that gap. Otherwise the next page's first
 * column lands a `gap`-px sliver too far right (LTR) or too far left (RTL).
 *
 * RTL is supported natively: when `rtl` is true, the inner element's
 * `direction` is set to rtl so CSS flows columns right-to-left, and the
 * transform sign flips so paging "forward" still moves the reader through
 * the chapter in source order.
 *
 * Position is preserved through an "anchor paragraph": the paragraph
 * (closest to the start of the page) the reader was last on. On resize,
 * mode switch, or chapter remount, we land on whichever page contains
 * that paragraph, so the reader keeps its place no matter how the layout
 * reflows.
 */
export interface PaginatedAPI {
  nextPage(): boolean;
  prevPage(): boolean;
  atFirstPage: boolean;
  atLastPage: boolean;
  totalPages: number;
}

interface Props {
  /** Paragraphs in BookBody carry `data-p-index` attributes — we use those
      to locate paragraphs in the column layout. */
  columnsPerPage: 1 | 2;
  columnGap?: number;
  /** RTL books flow columns right-to-left. Derived from the book's
      language tag in the parent. */
  rtl?: boolean;
  /** Paragraph index to land on when this view first mounts (or after the
      `children` content changes — typically chapter switch). */
  initialParagraph: number;
  /** Fires whenever the visible page changes, with the leftmost paragraph
      (in source order) on the new page. The caller persists this so resume
      works. */
  onParagraphChange?: (paragraphIndex: number) => void;
  /** Receives an imperative API for keyboard / button page navigation. */
  onApi?: (api: PaginatedAPI) => void;
  children: ReactNode;
}

export function PaginatedView({
  columnsPerPage,
  columnGap = 56,
  rtl = false,
  initialParagraph,
  onParagraphChange,
  onApi,
  children,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // The "anchor" is the paragraph we want to keep on screen across
  // resizes — initialized from the resume position, then updated as the
  // user pages forward. Stored in a ref so resize-driven re-measurement
  // doesn't fight with the most-recent user navigation.
  const anchorParagraphRef = useRef(initialParagraph);

  // Reset the anchor when the parent hands us a new initialParagraph
  // (chapter change, jump-to-highlight, etc.). We compare against the
  // ref's current value so a no-op prop update doesn't clobber an
  // already-paginated position.
  const initialParagraphRef = useRef(initialParagraph);
  if (initialParagraphRef.current !== initialParagraph) {
    initialParagraphRef.current = initialParagraph;
    anchorParagraphRef.current = initialParagraph;
  }

  // Container size — drives column width math.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const colW =
    size.w > 0
      ? columnsPerPage === 2
        ? Math.max(1, (size.w - columnGap) / 2)
        : size.w
      : 0;
  // Distance to advance per page. Each page covers `columnsPerPage`
  // columns plus their separating gaps, including a trailing gap before
  // the next page's first column.
  const pageStride = size.w > 0 ? size.w + columnGap : 0;

  // Maps a paragraph element's `offsetLeft` to "distance from the first
  // column" — that's what we use to compute page index. In LTR the first
  // column is at offsetLeft 0 and content extends to the right; in RTL
  // the first column sits at the right edge of the inner box and content
  // extends leftward (negative offsetLeft).
  const relPos = (
    paragraphOffsetLeft: number,
    firstColOffsetLeft: number,
  ): number => {
    return rtl
      ? firstColOffsetLeft - paragraphOffsetLeft
      : paragraphOffsetLeft - firstColOffsetLeft;
  };

  // After every layout pass: recompute total pages and re-anchor the
  // viewport on the tracked paragraph. This effect handles mount, chapter
  // change (children update), mode switch, and container resize uniformly.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || pageStride === 0) return;
    const ps = inner.querySelectorAll<HTMLElement>("[data-p-index]");
    if (ps.length === 0) {
      setTotalPages(1);
      setPage(0);
      return;
    }
    // The lowest-indexed paragraph anchors the chapter start — its column
    // offset gives us the "origin" against which all other paragraph
    // positions are measured.
    let firstP: HTMLElement = ps[0];
    let firstIdx = Number(firstP.dataset.pIndex);
    for (const p of ps) {
      const idx = Number(p.dataset.pIndex);
      if (idx < firstIdx) {
        firstIdx = idx;
        firstP = p;
      }
    }
    const firstOffset = firstP.offsetLeft;

    // Total pages from the largest forward-direction relPos seen across
    // all paragraphs. Using paragraphs (not scrollWidth) sidesteps a
    // long-standing browser inconsistency in how scrollWidth is reported
    // for RTL multicol overflow.
    let maxRel = 0;
    for (const p of ps) {
      const r = relPos(p.offsetLeft, firstOffset);
      if (r > maxRel) maxRel = r;
    }
    const total = Math.max(
      1,
      Math.floor(maxRel / pageStride) + 1,
    );
    setTotalPages(total);

    // Anchor: page containing the tracked paragraph.
    const anchor = anchorParagraphRef.current;
    const anchorEl = inner.querySelector<HTMLElement>(
      `[data-p-index="${anchor}"]`,
    );
    const anchorPage = anchorEl
      ? Math.min(
          total - 1,
          Math.max(0, Math.floor(relPos(anchorEl.offsetLeft, firstOffset) / pageStride)),
        )
      : 0;
    setPage((prev) => (prev === anchorPage ? prev : anchorPage));
    // Deps deliberately include rtl/columnsPerPage/columnGap so a setting
    // change re-anchors. `children` is unstable across renders but that's
    // fine — it just triggers a remeasure when chapter content changes.
  }, [size.w, size.h, children, columnsPerPage, columnGap, rtl, pageStride]);

  // Whenever the visible page changes, find the first paragraph (in
  // source order) that starts on this page and update the anchor +
  // bubble up to the parent.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner || pageStride === 0) return;
    const ps = inner.querySelectorAll<HTMLElement>("[data-p-index]");
    if (ps.length === 0) return;
    let firstP: HTMLElement = ps[0];
    let firstIdx = Number(firstP.dataset.pIndex);
    for (const p of ps) {
      const idx = Number(p.dataset.pIndex);
      if (idx < firstIdx) {
        firstIdx = idx;
        firstP = p;
      }
    }
    const firstOffset = firstP.offsetLeft;
    const min = page * pageStride;
    const max = (page + 1) * pageStride;
    let chosen: number | null = null;
    let chosenSourceIdx = Number.POSITIVE_INFINITY;
    for (const p of ps) {
      const r = relPos(p.offsetLeft, firstOffset);
      // +1 tolerance — paragraphs sitting exactly on a page boundary
      // sometimes report a fractional offsetLeft.
      if (r + 1 >= min && r < max) {
        const idx = Number(p.dataset.pIndex);
        // Pick the earliest paragraph (in source order) so the anchor is
        // stable when paragraphs span multiple columns.
        if (idx < chosenSourceIdx) {
          chosenSourceIdx = idx;
          chosen = idx;
        }
      }
    }
    // No paragraph *starts* on this page (it's a continuation of a long
    // paragraph that began earlier) — keep the previous anchor so we
    // don't lose our place.
    if (chosen === null) return;
    anchorParagraphRef.current = chosen;
    onParagraphChange?.(chosen);
  }, [page, pageStride, children, rtl, onParagraphChange]);

  // Expose the imperative paging API.
  useEffect(() => {
    if (!onApi) return;
    onApi({
      nextPage: () => {
        if (page >= totalPages - 1) return false;
        setPage(page + 1);
        return true;
      },
      prevPage: () => {
        if (page <= 0) return false;
        setPage(page - 1);
        return true;
      },
      atFirstPage: page <= 0,
      atLastPage: page >= totalPages - 1,
      totalPages,
    });
  }, [page, totalPages, onApi]);

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        ref={innerRef}
        dir={rtl ? "rtl" : "ltr"}
        style={{
          width: "100%",
          // Fixed height + column-fill: auto is what makes content
          // overflow horizontally into additional columns rather than
          // stacking vertically.
          height: size.h || "100%",
          columnGap: `${columnGap}px`,
          columnFill: "auto",
          ...(colW > 0 ? { columnWidth: `${colW}px` } : {}),
          // RTL pages flow right-to-left, so paging forward means moving
          // the inner element rightward to reveal its leftmost (later)
          // columns; LTR is the mirror.
          transform: `translateX(${(rtl ? 1 : -1) * page * pageStride}px)`,
          transition: "transform 220ms ease",
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}
