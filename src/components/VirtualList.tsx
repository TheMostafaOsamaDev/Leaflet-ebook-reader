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
