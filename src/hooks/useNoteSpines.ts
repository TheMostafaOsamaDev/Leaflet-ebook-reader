import { useLayoutEffect, useState, type RefObject } from "react";
import { noteSpineBox, type SpineBox } from "../styles/noteSpine";

export interface NoteSpine extends SpineBox {
  id: string;
}

/**
 * Measure the noted highlights inside `containerRef`.
 *
 * Positions are relative to the CONTAINER, not the viewport, and the
 * container is the paragraph the highlight lives in. That is what makes
 * this work in every reading mode without a single scroll or page-turn
 * listener: the browser already lays each paragraph out — in the
 * scrolled column, or inside one of the paginated view's CSS columns —
 * and an absolutely-positioned child of that paragraph goes wherever
 * the paragraph went.
 *
 * Call this from the component that OWNS the container element, not
 * from a child of it. React attaches a host element's ref before
 * running its parent component's layout effects but after running its
 * children's, so a child measuring its parent sees `null` on the mount
 * commit — which is a guarantee, not a race, and previously cost a
 * frame-by-frame retry loop to paper over.
 *
 * The one thing that genuinely cannot be known up front is when the
 * text settles: a mark that is in the DOM but not yet laid out has no
 * boxes. That is exactly what the ResizeObserver reports — it delivers
 * an initial callback once the element is rendered and stays quiet
 * while it is not — and it goes on reporting the later reflows too:
 * window resize, font size, reading width, columns changing, a panel
 * opening beside the column.
 */
export function useNoteSpines(
  containerRef: RefObject<HTMLElement | null>,
  ids: string[],
  /** Anything that reflows the text WITHOUT resizing the container — a
   *  rewrap that keeps the block height but moves a mark between lines.
   *  The observer cannot see those. */
  deps: unknown[] = [],
): NoteSpine[] {
  const [spines, setSpines] = useState<NoteSpine[]>([]);
  const key = ids.join(",");

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || ids.length === 0) {
      setSpines((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const measure = () => {
      const base = container.getBoundingClientRect();
      const next: NoteSpine[] = [];
      for (const id of ids) {
        const mark = container.querySelector<HTMLElement>(
          `[data-h-id="${id}"]`,
        );
        if (!mark) continue;
        const box = noteSpineBox(Array.from(mark.getClientRects()), base);
        if (box) next.push({ id, ...box });
      }
      setSpines((prev) => (same(prev, next) ? prev : next));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    // Webfonts land after first paint and move every line under them,
    // without changing the block's height.
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, key, ...deps]);

  return spines;
}

function same(a: NoteSpine[], b: NoteSpine[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => {
    const n = b[i];
    // Sub-pixel churn is not worth a render.
    return (
      m.id === n.id &&
      Math.abs(m.top - n.top) < 0.5 &&
      Math.abs(m.height - n.height) < 0.5
    );
  });
}
