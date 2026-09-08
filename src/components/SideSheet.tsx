// Reusable side sheet: a dimmed scrim + an edge-anchored panel that slides in
// *over* the reader content, dismissed by scrim click or Esc.
//
// Shared by the reflowable DesktopReader and the FixedPageReader so both
// readers get identical open/close motion, Esc-to-close and RTL-correct
// direction of travel.
//
// Two modes. Tool panels OVERLAY: they float over the reader on a scrim and
// you dismiss them. Contents DOCKS (`dock`), joining the flex row as a real
// sibling so the chapter list stays on screen while you read. Docking was
// removed once before because only the reflowable reader did it, so the same
// click behaved differently on a PDF; both readers now derive `dock` from
// reader/chrome/dockContents.ts, which is what keeps them in step.
//
// Animation: the panel mounts OFF-SCREEN with no transition, then flips to its
// resting position on the next frame via a CSS transition. Driving the slide
// with a transition (rather than a keyframe applied at mount time) is the
// engine-agnostic way to guarantee the enter plays: WebKit/WKWebView can skip a
// keyframe that is present on a node the instant it is inserted, which made the
// enter "snap" while the exit (a class change on an already-painted node) stayed
// smooth. Forcing a paint of the off-screen state before the flip fixes that.
//
// `side` is LOGICAL: "left" = the reader's leading edge, "right" = trailing.
// The panel is anchored with logical inset properties so it rests on the correct
// edge under RTL automatically; the *physical* off-screen translate is picked to
// match wherever it actually lands (see `physicalSide`) so it slides off its own
// edge rather than sweeping across the reader under RTL.
//
// The sheet fills its positioning parent (`position: absolute; inset: 0`), so
// mount it inside the reader's *content* region. Both readers now float their
// chrome bars over that region rather than stacking them above it, so an
// overlay panel takes `chromeInset` to stay clear of them — the bars sit at a
// higher z-index and would otherwise cover the panel's own header. The bars
// being above the scrim is deliberate: their toggle buttons stay clickable and
// undimmed while a panel is open.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/useI18n";
import { EASE, MOTION, useReducedMotion } from "../styles/motion";

interface Props {
  open: boolean;
  /** Fired by scrim click and by Escape. */
  onClose: () => void;
  /** Logical edge the panel rests on: "left" = leading, "right" = trailing. */
  side: "left" | "right";
  children: ReactNode;
  /** Optional fixed width. When omitted the panel is sized by its content
   *  (e.g. PanelShell's own 340px), which is what both readers rely on. */
  width?: number | string;
  /** Dim the reader behind the panel. Default true; ignored while docked. */
  dim?: boolean;
  /** Claim layout beside the reader instead of floating over it. */
  dock?: boolean;
  /** Accessible name for the dialog surface. */
  label?: string;
  /** Base stacking level; the panel sits one above the scrim. Default 40. */
  zIndex?: number;
  /** Room to leave at the top/bottom of an OVERLAY panel, for a reader whose
   *  chrome bars float over the content region rather than sitting above it.
   *  Without it the panel spans the full height and its own header — the close
   *  button included — ends up underneath the top bar, which is stacked above
   *  it. Ignored while docked: a docked panel is meant to run the full height,
   *  and the bars stop short of it instead (see focusChrome's `dockInset`). */
  chromeInset?: { top?: number | string; bottom?: number | string };
}

