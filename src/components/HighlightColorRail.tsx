import { useEffect, useRef, useState } from "react";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_COLOR_ORDER,
  inkAlpha,
  type HighlightColor,
  type Theme,
} from "../styles/tokens";
import { useI18n } from "../i18n/useI18n";
import type { MsgKey } from "../i18n";

/** Localized colour name, interpolated into the swatch labels. */
const COLOR_NAME_KEY: Record<HighlightColor, MsgKey> = {
  yellow: "color.yellow",
  orange: "color.orange",
  red: "color.red",
  pink: "color.pink",
  purple: "color.purple",
  blue: "color.blue",
  teal: "color.teal",
  green: "color.green",
};

/** Row height. Sized for a finger, not for the dot — the swatch inside
 *  is smaller than the thing you tap. */
const RAIL_HEIGHT = 44;
const SWATCH_HIT = 40;
const SWATCH_DOT = 26;
const FADE = 18;
/** Alpha for the hairline around every swatch. Measured: the palest
 *  swatch (yellow) sits at 1.88:1 against sepia paper with no edge, so
 *  a bare dot is a UI element you cannot see the shape of. Inking the
 *  rim at 0.38 puts the worst case at 3.43:1 in the worst theme, which
 *  clears the 3:1 asked of a non-text control — without touching the
 *  colour itself, which is the one thing a swatch cannot fake. */
const EDGE_ALPHA = 0.38;

interface Props {
  theme: Theme;
  /** The colour a pending choice is on, ringed to show it. Left out
   *  where a tap is an immediate action rather than a choice — then no
   *  swatch is "current" and ringing one would be a lie. */
  selected?: HighlightColor;
  onPick: (c: HighlightColor) => void;
}

/**
 * Every highlight colour, in one horizontally-scrolling row.
 *
 * Eight touch-sized swatches do not fit across a phone, and a swatch
 * too small to hit is worse than one you have to scroll to — so the
 * rail is deliberately narrower than its contents. The fades at the
 * ends are the only cue that there is more, so they appear only on a
 * side that actually has more, and they follow the writing direction
 * rather than the screen: in Arabic the rail starts at the right and
 * the colours you have not reached yet are off to the left.
 */
export function HighlightColorRail({ theme, selected, onPick }: Props) {
  const { tr, dir } = useI18n();
  const railRef = useRef<HTMLDivElement>(null);
  // Which PHYSICAL end needs a fade. Resolved from the logical ends
  // plus the UI direction, because `mask-image` gradients only speak
  // physical. Direction comes from i18n rather than a computed style
  // so the scroll handler stays free of style recalcs.
  const [fades, setFades] = useState({ left: false, right: false });

  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const sync = () => {
      // `scrollLeft` counts up leftward in RTL (negative in WebKit and
      // Chromium), so distance travelled is its magnitude either way.
      const max = el.scrollWidth - el.clientWidth;
      const travelled = Math.abs(el.scrollLeft);
      const atStart = travelled <= 2;
      const atEnd = travelled >= max - 2;
      const start = !atStart;
      const end = !atEnd;
      setFades((prev) => {
        const next =
          dir === "rtl"
            ? { left: end, right: start }
            : { left: start, right: end };
        return prev.left === next.left && prev.right === next.right ? prev : next;
      });
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [dir]);

  const mask = `linear-gradient(to right, ${[
    fades.left ? `transparent 0, #000 ${FADE}px` : "#000 0",
    fades.right ? `#000 calc(100% - ${FADE}px), transparent 100%` : "#000 100%",
  ].join(", ")})`;

  return (
    <div
      ref={railRef}
      role="group"
      aria-label={tr("selection.colorsAriaLabel")}
      style={{
        display: "flex",
        alignItems: "center",
        height: RAIL_HEIGHT,
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
        // Keeps a flicked rail from also turning the page.
        overscrollBehaviorX: "contain",
        touchAction: "pan-x",
        maskImage: mask,
        WebkitMaskImage: mask,
        padding: "0 4px",
      }}
    >
      {HIGHLIGHT_COLOR_ORDER.map((c) => {
        const isSelected = selected === c;
        return (
          <button
            key={c}
            onClick={() => onPick(c)}
            aria-label={tr(
              selected ? "selection.colorPickAriaLabel" : "selection.colorAriaLabel",
              { color: tr(COLOR_NAME_KEY[c]) },
            )}
            // Only a real choice gets pressed-state semantics.
            aria-pressed={selected ? isSelected : undefined}
            style={{
              flex: `0 0 ${SWATCH_HIT}px`,
              height: SWATCH_HIT,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
            }}
          >
            <span
              style={{
                width: SWATCH_DOT,
                height: SWATCH_DOT,
                borderRadius: SWATCH_DOT / 2,
                background: HIGHLIGHT_COLORS[c].dot,
                // A ring, not a size change: growing the swatch would
                // reflow the rail and shift every colour under the
                // finger already on its way to one.
                boxShadow: [
                  `inset 0 0 0 1.5px ${inkAlpha(theme, EDGE_ALPHA)}`,
                  isSelected
                    ? `0 0 0 2px ${theme.bg}, 0 0 0 3.5px ${theme.ink}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(", "),
                transition: "box-shadow 160ms ease-out",
              }}
            />
          </button>
        );
      })}
    </div>
  );
}
