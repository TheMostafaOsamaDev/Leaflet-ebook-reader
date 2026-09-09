// App-wide overlay scrollbar: a slim, translucent bar that floats over the
// content while a container is scrolling, then fades out.
//
// Why a DOM thumb rather than `::-webkit-scrollbar`
// ------------------------------------------------
// The pseudo-element route can't produce the bar we want, for three reasons
// that are all engine limitations rather than tuning problems:
//
//   1. Chromium and WebKit ignore `transition` on scrollbar pseudo-elements,
//      so a thumb that is transparent at rest *snaps* out instead of fading.
//   2. A native gutter is always flush to the container edge — there is no
//      way to inset the bar from it.
//   3. It renders differently per platform (Android WebView and WKWebView
//      paint their own overlay bars and ignore parts of the styling; headless
//      Chromium ignores it outright), so it can't be pinned down or tested.
//
// A DOM thumb fixes all three and looks identical everywhere.
//
// One delegated listener covers every scroll area in the app — no per-
// component wiring, and a scroll surface added later gets the behaviour for
// free. Thumbs are positioned imperatively, so scrolling never pushes a React
// render. Opt a container out with `data-no-overlay-scrollbar` (the fixed-page
// viewer and ScrollArea do, since they ship their own bar).

import {
  EASE,
  MOTION,
  isReducedMotion,
  subscribeReducedMotion,
} from "./motion";

/** The bar's shape and rhythm. Shared with the two components that draw their
 *  own thumb (ScrollArea, FixedPageViewer) so all three match. */
export const BAR = {
  /** Visible bar width. Slim enough to read as a hint, not chrome. */
  width: 4,
  /** Width of the invisible grab strip around the bar. The bar itself is too
   *  thin to hit with a mouse; this widens the target to a usable size
   *  without widening the paint. Must stay within `inset * 2 + width` so it
   *  never spills outside the container and swallows adjacent clicks. */
  hit: 14,
  /** Gap between the bar and the container's inline (trailing) edge. */
  inset: 6,
  /** Gap between the track and the container's top/bottom edges. */
  pad: 4,
  /** Floor on thumb height, so a very long document still leaves something
   *  grabbable. */
  minThumb: 28,
  /** Opacity while scrolling. Deliberately faint — a transient position hint
   *  over a page of text, not chrome. Around 1.4:1 against the page in every
   *  theme, which is fine for a decorative indicator (the content is
   *  scrollable by every other means) but is why the two states below are
   *  much stronger. */
  rest: 0.28,
  /** Opacity while the pointer is over the grab strip. Here the bar stops
   *  being an indicator and becomes a drag control, so it has to clear the
   *  3:1 WCAG non-text minimum — 0.7 lands at 3.0:1 in all four themes
   *  (sepia, light, dark, oled). Don't lower it without re-measuring. */
  hover: 0.7,
  /** Opacity while being dragged (~4:1). */
  drag: 0.85,
  /** Opacity for a bar that is painted continuously rather than faded in and
   *  out — see ScrollArea's `alwaysVisible`. Between the two: it has to read
   *  at a glance without turning a small picker into striped chrome. */
  persistent: 0.45,
  /** Idle window before the bar fades. */
  idleMs: 800,
  /** Fade in fast (it should feel like it was already there) and out slowly
   *  (the eye shouldn't be pulled back to a bar that is leaving). The fade-in
   *  is below the app's shortest motion token on purpose — an indicator
   *  appearing under the reader's thumb should not read as an animation. */
  fadeInMs: 120,
  fadeOutMs: MOTION.med,
  /** How long the thumb takes to catch up to a new position.
   *
   *  Short on purpose. A wheel notch or a PageDown moves the content in one
   *  discrete jump and without this the thumb teleports with it; easing the
   *  transform turns those steps into a glide. Much past ~150ms and the thumb
   *  visibly trails a continuous scroll, which reads as lag rather than
   *  smoothness. Suppressed while dragging, where any easing means the bar
   *  lags the finger. */
  glideMs: 120,
} as const;

