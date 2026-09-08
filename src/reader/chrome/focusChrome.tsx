// Focus mode, shared by the reflow reader (DesktopReader) and the fixed-page
// reader (PDF / DOCX). The chrome leaves the layout entirely so the page fills
// the window, and comes back when the pointer nears the edge it lives on.
//
// It lives here rather than in one reader because "focus mode" is a property of
// the reader SHELL — the top bar and the bottom scrubber — and both readers
// already share that shell (ReaderTopBar / ReaderProgressBar). Having it in one
// reader only is what made the two formats feel like different apps.
//
// Desktop only: the reveal is driven by pointer proximity, which a phone has no
// equivalent for. Callers gate on their own layout flag.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { EASE, MOTION } from "../../styles/motion";
import { FONT_STACKS, type Theme } from "../../styles/tokens";
import { chromeEdges } from "./focusEdges";
import { glassBar, type GlassBar, type GlassEdge } from "./glass";
import { migrateStorageKey } from "../../lib/legacyStorage";

/** How long a revealed bar lingers after the pointer leaves its edge, in ms. */
const CHROME_LINGER_MS = 450;

// Room a pinned reader bar occupies, for the reading surface to pad itself
// clear of. Constants rather than a measured height, following what the phone
// reader already does with its flat 44px: the chrome font is fixed (see the
// note on FONT_STACKS.sans) so these do not move, and measuring would mean the
// padding jumps from 0 to its real value one frame after mount — which lands
// right on top of the restored scroll position.
//
// Being a few pixels out costs nothing here: the numbers set how much
// whitespace sits between a bar and the first line, so an inexact one reads as
// 58px of breathing room instead of 60px. The failure mode if a bar ever grows
// taller than its constant is a line tucked under a TRANSLUCENT bar — blurred
// but still legible — not a line that vanishes.
//
/** Height of the top bar (ReaderTopBar: 14px padding + a 37px title block). */
export const CHROME_INSET_TOP = 66;
/** Height of the bottom bar (ReaderProgressBar: 6px + a 44px track + 14px). */
export const CHROME_INSET_BOTTOM = 65;
/** How long the first-run hint stays up. Matches `.riwaq-focus-hint`. */
export const FOCUS_HINT_MS = 3200;
/** Set once the first-run focus-mode hint has been shown. */
const FOCUS_HINT_KEY = "riwaq:focus-hint-seen";

function focusHintSeen(): boolean {
  // Private-mode / blocked-storage browsers throw on access; treating that as
  // "already seen" is the quiet failure — better a missing hint than a crash.
  try {
    migrateStorageKey(FOCUS_HINT_KEY);
    return localStorage.getItem(FOCUS_HINT_KEY) === "1";
  } catch {
    return true;
  }
}

function markFocusHintSeen(): void {
  try {
    localStorage.setItem(FOCUS_HINT_KEY, "1");
  } catch {
    // Nothing to do — the hint simply shows again next time.
  }
}

export interface FocusChromeOptions {
  /** The persisted `focusMode` tweak. */
  active: boolean;
  setActive: (next: boolean) => void;
  /** True while any panel is open — Escape belongs to the panel then. */
  panelOpen: boolean;
  /** Close whatever panel is open. Called when entering focus mode. */
  closePanels: () => void;
  theme: Theme;
  reducedMotion: boolean;
  /** Wire the pointer tracking at all. False on phones. */
  enabled?: boolean;
  /** Width of a docked panel on the leading edge, or 0 when none is docked.
   *  The floating bars stop short of it instead of lying across it — see the
   *  note on `clip`. */
  dockInset?: number;
}

