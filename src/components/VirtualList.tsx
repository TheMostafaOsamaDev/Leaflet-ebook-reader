// Tiny windowed-list / windowed-grid primitives. Same shape as react-window
// but ~60 lines and zero deps — we don't need variable-height rows or
// sticky headers, just enough to keep multi-thousand-item docx imports
// from drowning the renderer.
//
// Both helpers assume *uniform item height* (or row height for the grid).
// Items outside the scroll viewport — minus an overscan buffer — are not
// mounted at all, so React's reconciliation cost stays bounded by what
// fits on screen.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

interface Viewport {
  scrollTop: number;
  height: number;
}

interface VirtualListProps<T> {
  items: T[];
  /** Pixel height of every row. Rows are clipped to this height. */
  itemHeight: number;
  /** Items to render above + below the viewport. Higher = smoother scroll
   *  but more DOM nodes. 4 is a sensible default for ~80px rows. */
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  itemKey: (item: T, index: number) => string | number;
  style?: CSSProperties;
  className?: string;
  /** Optional aria-label for the scrolling region. */
  ariaLabel?: string;
}

export function VirtualList<T>({
  items,
  itemHeight,
  overscan = 4,
  renderItem,
  itemKey,
  style,
  className,
  ariaLabel,
}: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({
    scrollTop: 0,
    height: 0,
  });

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setViewport((v) =>
      v.scrollTop === el.scrollTop ? v : { ...v, scrollTop: el.scrollTop },
    );
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setViewport((v) =>
        v.height === el.clientHeight ? v : { ...v, height: el.clientHeight },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(
    0,
    Math.floor(viewport.scrollTop / itemHeight) - overscan,
  );
  const end = Math.min(
    items.length,
    Math.ceil((viewport.scrollTop + viewport.height) / itemHeight) + overscan,
  );
  const totalHeight = items.length * itemHeight;
  const slice = items.slice(start, end);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      aria-label={ariaLabel}
      className={className}
      style={{ overflowY: "auto", position: "relative", ...style }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: start * itemHeight,
            left: 0,
            right: 0,
          }}
        >
          {slice.map((item, i) => (
            <div
              key={itemKey(item, start + i)}
              style={{ height: itemHeight, boxSizing: "border-box" }}
            >
              {renderItem(item, start + i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface VirtualGridProps<T> {
  items: T[];
  /** Items per row. Caller picks based on container width — either
   *  observe the wrapper width and pass a derived number, or fix it. */
  columns: number;
  /** Row height including any vertical gap. */
  rowHeight: number;
  /** Pixel gap between cells. Applied to columns; rows handled via
   *  rowHeight. */
  columnGap?: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  itemKey: (item: T, index: number) => string | number;
  style?: CSSProperties;
  className?: string;
  ariaLabel?: string;
}

/** Grid variant — virtualizes rows, paints all `columns` cells per row. */
export function VirtualGrid<T>({
  items,
  columns,
  rowHeight,
  columnGap = 0,
  overscan = 2,
  renderItem,
  itemKey,
  style,
  className,
  ariaLabel,
}: VirtualGridProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({
    scrollTop: 0,
    height: 0,
  });

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setViewport((v) =>
      v.scrollTop === el.scrollTop ? v : { ...v, scrollTop: el.scrollTop },
    );
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setViewport((v) =>
        v.height === el.clientHeight ? v : { ...v, height: el.clientHeight },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const safeColumns = Math.max(1, columns);
  const rowCount = Math.ceil(items.length / safeColumns);
  const startRow = Math.max(
    0,
    Math.floor(viewport.scrollTop / rowHeight) - overscan,
  );
  const endRow = Math.min(
    rowCount,
    Math.ceil((viewport.scrollTop + viewport.height) / rowHeight) + overscan,
  );
  const totalHeight = rowCount * rowHeight;

  const rows: ReactNode[] = [];
  for (let r = startRow; r < endRow; r++) {
    const cells: ReactNode[] = [];
    for (let c = 0; c < safeColumns; c++) {
      const idx = r * safeColumns + c;
      if (idx >= items.length) break;
      const item = items[idx];
      cells.push(
        <div key={itemKey(item, idx)} style={{ minWidth: 0 }}>
          {renderItem(item, idx)}
        </div>,
      );
    }
    rows.push(
      <div
        key={r}
        style={{
          position: "absolute",
          top: r * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
          display: "grid",
          gridTemplateColumns: `repeat(${safeColumns}, minmax(0, 1fr))`,
          columnGap,
          boxSizing: "border-box",
        }}
      >
        {cells}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      aria-label={ariaLabel}
      className={className}
      style={{ overflowY: "auto", position: "relative", ...style }}
    >
      <div style={{ height: totalHeight, position: "relative" }}>{rows}</div>
    </div>
  );
}

interface MeasuredVirtualListProps<T> {
  items: T[];
  /** Height to assume for rows that haven't been measured yet. Only affects
   *  the scrollbar's initial accuracy — measured rows correct it as they
   *  scroll into view. */
  estimatedItemHeight: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  itemKey: (item: T, index: number) => string | number;
  style?: CSSProperties;
  className?: string;
  ariaLabel?: string;
  /** ARIA role for the scrolling container. Pass "list" when the rows are
   *  `role="listitem"` — windowing replaces the `<ul>`/`<li>` parent-child
   *  relationship with absolutely positioned wrappers, so the semantics have
   *  to be restated explicitly. Pass "listbox" when the rows are
   *  `role="option"` instead (e.g. a selection mode) — pair with
   *  `ariaMultiselectable`. The absolutely-positioned per-row wrapper this
   *  component renders carries no role of its own, so it stays transparent
   *  to the accessibility tree and doesn't break either pairing. */
  role?: string;
  /** Sets `aria-multiselectable` on the scrolling container. Only meaningful
   *  when `role="listbox"`. */
  ariaMultiselectable?: boolean;
}

/**
 * Windowed list for rows whose height isn't known up front.
 *
 * `VirtualList` above clips every row to a fixed `itemHeight`, which is fine
 * for the shelf picker but wrong for chapter lists: ~6% of chapter titles are
 * long enough to wrap to a second line, and clipping them would hide content.
 * This variant renders the window, measures what it actually rendered, and
 * feeds those measurements back into the offset table — so a wrapped row
 * simply takes the space it needs.
 *
 * Rows are positioned absolutely from a prefix-sum offset table. Unmeasured
 * rows fall back to `estimatedItemHeight`, so the scrollbar is approximate
 * until you've scrolled past a region and exact afterwards.
 */
export function MeasuredVirtualList<T>({
  items,
  estimatedItemHeight,
  overscan = 6,
  renderItem,
  itemKey,
  style,
  className,
  ariaLabel,
  role,
  ariaMultiselectable,
}: MeasuredVirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({
    scrollTop: 0,
    height: 0,
  });
  // Measured (or estimated) height per index, and the running prefix sum.
  // Refs rather than state: they're written during layout and we re-render
  // explicitly via `revision` only when a measurement actually changed.
  const heights = useRef<number[]>([]);
  const offsets = useRef<number[]>([0]);
  const [, setRevision] = useState(0);
  const rows = useRef(new Map<number, HTMLElement>());

  // Reset when the list identity changes (e.g. a different volume expands).
  const count = items.length;
  if (heights.current.length !== count) {
    const next = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      next[i] = heights.current[i] ?? estimatedItemHeight;
    }
    heights.current = next;
    offsets.current = buildOffsets(next);
    rows.current.clear();
  }

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setViewport((v) =>
      v.scrollTop === el.scrollTop ? v : { ...v, scrollTop: el.scrollTop },
    );
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setViewport((v) =>
        v.height === el.clientHeight ? v : { ...v, height: el.clientHeight },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = offsets.current[count] ?? 0;
  const first = Math.max(0, findIndexForOffset(offsets.current, viewport.scrollTop) - overscan);
  const last = Math.min(
    count,
    findIndexForOffset(offsets.current, viewport.scrollTop + viewport.height) +
      1 +
      overscan,
  );

  // Measure what we just painted. Only re-render when a height actually
  // moved, otherwise this would loop forever.
  useLayoutEffect(() => {
    let changed = false;
    let from = count;
    for (const [index, el] of rows.current) {
      const h = el.offsetHeight;
      if (h > 0 && Math.abs(h - heights.current[index]) > 0.5) {
        heights.current[index] = h;
        if (index < from) from = index;
        changed = true;
      }
    }
    if (changed) {
      offsets.current = buildOffsets(heights.current);
      setRevision((r) => r + 1);
    }
  });

  const slice: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const item = items[i];
    if (item === undefined) break;
    slice.push(
      <div
        key={itemKey(item, i)}
        ref={(el) => {
          if (el) rows.current.set(i, el);
          else rows.current.delete(i);
        }}
        style={{
          position: "absolute",
          top: offsets.current[i],
          left: 0,
          right: 0,
        }}
      >
        {renderItem(item, i)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      aria-label={ariaLabel}
      role={role}
      aria-multiselectable={ariaMultiselectable}
      className={className}
      style={{ overflowY: "auto", position: "relative", ...style }}
    >
      <div style={{ height: total, position: "relative" }}>{slice}</div>
    </div>
  );
}

export function buildOffsets(heights: number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i] + heights[i];
  return out;
}

/** Largest index whose offset is <= `offset`. Binary search over the prefix
 *  sums, so lookup stays O(log n) as the list grows. */
export function findIndexForOffset(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
