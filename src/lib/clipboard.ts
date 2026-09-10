/**
 * Copying a passage out of the reader.
 *
 * Two things here rather than one call site's worth of inline code:
 * the async Clipboard API is not always there to be called, and a
 * multi-paragraph selection has to be reassembled before it can be
 * copied at all.
 */

import type { SelectionAnchor } from "./selectionAnchor";

/** The text of a selection, as the reader would expect to paste it.
 *
 *  A selection spanning paragraphs arrives as one segment per
 *  paragraph; they are rejoined with a blank line, because that is the
 *  break the reader can see on the page. Within a paragraph the text is
 *  already contiguous. */
export function selectionText(anchor: SelectionAnchor): string {
  return anchor.segments
    .map((s) => s.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/**
 * Put text on the clipboard, resolving to whether it landed.
 *
 * `navigator.clipboard` needs a secure context, which the Android
 * WebView does not always give a Tauri app depending on how the shell
 * serves the bundle. The `execCommand("copy")` path is deprecated on
 * paper and still the only thing that works there, so it stays as the
 * fallback rather than as a first choice.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused, or no secure context. Fall through.
  }
  return legacyCopy(text);
}

/** Off-screen textarea + execCommand. Positioned rather than hidden:
 *  `display: none` and `visibility: hidden` both make the selection
 *  uncopyable, so it has to be laid out somewhere real. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText =
    "position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none;";
  document.body.appendChild(ta);
  // Stash the reader's own selection: selecting the textarea replaces
  // it, and the highlight toolbar is anchored to it.
  const previous = document.getSelection();
  const saved =
    previous && previous.rangeCount > 0 ? previous.getRangeAt(0).cloneRange() : null;
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    if (saved) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(saved);
    }
  }
  return ok;
}

/**
 * Copy a selected passage.
 *
 * Deliberately fire-and-forget, and deliberately leaves the selection
 * and the toolbar alone: copying a passage is not a decision about it,
 * and the reader may well want to colour it straight afterwards. The
 * toolbar shows its own confirmation.
 */
export function copySelection(anchor: SelectionAnchor): void {
  void copyText(selectionText(anchor));
}
