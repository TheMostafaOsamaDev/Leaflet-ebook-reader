import { useLayoutEffect, useRef, useState } from "react";
import {
  placePopover,
  type Placement,
  type PlacementInput,
  type Side,
} from "../lib/popoverPlacement";
import { useReducedMotion } from "../styles/motion";

/** Gap between the toolbar and both its anchor and the bounds. */
const MARGIN = 8;

interface Options {
  /** Re-measures the thing the popover is attached to. Returning null
   *  means it is gone (selection collapsed, `<mark>` unmounted) — the
   *  popover then reports `visible: false`.
   *
   *  Called on every scroll frame, so keep it cheap: one
   *  `getBoundingClientRect()` is the intended cost. */
  getAnchor: () => DOMRect | null;
  placement: PlacementInput["placement"];
  /** How much chrome each end of the reading region is under. Each
   *  reader has its own bars — the desktop's are 66/65 tall, the
   *  phone's are 44 — and a toolbar clamped to the wrong ones parks
   *  inside the text or fades out over a selection still on screen.
   *
   *  Insets rather than absolute bounds so a resize cannot leave them
   *  stale: they are resolved against the live viewport on each
   *  reposition. */
  insets: { top: number; bottom: number };
}

/**
 * Keeps a fixed-position popover glued to a rect that moves.
 *
 * The reader deliberately does not re-render React on scroll — the
 * scroll listeners in DesktopReader/MobileReader write through refs for
 * exactly that reason. So the tracking lives HERE, inside the popover
 * component, where a scroll frame re-renders one small toolbar instead
 * of the whole reading column.
 *
 * Returns the popover's own ref (so it can measure itself, rather than
 * guessing its height as the two popovers used to) and a ready-to-spread
 * style.
 */
export function useTrackedAnchor({ getAnchor, placement, insets }: Options) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [place, setPlace] = useState<Placement | null>(null);
  const reducedMotion = useReducedMotion();

  // The side is decided once, on the first placement, and then held.
  // See `lockedSide` in popoverPlacement for why.
  const sideRef = useRef<Side | undefined>(undefined);

  // Kept in refs so the scroll listener below can stay mounted for the
  // popover's whole life. Re-subscribing whenever the toolbar changes
  // size — which it does on mount, and again whenever the note editor
  // opens — would drop frames mid-scroll.
  const getAnchorRef = useRef(getAnchor);
  getAnchorRef.current = getAnchor;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  const boundsNow = (): PlacementInput["bounds"] => ({
    top: insetsRef.current.top,
    bottom: window.innerHeight - insetsRef.current.bottom,
    left: 0,
    right: window.innerWidth,
  });

  // Measure ourselves. The popover changes shape as the user opens the
  // note editor, so this follows those changes rather than measuring
  // once — `estimatedHeight` guesses are what made the old flip-above
  // decision wrong for the taller note layout.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) =>
        prev.width === r.width && prev.height === r.height
          ? prev
          : { width: r.width, height: r.height },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Layout effect, not effect: the first placement has to land before
  // the browser paints, or the toolbar flashes at its unpositioned spot
  // for one frame.
  useLayoutEffect(() => {
    let frame = 0;

    const reposition = () => {
      frame = 0;
      const anchor = getAnchorRef.current();
      if (!anchor) {
        setPlace((prev) =>
          prev && prev.visible ? { ...prev, visible: false } : prev,
        );
        return;
      }
      const next = placePopover({
        anchor,
        size: sizeRef.current,
        bounds: boundsNow(),
        placement,
        margin: MARGIN,
        lockedSide: sideRef.current,
      });
      sideRef.current = next.side;
      setPlace((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.visible === next.visible
          ? prev
          : next,
      );
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(reposition);
    };

    reposition();
    // Capture phase: the scroll that matters happens on the reading
    // column, an inner element whose scroll events do not bubble to
    // window at all.
    //
    // Scroll and resize are the whole set. The paginated modes move
    // text by transform rather than scroll, so they fire neither — but
    // every control that turns a page there is a click, and a click
    // outside the toolbar dismisses it before the text moves. Listening
    // for wheel/keydown/transitionend to catch a turn that cannot
    // happen only bought false wakeups: one per keystroke typed into
    // the note editor, and one per swatch transition ending.
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [placement]);

  // Re-place when our own size changes, without re-subscribing above.
  useLayoutEffect(() => {
    const anchor = getAnchorRef.current();
    if (!anchor) return;
    const next = placePopover({
      anchor,
      size,
      bounds: boundsNow(),
      placement,
      margin: MARGIN,
      lockedSide: sideRef.current,
    });
    sideRef.current = next.side;
    setPlace((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.visible === next.visible
        ? prev
        : next,
    );
  }, [size, placement]);

  // Until the first placement lands, the toolbar has no honest position
  // to be drawn at — it has not been measured, so it does not yet know
  // its own size, and drawing it anywhere for that frame is the "it
  // appears somewhere strange and then moves" flicker. So it renders,
  // to be measured, but stays invisible until the number is real.
  const shown = place !== null && place.visible;

  return {
    ref,
    visible: shown,
    style: {
      position: "fixed" as const,
      top: place?.top ?? 0,
      left: place?.left ?? 0,
      // Fade rather than unmount, so scrolling the selection back into
      // view brings the same toolbar back instead of a new one.
      opacity: shown ? 1 : 0,
      pointerEvents: shown ? ("auto" as const) : ("none" as const),
      // No transition on the very first paint, or the toolbar fades in
      // from the top-left corner of the window.
      transition:
        place === null || reducedMotion ? undefined : "opacity 140ms ease-out",
      // Never let a mid-scroll re-place animate: the position must track
      // the text exactly, frame for frame.
      willChange: "top, left, opacity",
    },
  };
}
