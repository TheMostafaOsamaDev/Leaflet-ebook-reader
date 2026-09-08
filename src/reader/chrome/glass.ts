// The reader's frosted chrome, in one place.
//
// All three readers — reflow (DesktopReader), phone reflow (MobileReader) and
// fixed-page (PDF / DOCX) — float their top and bottom bars OVER the page and
// blur what passes beneath. Keeping the recipe here rather than inline at the
// four call sites is what stops them drifting apart: the phone reader used to
// carry its own opaque `theme.chrome` fill while the other two took
// `theme.bg`, and the two formats read as different apps.
//
// The blur itself lives in `.riwaq-chrome-glass` in styles/global.css, because
// its fallback needs `@supports` and inline styles cannot express that.

import type { CSSProperties } from "react";
import type { Theme } from "../../styles/tokens";

/** Class carrying the `backdrop-filter` and its no-support fallback. */
export const GLASS_CLASS = "riwaq-chrome-glass";

/** Which screen edge the bar is pinned to. Decides which side gets the rule. */
export type GlassEdge = "top" | "bottom";

/** Inline styles may carry custom properties, which `CSSProperties` doesn't
 *  model. Narrower than casting the whole object to `any` at each call site. */
type GlassStyle = CSSProperties & { "--riwaq-chrome-opaque": string };

export interface GlassBar {
  className: string;
  style: GlassStyle;
}

/** The fill, hairline and blur for one floating reader bar.
 *
 *  Spread onto the bar element and add whatever positioning and padding that
 *  particular reader needs — this owns the material, not the layout. */
export function glassBar(theme: Theme, edge: GlassEdge): GlassBar {
  return {
    className: GLASS_CLASS,
    style: {
      background: theme.chromeGlass,
      // Read by the `@supports not (backdrop-filter)` rule in global.css.
      "--riwaq-chrome-opaque": theme.chrome,
      // A hairline on the side facing the page. Without it a frosted bar has
      // no boundary at all — the blur just fades into the paragraph under it
      // and the title looks like it is floating in the text. Only the inward
      // side gets one: a rule on the outward side would draw a line along the
      // screen edge (and, on Android, along the notch).
      //
      // The bottom bar takes `ruleStrong` because it sits above the gesture
      // bar on a phone, where `rule` at 0.5px is close to invisible.
      ...(edge === "top"
        ? { borderBottom: `0.5px solid ${theme.rule}` }
        : { borderTop: `0.5px solid ${theme.ruleStrong}` }),
    },
  };
}
