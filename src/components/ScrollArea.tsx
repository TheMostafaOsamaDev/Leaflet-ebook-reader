// A scroll container whose bar is painted inside the container rather than by
// the app-wide controller (styles/overlayScrollbar.ts — see it for why the bar
// is a DOM thumb at all).
//
// The one thing it does that the controller can't: `alwaysVisible`, a bar that
// stays painted instead of fading, which a short picker needs as its only cue
// that there is more below the fold. That mode is the sole reason this
// component still exists; folding it into the controller would retire it.
//
// The thumb is positioned imperatively through refs — scrolling must not push
// React renders.

import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { EASE, useReducedMotion } from "../styles/motion";
import { BAR, thumbGeometry } from "../styles/overlayScrollbar";

// Shape, timing and the placement maths all come from styles/overlayScrollbar,
// so this bar and the app-wide one are the same bar. See that module for why
// the numbers are what they are.

export function ScrollArea({
  children,
  color,
  className,
  style,
  scrollStyle,
  alwaysVisible = false,
}: {
  children: ReactNode;
  /** Thumb colour. Pass a theme value — usually `theme.muted`. */
  color: string;
  className?: string;
  /** Applies to the outer (positioning) box. */
  style?: CSSProperties;
  /** Applies to the inner scrolling box. */
  scrollStyle?: CSSProperties;
  /** Keep the thumb painted instead of fading it after the idle window. For
   *  short, bounded lists — a picker where the bar doubles as the only cue
   *  that there is more below the fold. Long reading surfaces want the
   *  default, where the bar stays out of the way. Either way the thumb is
   *  hidden when there is nothing to scroll. */
  alwaysVisible?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const idle = useRef<number | undefined>(undefined);
  const raf = useRef(0);
  const reduced = useReducedMotion();

  /** Local geometry for this thumb, or null when there's nothing to scroll.
   *  The bar is laid out with `insetInlineEnd`, so only the vertical half of
   *  the shared result is used — but going through it keeps the track, the
   *  minimum height and the overscroll clamp identical to the app-wide bar,
   *  and under its tests. */
  const measure = useCallback((el: HTMLDivElement) => {
    return thumbGeometry({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      top: 0,
      left: 0,
      width: el.clientWidth,
      height: el.clientHeight,
      direction: "ltr",
    });
  }, []);

  const place = useCallback(() => {
    const el = scrollRef.current;
    const thumb = thumbRef.current;
    if (!el || !thumb) return;
    const g = measure(el);
    // Nothing to scroll — keep the thumb out of the way entirely.
    if (!g) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.height = `${g.height}px`;
    thumb.style.transform = `translateY(${g.top}px)`;
    // A persistent bar has no idle state to fade from, so paint it as soon as
    // there is something to scroll — including on first layout, before any
    // scroll event has fired.
    if (alwaysVisible) thumb.style.opacity = String(BAR.persistent);
  }, [alwaysVisible, measure]);

  const flash = useCallback(() => {
    const el = scrollRef.current;
    const thumb = thumbRef.current;
    if (!el || !thumb || !measure(el)) return;
    thumb.style.opacity = String(alwaysVisible ? BAR.persistent : BAR.rest);
    if (alwaysVisible) return;
    if (idle.current) window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      if (thumbRef.current) thumbRef.current.style.opacity = "0";
    }, BAR.idleMs);
  }, [alwaysVisible, measure]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      flash();
      if (raf.current) return;
      raf.current = window.requestAnimationFrame(() => {
        raf.current = 0;
        place();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Content or box size changing moves the thumb even without a scroll.
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    place();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf.current) window.cancelAnimationFrame(raf.current);
      if (idle.current) window.clearTimeout(idle.current);
    };
  }, [place, flash]);

  const thumbTransition = reduced
    ? "none"
    : `opacity ${BAR.fadeOutMs}ms ${EASE.out}, transform ${BAR.glideMs}ms ${EASE.out}`;

  // Dragging the thumb. Without this a bar that is invisible at rest would be
  // unusable with a mouse: you could never grab it to drag.
  const onThumbDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = scrollRef.current;
      const thumb = thumbRef.current;
      if (!el || !thumb) return;
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);
      // Track the finger exactly while dragging — easing here would read as
      // the bar lagging behind the pointer, not as smoothness.
      thumb.style.transition = "none";
      const startY = e.clientY;
      const startTop = el.scrollTop;
      // Runway from the shared geometry, not the raw box, so the
      // pointer-to-scroll mapping matches where the bar was actually painted.
      const g = measure(el);
      const travel = g ? g.track - g.height : 0;

      const move = (ev: PointerEvent) => {
        if (travel <= 0) return;
        const ratio = (ev.clientY - startY) / travel;
        el.scrollTop = startTop + ratio * (el.scrollHeight - el.clientHeight);
        flash();
      };
      const up = (ev: PointerEvent) => {
        thumb.releasePointerCapture(ev.pointerId);
        // Restore explicitly: React will not re-apply the inline style unless
        // something else makes this component render.
        thumb.style.transition = thumbTransition;
        thumb.removeEventListener("pointermove", move);
        thumb.removeEventListener("pointerup", up);
        thumb.removeEventListener("pointercancel", up);
      };
      thumb.addEventListener("pointermove", move);
      thumb.addEventListener("pointerup", up);
      thumb.addEventListener("pointercancel", up);
    },
    [flash, measure, thumbTransition],
  );

  return (
    <div className={className} style={{ position: "relative", ...style }}>
      <div
        ref={scrollRef}
        className="no-scrollbar"
        // This component draws its own bar, so the app-wide overlay one must
        // not paint a second one over the same container.
        data-no-overlay-scrollbar
        style={{ overflowY: "auto", height: "100%", ...scrollStyle }}
      >
        {children}
      </div>
      <div
        ref={thumbRef}
        onPointerDown={onThumbDown}
        aria-hidden
        style={{
          position: "absolute",
          // Logical inset so the bar lands on the correct edge under dir=rtl.
          insetInlineEnd: BAR.inset,
          top: 0,
          width: BAR.width,
          borderRadius: BAR.width,
          background: color,
          opacity: 0,
          // No track element at all — the bar floats over the content.
          transition: thumbTransition,
          touchAction: "none",
          cursor: "grab",
        }}
      />
    </div>
  );
}