/** Slack for sub-pixel layout rounding: a container within this many pixels of
 *  its content isn't really scrollable. */
const SLACK = 2;

/** Everything `thumbGeometry` needs about a scroll container: its scroll
 *  position, its viewport rect, and which edge its bar belongs on. */
export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Viewport rect of the container. */
  top: number;
  left: number;
  width: number;
  height: number;
  direction: "ltr" | "rtl";
  /** The container's own vertical padding. The track keeps out of it, so a
   *  scroller that pads its content clear of floating chrome (the reader
   *  columns pad for the frosted top/bottom bars) doesn't get a bar running
   *  across that chrome. Optional: absent means no padding. */
  paddingTop?: number;
  paddingBottom?: number;
};

/** Where to paint the visible bar, in viewport coordinates. `track` is the
 *  length of the runway it travels, which the drag handler needs to convert
 *  pointer movement into scroll distance. */
export type ThumbRect = {
  top: number;
  left: number;
  height: number;
  track: number;
};

/** Place the bar for one container, or `null` when it shouldn't be painted at
 *  all (nothing to scroll, or a collapsed box).
 *
 *  Pure, so the geometry that actually matters is testable without a DOM —
 *  see overlayScrollbar.test.ts. */
export function thumbGeometry(m: ScrollMetrics): ThumbRect | null {
  if (m.width <= 0 || m.height <= 0) return null;
  if (m.scrollHeight <= m.clientHeight + SLACK) return null;

  // Keep the track inside the container's padding. If the padding is so deep
  // that there'd be no usable track left, ignore it and use the whole box —
  // a stub of a bar is worse than one that overlaps a little.
  const padTop = m.paddingTop ?? 0;
  const padBottom = m.paddingBottom ?? 0;
  const padded = m.height - padTop - padBottom - BAR.pad * 2;
  const usePadding = padded >= BAR.minThumb;
  const offset = usePadding ? padTop : 0;
  const track = usePadding ? padded : m.height - BAR.pad * 2;
  if (track <= 0) return null;

  const visible = (m.clientHeight / m.scrollHeight) * track;
  const height = Math.min(track, Math.max(BAR.minThumb, visible));

  const max = m.scrollHeight - m.clientHeight;
  // Clamp the ratio rather than the result: rubber-banding on iOS/Android
  // reports a scrollTop outside [0, max], which would otherwise push the
  // thumb past the ends of its track.
  const progress = max > 0 ? Math.min(1, Math.max(0, m.scrollTop / max)) : 0;

  return {
    top: m.top + offset + BAR.pad + progress * (track - height),
    left:
      m.direction === "rtl"
        ? m.left + BAR.inset
        : m.left + m.width - BAR.inset - BAR.width,
    height,
    track,
  };
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

const HOST_ID = "riwaq-scrollbars";
const OPT_OUT = "data-no-overlay-scrollbar";
/** How far the grab strip extends past each side of the visible bar. */
const OVERHANG = (BAR.hit - BAR.width) / 2;

type Thumb = {
  /** The grab strip. Carries the opacity, so the bar inside it fades too. */
  strip: HTMLDivElement;
  /** Runway left for the thumb at its last placement (track minus its own
   *  height). The drag handler converts pointer movement with this rather
   *  than re-measuring, so the mapping can't drift from where the bar was
   *  actually painted — which matters under padding, where the track is
   *  shorter than the box. */
  travel: number;
  /** Idle timer id, or 0. */
  idle: number;
  /** Set by a scroll event, cleared when the next frame paints it. Placement
   *  is measured once per frame, not once per event, so a scroll never does
   *  the rect + computed-style reads twice. */
  wake: boolean;
  shown: boolean;
  hovered: boolean;
  dragging: boolean;
  /** Last values written to the strip, so a scrolling frame only touches the
   *  one property that actually changes (the transform). */
  lastTransition: string;
  lastOpacity: string;
  lastHeight: string;
  /** Drops the strip's own listeners. */
  abort: AbortController;
};

const isScrollable = (el: Element): boolean => {
  if (el.scrollHeight <= el.clientHeight + SLACK) return false;
  const overflow = getComputedStyle(el).overflowY;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
};

/** Nearest ancestor (self included) that actually scrolls vertically and
 *  hasn't opted out. */
const scrollerFor = (start: Element | null): HTMLElement | null => {
  for (let el = start; el; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.hasAttribute(OPT_OUT)) return null;
    if (isScrollable(el)) return el;
  }
  return null;
};

