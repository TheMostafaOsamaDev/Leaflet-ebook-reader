/**
 * Where a selection toolbar goes, given the rect of the thing it belongs
 * to. Both reader popovers (SelectionPopover, HighlightActionPopover)
 * place themselves through here.
 *
 * All coordinates are VIEWPORT coordinates, which is what
 * `getBoundingClientRect()` hands back and what `position: fixed`
 * consumes. That choice is what makes a popover follow its selection
 * when the reading column scrolls underneath it: the caller re-measures
 * the anchor and calls this again (see hooks/useTrackedAnchor).
 *
 * `bounds` is the slice of the viewport the toolbar may occupy — the
 * reading region, inset clear of the frosted chrome bars. A selection
 * that has scrolled outside it gets `visible: false` rather than a
 * clamped position, because a toolbar parked over unrelated text reads
 * as a bug (and was one).
 */

export interface PlacementInput {
  /** Viewport rect of the selection (or of an existing highlight's
   *  `<mark>`). Only the fields placement actually needs. */
  anchor: { top: number; bottom: number; left: number; width: number };
  /** Measured size of the toolbar. */
  size: { width: number; height: number };
  /** The region the toolbar must stay inside. */
  bounds: { top: number; bottom: number; left: number; right: number };
  /** "auto": above the selection if it fits, else below.
   *  "below": always below — the phone reader forces this so we never
   *  cover Android's own floating toolbar, which sits above the text. */
  placement: "auto" | "below";
  /** Gap between the toolbar and both the selection and the bounds. */
  margin: number;
  /** The side the toolbar is ALREADY on, when it is already open.
   *
   *  Placement holds that side for the toolbar's whole life instead of
   *  re-deciding every scroll frame. Re-deciding is what makes a
   *  toolbar appear to jump: scroll a selection up-page and the moment
   *  room above runs out it would leap to the other side of the text.
   *  Held, it slides to the edge of the reading region and then fades
   *  with its selection — which is a thing the reader can follow. */
  lockedSide?: Side;
}

export type Side = "above" | "below";

export interface Placement {
  top: number;
  left: number;
  /** The side actually used. Feed it back as `lockedSide` on the next
   *  call to keep the toolbar there. */
  side: Side;
  /** False when the anchor has left the reading region entirely. The
   *  caller fades the toolbar out instead of drawing it somewhere it no
   *  longer means anything. */
  visible: boolean;
}

export function placePopover({
  anchor,
  size,
  bounds,
  placement,
  margin,
  lockedSide,
}: PlacementInput): Placement {
  const above = anchor.top - size.height - margin;
  const below = anchor.bottom + margin;

  const roomAbove = above >= bounds.top;
  const roomBelow = below + size.height <= bounds.bottom;

  // Above is the default because it leaves the text you just selected
  // uncovered as you read down to it. Below is the fallback, and the
  // forced choice on the phone (Android draws its own toolbar above the
  // selection). Once open, the side is whatever it already was.
  const side: Side =
    lockedSide ??
    (placement === "below"
      ? roomBelow || !roomAbove
        ? "below"
        : "above"
      : roomAbove
        ? "above"
        : "below");

  // Clamp, never flip. Everything the toolbar does after opening is a
  // slide within the reading region.
  const wanted = side === "above" ? above : below;
  const top = clamp(wanted, bounds.top, bounds.bottom - size.height);

  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const left = clamp(
    centred,
    bounds.left + margin,
    bounds.right - size.width - margin,
  );

  // Any overlap with the reading region counts as visible: half a line
  // showing is still a line the reader can see themselves highlighting,
  // and snatching the toolbar away at that point feels broken.
  const visible = anchor.bottom > bounds.top && anchor.top < bounds.bottom;

  // Whole pixels: a fixed element re-placed every scroll frame on a
  // fractional offset shimmers against the text behind it.
  return { top: Math.round(top), left: Math.round(left), side, visible };
}

/** Ordinary clamp, but tolerant of a range that has gone inverted —
 *  a viewport shorter than the toolbar itself, which happens on a phone
 *  in landscape with the keyboard up. The low bound wins there, so the
 *  toolbar stays reachable at the top rather than being pushed off. */
function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}