export interface FocusChrome {
  /** True while the chrome is lifted out of the layout. */
  floating: boolean;
  showTop: boolean;
  showBottom: boolean;
  /** Bumped once per hint; 0 = nothing to show. Use as a React `key`. */
  hint: number;
  toggle: () => void;
  /** Spread onto the reader root so pointer proximity can summon the bars. */
  rootHandlers: {
    onMouseMove: (e: ReactMouseEvent) => void;
    onMouseLeave: () => void;
  };
  /** Pins a bar to one edge, floating over the page, for when focus mode is
   *  OFF. Same overlay position as `clip` but with no slide to contain, so it
   *  omits the `overflow: hidden` — see the note on the implementation. */
  pin: (edge: GlassEdge) => CSSProperties;
  /** Outer clip window for one edge — see the note on the implementation. */
  clip: (edge: "top" | "bottom", shown: boolean) => CSSProperties;
  /** Inner sliding layer for one edge. */
  slide: (edge: "top" | "bottom", shown: boolean) => CSSProperties;
  /** The frosted fill for a bar on one edge. Handed out from here so a reader
   *  gets the bar's material and its float behaviour from the same place, and
   *  so the two stay in step whether focus mode is on or off. */
  glass: (edge: GlassEdge) => GlassBar;
}

export function useFocusChrome({
  active,
  setActive,
  panelOpen,
  closePanels,
  theme,
  reducedMotion,
  enabled = true,
  dockInset = 0,
}: FocusChromeOptions): FocusChrome {
  // The chrome stays out of the layout while a panel is open, too. Letting it
  // back in meant that opening a sheet grew the flow by both bar heights and
  // reflowed the page underneath — the text jumped and re-wrapped when all the
  // reader asked for was the one sheet they clicked. Opening a sheet now
  // changes nothing but the sheet.
  const floating = enabled && active;
  const [revealTop, setRevealTop] = useState(false);
  const [revealBottom, setRevealBottom] = useState(false);
  // Bumped once, ever, to play the first-run hint. Counter rather than a
  // boolean so the toast remounts (and its keyframe restarts) if it ever fires
  // more than once in a session.
  const [hint, setHint] = useState(0);
  const showTop = !floating || revealTop;
  const showBottom = !floating || revealBottom;

  // Which edge zone the pointer is currently inside. Kept in a ref so the move
  // handler only touches state when the pointer *crosses* a boundary —
  // re-arming the hide timer on every mousemove would keep a revealed bar up
  // forever as long as the pointer kept moving anywhere in the window.
  const inEdge = useRef({ top: false, bottom: false });
  const hideTimers = useRef({ top: 0, bottom: 0 });
  const hintTimer = useRef(0);
  const setEdgeShown = (edge: "top" | "bottom", shown: boolean) =>
    (edge === "top" ? setRevealTop : setRevealBottom)(shown);
  const revealEdge = useCallback((edge: "top" | "bottom") => {
    window.clearTimeout(hideTimers.current[edge]);
    setEdgeShown(edge, true);
  }, []);
  const hideEdgeSoon = useCallback((edge: "top" | "bottom") => {
    window.clearTimeout(hideTimers.current[edge]);
    // A grace period so brushing past the edge on the way somewhere else
    // doesn't snatch the bar away mid-reach.
    hideTimers.current[edge] = window.setTimeout(
      () => setEdgeShown(edge, false),
      CHROME_LINGER_MS,
    );
  }, []);
  useEffect(
    () => () => {
      window.clearTimeout(hideTimers.current.top);
      window.clearTimeout(hideTimers.current.bottom);
      window.clearTimeout(hintTimer.current);
    },
    [],
  );
  // Entering or leaving focus mode invalidates where the pointer was last known
  // to be relative to the edges, so forget it and retire both bars after the
  // usual grace. Any pointer movement re-reveals through the normal path.
  useEffect(() => {
    inEdge.current = { top: false, bottom: false };
    if (!floating) return;
    hideEdgeSoon("top");
    hideEdgeSoon("bottom");
  }, [floating, hideEdgeSoon]);

  // Pointer proximity is measured on the reader root rather than with two hover
  // strips: an element covering the top and bottom bands would swallow clicks
  // and drag-selection over the text underneath it.
  const trackPointer = (
    clientY: number,
    height: number,
    overDockedPanel: boolean,
  ) => {
    if (!floating) return;
    const near = chromeEdges(clientY, height, overDockedPanel);
    for (const edge of ["top", "bottom"] as const) {
      if (near[edge] === inEdge.current[edge]) continue;
      inEdge.current[edge] = near[edge];
      if (near[edge]) revealEdge(edge);
      else hideEdgeSoon(edge);
    }
  };

  const toggle = () => {
    const next = !active;
    setActive(next);
    if (!next) return;
    // Entering: this is "just the book", so any open panel goes with the
    // chrome, and the bars start hidden rather than mid-reveal.
    closePanels();
    inEdge.current = { top: false, bottom: false };
    setRevealTop(false);
    setRevealBottom(false);
    if (!focusHintSeen()) {
      markFocusHintSeen();
      setHint((n) => n + 1);
      // Unmount once the keyframe has finished — `forwards` would otherwise
      // leave an invisible pill in the tree (and in the a11y tree) for good.
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHint(0), FOCUS_HINT_MS);
    }
  };

  // Escape leaves focus mode — the keyboard route back to the chrome, since a
  // hidden bar is `visibility: hidden` and so out of the tab order. While a
  // panel is open SideSheet owns Escape (it closes the panel), so stay out.
  useEffect(() => {
    if (!floating || panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [floating, panelOpen, setActive]);

  // Transform only — see the note on `slide` for why the opacity fade went.
  const chromeTransition = reducedMotion
    ? "none"
    : `transform ${MOTION.med}ms ${EASE.enter}`;

  // Chrome that floats over the page. Both readers keep their bars over the
  // page whether or not focus mode is on — that is what makes them read like
  // the phone reader's, with the paragraph blurring through them as it scrolls
  // past. `pin` is the plain case; focus mode adds the two layers below.
  //
  // The OUTER layer is a fixed window at the edge, `overflow: hidden`, sized by
  // the bar inside it. It exists because a transformed box still counts toward
  // its container's scrollable overflow: sliding a bar to `translateY(±100%)`
  // directly in the reader root grew that root's scrollHeight past its
  // clientHeight, quietly making the whole reader scrollable. `overflow:
  // hidden` there only suppresses the scrollbar — the element stays
  // programmatically scrollable, and the Contents panel's `scrollIntoView`
  // (which walks up every scrollable ancestor) then dragged the entire page out
  // of position. Clipping the slide inside this window keeps the translate from
  // ever reaching the root's overflow region.
  //
  // `visibility` on the outer flips only after the fade finishes: it keeps the
  // exit smooth and takes a hidden bar's buttons out of the tab order instead
  // of leaving invisible focus stops behind.
  //
  // A floating bar stops short of a docked panel rather than lying across it.
  // Spanning the full width put the bar on top of the panel's own header, so
  // once it was out the close button sat underneath it — and because the bar
  // occupies the same band that summons it, hovering the covered button held
  // the bar there. The control was unreachable until you moved away and
  // waited. `insetInlineStart` is logical, so this lands on whichever edge the
  // strip is on and needs no separate RTL case.
  //
  // Where a floating bar sits, shared by both modes.
  const overlay = (edge: GlassEdge): CSSProperties => ({
    position: "absolute",
    [edge]: 0,
    insetInlineStart: dockInset,
    insetInlineEnd: 0,
    // Above SideSheet's overlay (40) so a revealed bar is never dimmed by, or
    // buried under, a panel's scrim; below the toasts at 50.
    zIndex: 45,
    // Chrome is never part of a text selection dragged across the page.
    userSelect: "none",
    WebkitUserSelect: "none",
  });

  // Focus mode OFF: the bar is simply pinned over the page. Deliberately NOT
  // `clip(edge, true)`, which would look equivalent — `clip` brings its
  // `overflow: hidden` along, and the progress bar's scrub chip is anchored
  // `calc(100% + 12px)` above its 3px track, i.e. outside the bar's own box.
  // Clipping here would lop the value off the chip mid-drag.
  const pin = (edge: GlassEdge): CSSProperties => overlay(edge);

  const clip = (edge: "top" | "bottom", shown: boolean): CSSProperties => ({
    ...overlay(edge),
    overflow: "hidden",
    visibility: shown ? "visible" : "hidden",
    pointerEvents: shown ? "auto" : "none",
    transition: reducedMotion
      ? "none"
      : `visibility 0s linear ${shown ? "0s" : `${MOTION.med}ms`}`,
  });

  // The INNER layer is what actually moves.
  //
  // Transform only — no opacity, and no background of its own. Both were here
  // before the chrome went frosted and both now break it:
  //
  // - An ancestor with `opacity` < 1 becomes a "backdrop root", and
  //   `backdrop-filter` inside one has nothing left to sample. Fading this
  //   layer meant the bar's blur cut out for the length of the animation and
  //   then popped back in the frame opacity reached exactly 1. The fade was
  //   only ever a nicety: the clip window above is `overflow: hidden`, so the
  //   translate alone takes the bar out of sight.
  // - An opaque `background` here would sit behind the bar's own translucent
  //   fill and composite the two to ~0.95 alpha, i.e. no frost at all.
  //
  // The bar inside paints its own glass — see reader/chrome/glass.ts.
  const slide = (edge: "top" | "bottom", shown: boolean): CSSProperties => ({
    transform: shown
      ? "translateY(0)"
      : `translateY(${edge === "top" ? "-100%" : "100%"})`,
    transition: chromeTransition,
  });

  return {
    floating,
    showTop,
    showBottom,
    hint,
    toggle,
    rootHandlers: {
      onMouseMove: (e: ReactMouseEvent) => {
        if (!floating) return;
        // Measure against the reader's OWN box, not the viewport: clientY and
        // the root's height are only the same coordinate space when the reader
        // starts at y=0, which is true of the app but not of anything that
        // embeds it. One rect read per move, on an element whose layout is
        // already clean.
        const box = e.currentTarget.getBoundingClientRect();
        // Asked of the DOM rather than worked out from the strip's width and
        // side: only a DOCKED panel is `role="complementary"` (an overlay one
        // is a modal dialog), so this needs no geometry, and it stays right
        // under RTL — where the strip is on the other edge — and at whatever
        // width the panel happens to be.
        const overDockedPanel = !!(e.target as Element | null)?.closest?.(
          '[role="complementary"]',
        );
        trackPointer(e.clientY - box.top, box.height, overDockedPanel);
      },
      onMouseLeave: () => {
        if (!floating) return;
        for (const edge of ["top", "bottom"] as const) {
          if (!inEdge.current[edge]) continue;
          inEdge.current[edge] = false;
          hideEdgeSoon(edge);
        }
      },
    },
    pin,
    clip,
    slide,
    glass: (edge) => glassBar(theme, edge),
  };
}

/** First-run pill explaining how to get the chrome back. */
export function FocusHint({
  theme,
  title,
  body,
  isAr,
}: {
  theme: Theme;
  title: string;
  body: string;
  isAr: boolean;
}) {
  return (
    <div
      className="riwaq-focus-hint"
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
        zIndex: 50,
        padding: "16px 28px",
        borderRadius: 14,
        background: theme.chrome,
        color: theme.ink,
        border: `0.5px solid ${theme.rule}`,
        boxShadow: "0 16px 44px rgba(0,0,0,0.22)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        fontFamily: FONT_STACKS.sans,
        textAlign: "center",
        minWidth: 240,
        maxWidth: 340,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: isAr ? "normal" : "0.14em",
          textTransform: isAr ? "none" : "uppercase",
          color: theme.muted,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: theme.ink }}>
        {body}
      </div>
    </div>
  );
}