/** Start painting overlay scrollbars. Returns a cleanup that removes every
 *  listener and takes the bars back out of the DOM. */
export function installOverlayScrollbar(): () => void {
  if (typeof document === "undefined") return () => {};

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  document.body.appendChild(host);

  const thumbs = new Map<HTMLElement, Thumb>();
  /** The scroller the pointer is inside. Only this one's grab strip is
   *  hit-testable — otherwise a strip left over from a scroller now behind a
   *  dialog would sit on top of it and eat clicks. Distinct from
   *  `Thumb.hovered`, which means the pointer is over the strip itself. */
  let armed: HTMLElement | null = null;
  let placeRaf = 0;

  const fineQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
  // The app-wide preference, not just the OS query: the user-facing Reduce
  // motion control has to reach the scrollbar like every other surface.
  let reduced = isReducedMotion();

  const transitionFor = (t: Thumb) => {
    if (reduced) return "none";
    const ms = t.shown ? BAR.fadeInMs : BAR.fadeOutMs;
    // No glide while dragging — there, easing reads as the bar lagging the
    // pointer rather than as smoothness.
    return t.dragging
      ? `opacity ${ms}ms ${EASE.out}`
      : `opacity ${ms}ms ${EASE.out}, transform ${BAR.glideMs}ms ${EASE.out}`;
  };

  // Style writes go through these so a scrolling frame only re-parses what
  // changed. In the steady state that leaves just the transform.
  const setTransition = (t: Thumb, value: string) => {
    if (t.lastTransition === value) return;
    t.lastTransition = value;
    t.strip.style.transition = value;
  };
  const setOpacity = (t: Thumb, value: number) => {
    const s = String(value);
    if (t.lastOpacity === s) return;
    t.lastOpacity = s;
    t.strip.style.opacity = s;
  };

  const destroy = (el: HTMLElement) => {
    const t = thumbs.get(el);
    if (!t) return;
    if (t.idle) window.clearTimeout(t.idle);
    t.abort.abort();
    t.strip.remove();
    thumbs.delete(el);
    if (armed === el) armed = null;
  };

  const hide = (t: Thumb) => {
    if (!t.shown) return;
    t.shown = false;
    setTransition(t, transitionFor(t));
    setOpacity(t, 0);
  };

  const show = (el: HTMLElement, t: Thumb) => {
    // A bar that has been invisible has a stale position: its transform still
    // points wherever it was last painted, and before its first placement it
    // sits at the host's origin — the top-left corner of the viewport. Landing
    // there with the glide live animated it across the screen on first
    // appearance. So place it with motion off and flush that, then restore the
    // transition; the fade-in runs from the correct place.
    const wasHidden = !t.shown;
    if (wasHidden) setTransition(t, "none");
    // Re-measure before painting, for the same reason.
    if (!place(el, t)) return;
    if (wasHidden) void t.strip.offsetHeight;
    t.shown = true;
    setTransition(t, transitionFor(t));
    setOpacity(t, t.dragging ? BAR.drag : t.hovered ? BAR.hover : BAR.rest);
  };

  /** Position one thumb. Returns false when it shouldn't be painted, having
   *  already hidden it. */
  const place = (el: HTMLElement, t: Thumb): boolean => {
    const r = el.getBoundingClientRect();
    // Scrolled out of view (or inside a collapsed/hidden ancestor) — the strip
    // is position:fixed, so nothing else would clip it.
    const offscreen =
      r.bottom <= 0 ||
      r.top >= window.innerHeight ||
      r.right <= 0 ||
      r.left >= window.innerWidth;
    let g: ThumbRect | null = null;
    if (!offscreen) {
      const cs = getComputedStyle(el);
      g = thumbGeometry({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        direction: cs.direction === "rtl" ? "rtl" : "ltr",
        paddingTop: parseFloat(cs.paddingTop) || 0,
        paddingBottom: parseFloat(cs.paddingBottom) || 0,
      });
    }
    if (!g) {
      t.travel = 0;
      hide(t);
      return false;
    }
    t.travel = g.track - g.height;
    const height = `${g.height}px`;
    if (t.lastHeight !== height) {
      t.lastHeight = height;
      t.strip.style.height = height;
    }
    t.strip.style.transform = `translate3d(${g.left - OVERHANG}px, ${g.top}px, 0)`;
    return true;
  };

  /** Re-place every live thumb, paint the ones a scroll just woke, and drop
   *  the ones whose container has left the DOM.
   *
   *  Every thumb, not just the scrolling one: an ancestor scrolling or the
   *  window resizing moves a container's rect without firing a scroll on the
   *  container itself, so position can't be updated only from its own events.
   *
   *  The liveness sweep has to cover hidden thumbs too. A dialog that is
   *  scrolled, faded out and then unmounted is never visited again otherwise,
   *  and its entry would pin the whole detached subtree plus two DOM nodes for
   *  the rest of the session. `isConnected` is a plain field, so sweeping
   *  every entry costs nothing. */
  const placeAll = () => {
    for (const [el, t] of thumbs) {
      if (!el.isConnected) {
        destroy(el);
        continue;
      }
      const waking = t.wake;
      t.wake = false;
      if (waking) show(el, t);
      else if (t.shown) place(el, t);
    }
  };

  const scheduleFade = (t: Thumb) => {
    if (t.idle) window.clearTimeout(t.idle);
    t.idle = 0;
    // Hovering or dragging holds the bar open — it would be unusable if it
    // faded out from under the pointer.
    if (t.hovered || t.dragging) return;
    t.idle = window.setTimeout(() => {
      t.idle = 0;
      hide(t);
    }, BAR.idleMs);
  };

  const create = (el: HTMLElement): Thumb => {
    const strip = document.createElement("div");
    strip.className = "riwaq-sb-strip";
    // Width comes from BAR rather than the stylesheet: `thumbGeometry` places
    // the bar's edge from `BAR.width` and OVERHANG centres the strip on it, so
    // a CSS literal that drifted would shift the bar off its own grab strip
    // with nothing failing.
    strip.style.width = `${BAR.hit}px`;
    const bar = document.createElement("div");
    bar.className = "riwaq-sb-bar";
    bar.style.width = `${BAR.width}px`;
    bar.style.borderRadius = `${BAR.width}px`;
    strip.appendChild(bar);
    host.appendChild(strip);

    const t: Thumb = {
      strip,
      travel: 0,
      idle: 0,
      wake: false,
      shown: false,
      hovered: false,
      dragging: false,
      lastTransition: "",
      lastOpacity: "",
      lastHeight: "",
      abort: new AbortController(),
    };
    const { signal } = t.abort;

    strip.addEventListener(
      "pointerenter",
      () => {
        t.hovered = true;
        scheduleFade(t); // clears the timer; `hovered` keeps it cleared
        show(el, t);
      },
      { signal },
    );
    strip.addEventListener(
      "pointerleave",
      () => {
        t.hovered = false;
        if (!t.dragging) scheduleFade(t);
      },
      { signal },
    );

    // Dragging the bar. Without this, a bar that is invisible at rest would be
    // strictly worse than the native one for mouse users: there'd be nothing
    // to grab.
    strip.addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        e.preventDefault();
        strip.setPointerCapture(e.pointerId);
        t.dragging = true;
        show(el, t);

        const startY = e.clientY;
        const startTop = el.scrollTop;
        const travel = t.travel;
        const drag = new AbortController();

        strip.addEventListener(
          "pointermove",
          (ev: PointerEvent) => {
            if (travel <= 0) return;
            const ratio = (ev.clientY - startY) / travel;
            el.scrollTop = startTop + ratio * (el.scrollHeight - el.clientHeight);
          },
          { signal: drag.signal },
        );
        const end = (ev: PointerEvent) => {
          strip.releasePointerCapture(ev.pointerId);
          t.dragging = false;
          drag.abort();
          // Restore the resting opacity, and start the fade if the pointer
          // wandered off the strip mid-drag.
          show(el, t);
          scheduleFade(t);
        };
        strip.addEventListener("pointerup", end, { signal: drag.signal });
        strip.addEventListener("pointercancel", end, { signal: drag.signal });
      },
      { signal },
    );

    thumbs.set(el, t);
    return t;
  };

  const onScroll = (e: Event) => {
    // The document scroller reports `document` as the target; retarget to the
    // element that actually has the scroll metrics.
    const target = e.target;
    const el =
      target instanceof HTMLElement ? target : document.documentElement;
    // Cheap field reads first: a horizontal-only scroller (the library's pill
    // row) fires scroll on every frame of a swipe and can never show a bar, so
    // it must not reach `create` — a strip and its compositor layer would be
    // built and then kept for nothing.
    if (el.scrollHeight <= el.clientHeight + SLACK) return;
    if (el.closest(`[${OPT_OUT}]`)) return;

    const t = thumbs.get(el) ?? create(el);
    // Don't measure here — the frame below does it, for this thumb and every
    // other one, exactly once. Measuring in the event handler as well would
    // force a second style/layout flush per scrolled frame.
    t.wake = true;
    scheduleFade(t);

    if (placeRaf) return;
    placeRaf = window.requestAnimationFrame(() => {
      placeRaf = 0;
      placeAll();
    });
  };

  // Reveal the bar when the pointer is simply resting over a scroll area, the
  // way a desktop overlay scrollbar does — otherwise there'd be no way to find
  // the bar to drag it without scrolling first. `pointerover` fires only when
  // the pointer crosses into a different element, so this is far cheaper than
  // tracking `pointermove`.
  const onPointerOver = (e: Event) => {
    if (!fineQuery.matches) return;
    const target = e.target;
    // Reaching the bar itself must not disarm it. The strip's ancestors are
    // the overlay host, which scrolls nothing, so resolving a scroller from it
    // would come back null and retire the very strip the pointer just landed
    // on — leaving it visible but not clickable, so a drag would miss it.
    if (target instanceof Element && target.closest(`#${HOST_ID}`)) return;
    const el = scrollerFor(target instanceof Element ? target : null);
    if (el === armed) return;
    // Retire the previous strip's hit-testing before arming the new one.
    if (armed) {
      const prev = thumbs.get(armed);
      if (prev) prev.strip.style.pointerEvents = "none";
    }
    armed = el;
    if (!el) return;
    const t = thumbs.get(el) ?? create(el);
    t.strip.style.pointerEvents = "auto";
    // Place it but leave it invisible: the pointer being *somewhere* in a
    // scroll area shouldn't paint a bar. Reaching the strip itself does.
    place(el, t);
  };

  const onMotionChange = () => {
    reduced = isReducedMotion();
    for (const t of thumbs.values()) setTransition(t, transitionFor(t));
  };

  const listeners = new AbortController();
  const { signal } = listeners;
  // Capture phase is required: `scroll` does not bubble, so a document-level
  // listener would never see a nested scroller during the bubble phase.
  document.addEventListener("scroll", onScroll, {
    capture: true,
    passive: true,
    signal,
  });
  document.addEventListener("pointerover", onPointerOver, {
    capture: true,
    passive: true,
    signal,
  });
  window.addEventListener("resize", placeAll, { passive: true, signal });
  const unsubscribeMotion = subscribeReducedMotion(onMotionChange);

  return () => {
    listeners.abort();
    unsubscribeMotion();
    if (placeRaf) window.cancelAnimationFrame(placeRaf);
    // Snapshot the keys — `destroy` mutates the map as it goes.
    for (const el of [...thumbs.keys()]) destroy(el);
    host.remove();
  };
}