export function SideSheet({
  open,
  onClose,
  side,
  children,
  width,
  dim = true,
  dock = false,
  label,
  zIndex = 40,
  chromeInset,
}: Props) {
  const { dir } = useI18n();
  const reduced = useReducedMotion();
  // `mounted` = present in the DOM (stays true through the exit transition).
  // `shown`   = at the resting position (false = off-screen / faded out).
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open && reduced);

  // Freeze the children + side + dock mode seen while open so the exit plays
  // the panel the user was actually using, sliding off its own edge — even
  // though the parent has already cleared its active-panel state to null.
  //
  // `dock` has to be frozen as much as the other two: callers derive it from
  // that same active-panel state (`shouldDockContents(activePanel, …)`), so it
  // goes false on the very render that starts the exit. Read live, a closing
  // docked panel would fall into the overlay branch below — snapping the
  // reading column back to full width and flashing a scrim in over it on the
  // way out.
  const lastChildrenRef = useRef<ReactNode>(children);
  const lastSideRef = useRef(side);
  const lastDockRef = useRef(dock);
  if (open) {
    lastChildrenRef.current = children;
    lastSideRef.current = side;
    lastDockRef.current = dock;
  }

  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Keep the latest onClose without retriggering the focus/keydown effect on
  // every render (parents pass a fresh arrow each time).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Mount/unmount + drive the slide via `shown`.
  useEffect(() => {
    if (open) {
      setMounted(true);
      if (reduced) {
        setShown(true);
        return;
      }
      // Two frames: let the off-screen start paint, then flip to the resting
      // position so the browser runs a real transition instead of jumping.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    // Closing: slide out, then unmount after the exit finishes.
    setShown(false);
    // A docked panel closes instantly — no exit animation. It occupies real
    // layout, so any fade-out leaves an empty 340px strip holding its width
    // while the reading column waits to reflow, which reads as lag rather
    // than as motion. Dismissal should feel immediate: the panel goes and the
    // text takes the space back in the same frame.
    if (reduced || lastDockRef.current) {
      setMounted(false);
      return;
    }
    const t = setTimeout(() => setMounted(false), MOTION.fast);
    return () => clearTimeout(t);
  }, [open, reduced]);

  // While open: Esc closes, focus moves into the panel, and focus is restored
  // to the trigger on close. Lightweight — not a full focus trap (no Radix).
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;

  const activeSide = open ? side : lastSideRef.current;
  const activeDock = open ? dock : lastDockRef.current;
  // Anchor on the logical edge (inset properties flip under RTL on their own);
  // the off-screen translate is physical, so choose it by where the panel lands.
  const physicalSide =
    dir === "rtl" ? (activeSide === "left" ? "right" : "left") : activeSide;
  const anchor =
    activeSide === "left"
      ? { insetInlineStart: 0, insetInlineEnd: "auto" as const }
      : { insetInlineEnd: 0, insetInlineStart: "auto" as const };
  const offscreen =
    physicalSide === "left" ? "translateX(-100%)" : "translateX(100%)";

  // Timing follows the direction of travel: entering uses the longer spring-in,
  // exiting the snappier ease-out. The transition value on the *new* render is
  // what governs each change, so keying it off `shown` is correct.
  const dur = shown ? MOTION.med : MOTION.fast;
  const ease = shown ? EASE.enter : EASE.exit;
  const slideTransition = reduced ? undefined : `transform ${dur}ms ${ease}`;
  const fadeTransition = reduced ? undefined : `opacity ${dur}ms ${ease}`;

  if (activeDock) {
    // The strip claims its width the instant it mounts and releases it once
    // the exit finishes, so the reading column reflows exactly twice per
    // open/close. Animating the width instead would re-trigger
    // PaginatedView's ResizeObserver on every frame of the slide and
    // re-paginate the book underneath the reader. What actually animates is
    // the panel's own content, settling in from the edge it rests on —
    // transform and opacity only, so nothing about the motion touches layout.
    const nudge =
      physicalSide === "left" ? "translateX(-10px)" : "translateX(10px)";
    return (
      <div
        ref={panelRef}
        // Not a dialog: a docked panel is a persistent region beside the
        // reader, not something modal laid over it. `aria-modal` here would
        // tell a screen reader the book had become inert while Contents was
        // open, which is the opposite of the point.
        role="complementary"
        aria-label={label}
        tabIndex={-1}
        style={{
          display: "flex",
          flexShrink: 0,
          minHeight: 0,
          ...(width != null ? { width } : null),
          maxWidth: "60%",
          outline: "none",
          opacity: shown ? 1 : 0,
          transform: shown ? "none" : nudge,
          transition: reduced
            ? undefined
            : `opacity ${dur}ms ${ease}, transform ${dur}ms ${ease}`,
        }}
      >
        {open ? children : lastChildrenRef.current}
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex,
        // Don't swallow clicks meant for the reader while off-screen / exiting.
        pointerEvents: shown ? "auto" : "none",
      }}
    >
      {dim && (
        <div
          onClick={onClose}
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.42)",
            opacity: shown ? 1 : 0,
            transition: fadeTransition,
            cursor: "pointer",
          }}
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={{
          position: "absolute",
          top: chromeInset?.top ?? 0,
          bottom: chromeInset?.bottom ?? 0,
          ...anchor,
          ...(width != null ? { width } : null),
          maxWidth: "100%",
          display: "flex",
          outline: "none",
          zIndex: 1,
          transform: shown ? "translateX(0)" : offscreen,
          transition: slideTransition,
          // Hint the compositor so the slide stays smooth under reader load.
          willChange: "transform",
        }}
      >
        {open ? children : lastChildrenRef.current}
      </div>
    </div>
  );
}
