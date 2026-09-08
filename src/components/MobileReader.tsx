import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CSSProperties } from "react";
import { Icon } from "./Icon";
import { BookBody, readingGutter } from "./BookBody";
import { ChapterProgressBar } from "./ChapterProgressBar";
import {
  chapterScrollFraction,
  paragraphScrollOffset,
  restoreScrollTop,
  fractionToWidth,
} from "./readerProgress";
import { MobileSheet } from "./MobileSheet";
import { MAX_TICKS, ReaderProgressBar } from "../reader/chrome/ReaderProgressBar";
import { ReaderTabBar } from "../reader/chrome/ReaderTabBar";
import { glassBar } from "../reader/chrome/glass";
import { SelectionPopover } from "./SelectionPopover";
import { SelectionOverlay } from "./SelectionOverlay";
import { SelectionHandle } from "./SelectionHandle";
import { HighlightActionPopover } from "./HighlightActionPopover";
import type { EpubBook } from "../epub/types";
import type { BookState, Highlight } from "../store/library";
import { EASE, MOTION, useReducedMotion } from "../styles/motion";
import {
  FONT_STACKS,
  isRtlLanguage,
  type HighlightColor,
  type Theme,
  type ThemeKey,
  readingSurfaces,
} from "../styles/tokens";
import {
  anchorFromRange,
  type SelectionAnchor,
} from "../lib/selectionAnchor";
import { useI18n } from "../i18n/useI18n";
import { formatNum } from "../i18n";
import { HighlightsPanel } from "../panels/HighlightsPanel";
import { ProgressOverlay } from "../panels/ProgressOverlay";
import { SettingsPanel } from "../panels/SettingsPanel";
import { TOCPanel } from "../panels/TOCPanel";
import type { ActivePanel, TocVolume, Tweaks } from "../types/reader";

// ---- Custom selection helpers --------------------------------------
// We replace native text selection on mobile with a hand-rolled
// pointer gesture. The user long-presses a word, drags to extend
// within the same paragraph, and releases. The selection lives only
// in React state — never on window.getSelection() — so the OS
// selection toolbar has no anchor and never appears.

const LONG_PRESS_MS = 400;
const LONG_PRESS_MOVE_TOLERANCE = 8; // px before pointer cancels long-press
const WORD_BOUNDARY_REGEX = /[\s\p{P}\p{S}]/u; // whitespace, punctuation, symbols

interface RangeEndpoint {
  node: Text;
  offset: number;
}

/** Find the text-node + offset at a viewport (clientX, clientY) point. */
function caretFromPoint(x: number, y: number): RangeEndpoint | null {
  // Prefer the standard caretPositionFromPoint when available, falling
  // back to caretRangeFromPoint (Chromium, Android WebView).
  const fromPos =
    (document as unknown as {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
    }).caretPositionFromPoint?.(x, y) ?? null;
  if (fromPos && fromPos.offsetNode.nodeType === Node.TEXT_NODE) {
    return { node: fromPos.offsetNode as Text, offset: fromPos.offset };
  }
  const fromRange = document.caretRangeFromPoint?.(x, y) ?? null;
  if (
    fromRange &&
    fromRange.startContainer.nodeType === Node.TEXT_NODE
  ) {
    return {
      node: fromRange.startContainer as Text,
      offset: fromRange.startOffset,
    };
  }
  return null;
}

/** Find the paragraph element (<p data-p-index>) ancestor of a node. */
function paragraphOf(node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n) {
    if (n instanceof HTMLElement && n.dataset.pIndex !== undefined) return n;
    n = n.parentNode;
  }
  return null;
}

/** Walk left/right within a text node to expand to the surrounding
 *  word's start and end character offsets. */
function wordRangeAt(node: Text, offset: number): [number, number] {
  const text = node.data;
  let start = offset;
  let end = offset;
  while (start > 0 && !WORD_BOUNDARY_REGEX.test(text[start - 1]!)) start--;
  while (end < text.length && !WORD_BOUNDARY_REGEX.test(text[end]!)) end++;
  if (start === end) return [offset, Math.min(offset + 1, text.length)];
  return [start, end];
}

/** Accept any endpoint that lies inside any paragraph of the book
 *  body — returns null if the candidate has no `<p data-p-index>`
 *  ancestor (e.g. chrome). Multi-paragraph selection is allowed,
 *  so we no longer clamp to the original long-press paragraph. */
function clampToBookBody(
  candidate: RangeEndpoint,
): RangeEndpoint | null {
  return paragraphOf(candidate.node) ? candidate : null;
}

/** True if endpoint `a` lies strictly before endpoint `b` in document
 *  order. Same node → compare offsets; across nodes → use the DOM's
 *  compareDocumentPosition. */
function comesBefore(a: RangeEndpoint, b: RangeEndpoint): boolean {
  if (a.node === b.node) return a.offset < b.offset;
  return !!(
    a.node.compareDocumentPosition(b.node) &
    Node.DOCUMENT_POSITION_FOLLOWING
  );
}

/** Build a Range from two endpoints, ordered correctly (start before end). */
function buildRange(a: RangeEndpoint, b: RangeEndpoint): Range {
  const range = document.createRange();
  const cmp =
    a.node === b.node
      ? a.offset - b.offset
      : a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
  if (cmp < 0) {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } else {
    range.setStart(b.node, b.offset);
    range.setEnd(a.node, a.offset);
  }
  return range;
}
function computeHandleRects(range: Range): { start: DOMRect; end: DOMRect } {
  const start = document.createRange();
  start.setStart(range.startContainer, range.startOffset);
  start.setEnd(range.startContainer, range.startOffset);
  const end = document.createRange();
  end.setStart(range.endContainer, range.endOffset);
  end.setEnd(range.endContainer, range.endOffset);
  // Collapsed ranges yield 0-width rects with valid top/left/height.
  const sr = start.getBoundingClientRect();
  const er = end.getBoundingClientRect();
  // Copy so subsequent range mutations don't invalidate the saved values.
  return {
    start: new DOMRect(sr.x, sr.y, sr.width, sr.height),
    end: new DOMRect(er.x, er.y, er.width, er.height),
  };
}

function orderedEndpoints(range: Range): {
  start: RangeEndpoint;
  end: RangeEndpoint;
} {
  // Range exposes startContainer/startOffset/endContainer/endOffset
  // already in document order — no swapping needed.
  return {
    start: {
      node: range.startContainer as Text,
      offset: range.startOffset,
    },
    end: {
      node: range.endContainer as Text,
      offset: range.endOffset,
    },
  };
}
// ---- end custom selection helpers ----------------------------------

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  book: EpubBook;
  state: BookState;
  currentChapter: number;
  resumeParagraph: number;
  /** 0..1 sub-paragraph scroll offset to resume at. Optional; defaults to 0
      (paragraph top) for callers that don't track it yet. */
  resumeOffset?: number;
  /** Bumped by App when a targeted scroll (e.g., highlight jump) should
   *  re-fire the chapter-mount scroll effect even if `currentChapter`
   *  didn't change. */
  jumpNonce: number;
  onChapterChange: (order: number) => void;
  onParagraphChange: (idx: number, offset?: number) => void;
  onCreateHighlight: (input: {
    chapter: number;
    paragraphIndex: number;
    charStart: number;
    charEnd: number;
    text: string;
    color: HighlightColor;
    note?: string;
    groupId?: string;
  }) => void;
  onDeleteHighlight: (id: string) => void;
  onUpdateHighlightNote: (id: string, note: string) => void;
  onJumpToHighlight: (h: Highlight) => void;
  /** Volume ranges for the Contents sheet, when the book's origin knows them
   *  (source novels). Omit for local EPUBs — Contents stays ungrouped. */
  tocVolumes?: TocVolume[];
  /** Navigate to the top-level Settings page (from the quick-panel link). */
  onOpenFullSettings?: () => void;
  onBack: () => void;
}

function mobileTab(theme: Theme): CSSProperties {
  return {
    width: 44,
    height: 44,
    borderRadius: 10,
    border: "none",
    background: "transparent",
    color: theme.chromeInk,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

export function MobileReader({
  theme,
  themeKey,
  t,
  setTweak,
  book,
  state,
  currentChapter,
  resumeParagraph,
  resumeOffset = 0,
  jumpNonce,
  onChapterChange,
  onParagraphChange,
  onCreateHighlight,
  onDeleteHighlight,
  onUpdateHighlightNote,
  onJumpToHighlight,
  tocVolumes,
  onOpenFullSettings,
  onBack,
}: Props) {
  const { tr, dir, locale } = useI18n();
  const [showChrome, setShowChrome] = useState(true);
  const [showProgress, setShowProgress] = useState(true);
  const reduced = useReducedMotion();
  // Top/bottom chrome bars stay mounted and animate via transform +
  // opacity when `showChrome` toggles, so a tap-to-read fade is
  // smooth instead of a hard cut. Pointer-events are dropped while
  // hidden so taps fall through to the reader.
  const chromeHidden = !showChrome;
  const chromeTransition = reduced
    ? "none"
    : `transform ${MOTION.med}ms ${EASE.enter}, opacity ${MOTION.med}ms ${EASE.enter}`;
  const glassTop = glassBar(theme, "top");
  const glassBottom = glassBar(theme, "bottom");

  // Android full screen. The app draws edge-to-edge, so hiding the reader's
  // own bars used to leave the SYSTEM bars painted over the page — the clock
  // and battery icons sat on the first line, with the text running under them.
  // The system bars now go with the chrome. They come back on an edge swipe
  // (transient) or the moment the chrome is tapped back in.
  //
  // Rejects and no-ops everywhere but Android, so no platform check is needed.
  useEffect(() => {
    void invoke("set_immersive_mode", { immersive: !showChrome }).catch(
      () => {},
    );
  }, [showChrome]);
  // Leaving the reader always restores them, whatever state the chrome was in.
  // Kept apart from the effect above deliberately: as that one's cleanup it
  // would fire on every toggle, showing the bars again a frame after each
  // request to hide them. Mount-only, so it runs on unmount and nowhere else.
  useEffect(
    () => () => {
      void invoke("set_immersive_mode", { immersive: false }).catch(() => {});
    },
    [],
  );
  const [sheet, setSheet] = useState<ActivePanel>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const startEndpointRef = useRef<RangeEndpoint | null>(null);
  const endEndpointRef = useRef<RangeEndpoint | null>(null);
  const paragraphRef = useRef<HTMLElement | null>(null);
  const resumeRef = useRef(resumeParagraph);
  resumeRef.current = resumeParagraph;
  const resumeOffsetRef = useRef(resumeOffset);
  resumeOffsetRef.current = resumeOffset;
  const progressFillRef = useRef<HTMLDivElement>(null);
  // Content direction — derived from the BOOK's own language, independent of
  // the UI locale above. BookBody sets its own `dir` from this on its own
  // element, so it never inherits from the chrome wrapper below.
  const rtl = isRtlLanguage(book.language);

  // Reading colours come from the theme, full stop. The page sits on the
  // theme's paper with the surround a shade behind it, so the sheet reads as a
  // sheet without needing a border.
  const surfaces = readingSurfaces(theme);
  const contentTheme: Theme = theme;

  // Read by the scroll-to-resume effect so it knows whether the chrome is
  // currently occluding the top of the scroll area. Tracked via a ref so a
  // chrome toggle alone doesn't re-trigger the scroll.
  const showChromeRef = useRef(showChrome);
  showChromeRef.current = showChrome;
  const onParagraphChangeRef = useRef(onParagraphChange);
  onParagraphChangeRef.current = onParagraphChange;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Streamed (source) chapters load their body async, so the paragraphs
    // aren't in the DOM on this effect's first run. Bail until they exist —
    // the chapter content-id dep re-runs this effect once they mount, so
    // resume lands on the saved paragraph instead of falling through to
    // scrollTop = 0 (which dropped the reader at the chapter start).
    if (el.querySelectorAll("[data-p-index]").length === 0) return;
    // Resuming at paragraph 0 means "start of chapter" — snap to the very
    // top so the chapter heading BookBody renders above paragraph 0 stays
    // visible. Using offsetTop of p0 would scroll the heading off-screen.
    if (resumeRef.current === 0 && resumeOffsetRef.current <= 0.001) {
      el.scrollTop = 0;
      return;
    }
    const target = el.querySelector<HTMLElement>(
      `[data-p-index="${resumeRef.current}"]`,
    );
    if (!target) {
      el.scrollTop = 0;
      return;
    }
    // The top chrome is position:absolute, so it overlays the scroll area
    // rather than displacing it. When visible, it covers a chunk of the
    // very top — landing scrollTop exactly at target.offsetTop would hide
    // the target's first line behind it. Offset by the chrome's intrinsic
    // height (plus a small visual gap) when it's actually shown.
    const chromeOffset =
      showChromeRef.current && chromeRef.current
        ? chromeRef.current.offsetHeight + 8
        : 0;
    el.scrollTop = Math.max(
      0,
      restoreScrollTop(
        target.offsetTop,
        target.offsetHeight,
        resumeOffsetRef.current,
      ) - chromeOffset,
    );
    // book.chapters[currentChapter]?.id changes when a streamed chapter's
    // content is spliced in (its `#0` → `#<n>` id bump), re-running this so
    // resume fires once the paragraphs are actually in the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, book.id, jumpNonce, book.chapters[currentChapter]?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let queued = false;
    const handler = () => {
      if (queued) return;
      queued = true;
      window.setTimeout(() => {
        queued = false;
        const ps = el.querySelectorAll<HTMLElement>("[data-p-index]");
        if (ps.length === 0) return;
        const containerTop = el.getBoundingClientRect().top;
        let best = 0;
        let bestEl: HTMLElement | null = null;
        for (const p of ps) {
          const offset = p.getBoundingClientRect().top - containerTop;
          if (offset > 8) break;
          best = Number(p.dataset.pIndex);
          bestEl = p;
        }
        const intoPara = bestEl
          ? paragraphScrollOffset(el.scrollTop, bestEl.offsetTop, bestEl.offsetHeight)
          : 0;
        onParagraphChangeRef.current(best, intoPara);
      }, 250);
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);

  // Live within-chapter progress for the header bar. Separate from the 250ms
  // paragraph listener (too coarse for a smooth bar) and written imperatively
  // so scrolling never re-renders React.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      if (!progressFillRef.current) return;
      progressFillRef.current.style.width = fractionToWidth(
        chapterScrollFraction(el.scrollTop, el.scrollHeight, el.clientHeight),
      );
    };
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(paint);
    };
    paint();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, book.id]);

  const chapter = book.chapters[currentChapter] ?? book.chapters[0];
  const chapterCount = book.chapters.length;

  // Chapter landmarks and the bar's own position. The fraction is
  // `chapter / (count - 1)` — chapter 0 at the start, the last chapter at the
  // end — so it round-trips through a seek and a landmark sits exactly where
  // its chapter begins. The drag itself now lives in ReaderProgressBar, which
  // previews under the finger and commits on release; this reader used to
  // carry its own copy of that logic, and the desktop one carried a different
  // copy that committed on every move.
  const chapterAt = (f: number) =>
    Math.min(chapterCount - 1, Math.max(0, Math.round(f * Math.max(0, chapterCount - 1))));
  const barFraction = chapterCount > 1 ? currentChapter / (chapterCount - 1) : 0;
  const ticks =
    chapterCount > 2 && chapterCount - 2 <= MAX_TICKS
      ? Array.from({ length: chapterCount - 2 }, (_, i) => (i + 1) / (chapterCount - 1))
      : [];

  const prevChapter = () => {
    if (currentChapter > 0) onChapterChange(currentChapter - 1);
  };
  const nextChapter = () => {
    if (currentChapter < chapterCount - 1) onChapterChange(currentChapter + 1);
  };

  // Two mutually-exclusive popovers:
  //   - selAnchor: shown when the user just finished a selection
  //   - activeHl: shown when the user tapped an existing highlight
  // Showing one always clears the other.
  const [selAnchor, setSelAnchor] = useState<SelectionAnchor | null>(null);
  const [selRects, setSelRects] = useState<DOMRect[]>([]);
  const [handleRects, setHandleRects] = useState<{
    start: DOMRect;
    end: DOMRect;
  } | null>(null);
  const [activeHl, setActiveHl] = useState<{
    highlight: Highlight;
    rect: DOMRect;
  } | null>(null);
  const draggingHandleRef = useRef<"start" | "end" | null>(null);
  const draggingPointerIdRef = useRef<number | null>(null);
  // True for one click after a custom-selection gesture ends. The
  // browser synthesizes a click on touchup/pointerup; without this
  // guard, the document-level click listener would treat that click
  // as an outside-tap and dismiss the just-set selection.
  const ignoreNextClickRef = useRef(false);

  // Custom long-press + drag selection on mobile. Replaces native
  // selection so the OS toolbar (which we can't suppress on Samsung
  // One UI) never has a live window selection to anchor to.
  //
  // BookBody uses touch-action: pan-y so the browser handles vertical
  // scroll natively with momentum. We only call preventDefault on
  // pointermove during active selection drag — that suppresses scroll
  // for the in-flight selection without affecting normal swipes.
  useEffect(() => {
    const bodyEl = document.querySelector<HTMLElement>("[data-book-body]");
    if (!bodyEl) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let longPressTimer: number | null = null;
    let isSelecting = false;
    // Saved word boundaries from the long-press. Form a "minimum
    // range" — pointer movement inside this range leaves the
    // selection alone; movement past either side extends in that
    // direction.
    let wordStart: RangeEndpoint | null = null;
    let wordEnd: RangeEndpoint | null = null;

    const updateFromRange = (range: Range) => {
      const anchor = anchorFromRange(range);
      if (anchor) {
        setSelAnchor(anchor);
        setActiveHl(null);
        setSelRects(
          Array.from(range.getClientRects()).map(
            (r) => new DOMRect(r.x, r.y, r.width, r.height),
          ),
        );
        setHandleRects(computeHandleRects(range));
      }
    };

    const startSelection = (cx: number, cy: number) => {
      const ep = caretFromPoint(cx, cy);
      if (!ep) return false;
      const p = paragraphOf(ep.node);
      if (!p) return false;
      const [ws, we] = wordRangeAt(ep.node, ep.offset);
      const range = document.createRange();
      range.setStart(ep.node, ws);
      range.setEnd(ep.node, we);
      startEndpointRef.current = { node: ep.node, offset: ws };
      endEndpointRef.current = { node: ep.node, offset: we };
      wordStart = { node: ep.node, offset: ws };
      wordEnd = { node: ep.node, offset: we };
      paragraphRef.current = p;
      updateFromRange(range);
      return true;
    };

    const cancelLongPressTimer = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (pointerId !== null) return;
      if ((e.target as HTMLElement | null)?.closest("[data-h-id]")) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      isSelecting = false;
      cancelLongPressTimer();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        if (pointerId === null) return;
        try {
          bodyEl.setPointerCapture(pointerId);
        } catch {
          return;
        }
        if (startSelection(startX, startY)) {
          isSelecting = true;
        }
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!isSelecting) {
        // Before long-press fires, we let the browser scroll natively.
        // If movement exceeds the tap tolerance, cancel the long-press
        // timer — the user's gesture is a scroll, not a hold.
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) {
          cancelLongPressTimer();
          pointerId = null;
        }
        return;
      }
      // Selecting — extend the range and preventDefault to keep the
      // browser from also scrolling. The long-pressed word forms a
      // minimum: while the finger sits inside it (or just jitters),
      // we leave the selection alone. Movement past either side of
      // the word extends in that direction.
      if (!wordStart || !wordEnd) return;
      const currentEp = caretFromPoint(e.clientX, e.clientY);
      if (!currentEp) return;
      const clamped = clampToBookBody(currentEp);
      if (!clamped) return;
      let newStart: RangeEndpoint;
      let newEnd: RangeEndpoint;
      if (comesBefore(clamped, wordStart)) {
        // Finger crossed before the word's start — extend backward,
        // keep the word's end as the far boundary.
        newStart = clamped;
        newEnd = wordEnd;
      } else if (comesBefore(wordEnd, clamped)) {
        // Finger crossed past the word's end — extend forward.
        newStart = wordStart;
        newEnd = clamped;
      } else {
        // Inside the word — no change.
        newStart = wordStart;
        newEnd = wordEnd;
      }
      startEndpointRef.current = newStart;
      endEndpointRef.current = newEnd;
      const range = buildRange(newStart, newEnd);
      if (!range.collapsed) updateFromRange(range);
      e.preventDefault();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      cancelLongPressTimer();
      if (isSelecting) {
        try {
          bodyEl.releasePointerCapture(e.pointerId);
        } catch {
          // already released
        }
        // The browser will synthesize a click event right after this
        // pointerup. Tell the document click listener to swallow it
        // so it doesn't dismiss the selection we just settled.
        ignoreNextClickRef.current = true;
      }
      pointerId = null;
      isSelecting = false;
      wordStart = null;
      wordEnd = null;
    };

    bodyEl.addEventListener("pointerdown", onPointerDown);
    bodyEl.addEventListener("pointermove", onPointerMove);
    bodyEl.addEventListener("pointerup", onPointerUp);
    bodyEl.addEventListener("pointercancel", onPointerUp);
    return () => {
      cancelLongPressTimer();
      bodyEl.removeEventListener("pointerdown", onPointerDown);
      bodyEl.removeEventListener("pointermove", onPointerMove);
      bodyEl.removeEventListener("pointerup", onPointerUp);
      bodyEl.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  // Handle-drag effect: tracks pointer movement after the user grabs
  // one of the start/end handles and extends the selection range.
  useEffect(() => {
    if (!handleRects) return;

    const onMove = (e: PointerEvent) => {
      if (
        draggingHandleRef.current === null ||
        e.pointerId !== draggingPointerIdRef.current
      ) {
        return;
      }
      const start = startEndpointRef.current;
      const end = endEndpointRef.current;
      if (!start || !end) return;

      const currentEp = caretFromPoint(e.clientX, e.clientY);
      if (!currentEp) return;
      const clamped = clampToBookBody(currentEp);
      if (!clamped) return;

      const nextStart =
        draggingHandleRef.current === "start" ? clamped : start;
      const nextEnd = draggingHandleRef.current === "end" ? clamped : end;

      // If the user crossed the other handle, swap so start stays before end.
      const range = buildRange(nextStart, nextEnd);
      if (!range.collapsed) {
        // Re-derive ordered endpoints from the built range so future
        // drags continue from the visually-correct side.
        const ordered = orderedEndpoints(range);
        startEndpointRef.current = ordered.start;
        endEndpointRef.current = ordered.end;
        const anchor = anchorFromRange(range);
        if (anchor) {
          setSelAnchor(anchor);
          setSelRects(
            Array.from(range.getClientRects()).map(
              (r) => new DOMRect(r.x, r.y, r.width, r.height),
            ),
          );
          setHandleRects(computeHandleRects(range));
        }
      }
      e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== draggingPointerIdRef.current) return;
      if (draggingHandleRef.current !== null) {
        ignoreNextClickRef.current = true;
      }
      draggingHandleRef.current = null;
      draggingPointerIdRef.current = null;
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [handleRects]);

  // All popover dismissal flows through clicks: tap an existing
  // highlight to open its action popover, tap outside everything to
  // dismiss. We deliberately don't use selectionchange — the
  // note-editor textarea fires it on every keystroke, which would
  // tear the popover down mid-typing.
  const highlightById = (id: string) =>
    state.highlights.find((h) => h.id === id);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ignoreNextClickRef.current) {
        // Synthetic click right after a custom-selection gesture
        // finished. Skip dismissal exactly once.
        ignoreNextClickRef.current = false;
        return;
      }
      // composedPath snapshots the ancestor chain at dispatch time —
      // robust against post-dispatch DOM mutations (e.g. clicking the
      // pencil button swaps it for a textarea before this handler
      // runs, leaving target.closest() walking a detached subtree).
      const path = (e.composedPath?.() ?? []) as EventTarget[];
      const inPopover = path.some(
        (node) =>
          node instanceof HTMLElement &&
          node.dataset.popover === "highlight",
      );
      if (inPopover) return;

      // Used to bail out if the native selection was still live — our
      // custom selection model no longer uses the native selection at all,
      // so this guard is now meaningless and gets dropped.

      const markNode = path.find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.dataset.hId !== undefined,
      );
      if (markNode && markNode.dataset.hId) {
        const h = highlightById(markNode.dataset.hId);
        if (h) {
          setActiveHl({ highlight: h, rect: markNode.getBoundingClientRect() });
          setSelAnchor(null);
          return;
        }
      }
      setActiveHl(null);
      setSelAnchor(null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.highlights]);

  const dismissSelection = () => {
    setSelAnchor(null);
    setSelRects([]);
    setHandleRects(null);
    startEndpointRef.current = null;
    endEndpointRef.current = null;
    paragraphRef.current = null;
  };
  const createFromSelection = (color: HighlightColor, note?: string) => {
    if (!selAnchor) return;
    // Multi-paragraph selections become N highlights that share one
    // groupId so they delete together. Single-paragraph selections
    // need no groupId. The note (if any) attaches only to the first
    // segment so it isn't duplicated.
    const trimmedNote = note?.trim() || undefined;
    const groupId =
      selAnchor.segments.length > 1 ? crypto.randomUUID() : undefined;
    selAnchor.segments.forEach((seg, i) => {
      onCreateHighlight({
        chapter: currentChapter,
        paragraphIndex: seg.paragraphIndex,
        charStart: seg.charStart,
        charEnd: seg.charEnd,
        text: seg.text,
        color,
        note: i === 0 ? trimmedNote : undefined,
        groupId,
      });
    });
    dismissSelection();
  };

  return (
    <div
      // Reader CHROME follows the UI language (toolbars, sheet all mirror
      // under Arabic). Book CONTENT direction is independent — BookBody
      // sets its own `dir` from the book's language on its own element
      // below, overriding this cascade for its subtree regardless of what
      // `dir` resolves to here.
      dir={dir}
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
        fontFamily: FONT_STACKS.sans,
      }}
    >
      {/* Top chrome — always mounted so it can transform/fade rather
          than hard-cut. Hidden state slides up off-screen and disables
          pointer events so taps fall through to the reader. */}
      <div
        ref={chromeRef}
        className={glassTop.className}
        aria-hidden={chromeHidden}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          padding: "env(safe-area-inset-top, 12px) 14px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          // Frosted, so the paragraph passing under the bar stays visible
          // instead of being clipped off by an opaque strip — see
          // reader/chrome/glass.ts.
          ...glassTop.style,
          transform: chromeHidden ? "translateY(-100%)" : "translateY(0)",
          opacity: chromeHidden ? 0 : 1,
          transition: chromeTransition,
          pointerEvents: chromeHidden ? "none" : "auto",
          // Keep chrome out of text selection — without this, a long-
          // press 'Select all' grabs the chapter title and progress
          // text along with the body paragraphs, which then resolves
          // to a nonsense highlight range.
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
          <ChapterProgressBar fillRef={progressFillRef} theme={theme} rtl={rtl} />
          <button
            onClick={onBack}
            style={{ ...mobileTab(theme), width: 36, height: 36 }}
            aria-label={tr("reader.backToLibrary")}
          >
            {/* `home`, not a back arrow: the other two readers have always used
                it, and this button leaves the reader for the library rather
                than stepping back through history. */}
            <Icon name="home" size={16} />
          </button>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 1,
              minWidth: 0,
            }}
          >
            <div
              // Inherits FONT_STACKS.sans (Readex Pro) from the chrome
              // wrapper — same UI font used by panel headers / bottom
              // tabs, and renders Arabic glyphs natively instead of
              // through Fraunces' Latin-shaped italic.
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: theme.ink,
                letterSpacing: "-0.01em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "100%",
              }}
            >
              {book.title || tr("common.untitled")}
            </div>
            <div style={{ fontSize: 10, color: theme.muted }}>
              {tr("reader.chapterOfTotal", { n: currentChapter + 1, total: chapterCount })}
            </div>
          </div>
          {/* Mirrors the back button so the title block is centred on the BAR
              rather than on the space left over beside the button. Without it
              the flex row is asymmetric — button + gap on one side, nothing on
              the other — and the title sits 22px off-centre (toward the left
              in RTL, where the button is on the right). */}
          <div
            aria-hidden
            style={{ width: 36, height: 36, flexShrink: 0, pointerEvents: "none" }}
          />
        </div>

      <div
        ref={scrollRef}
        // A tap anywhere on the page toggles the chrome — including on a
        // highlight, which also opens its action popover through the
        // document-level click handler. The reading surface is scroll-only:
        // the edge bands that used to page up and down are gone.
        onClick={() => setShowChrome((s) => !s)}
        style={{
          flex: 1,
          overflow: "auto",
          background: surfaces.page,
          // Padding stays constant whether chrome is shown or hidden —
          // the chrome bars are absolutely positioned and act as a
          // translucent overlay (iOS Books / Kindle style). Swapping
          // padding on toggle was reflowing the visible lines and
          // moving the user's reading position.
          // Horizontal inset scales with the content-width setting so 100%
          // actually reaches the edges — see readingGutter. Vertical padding
          // stays constant per the note above.
          padding: `44px ${readingGutter(t.contentWidth, 8, 28)}px 44px`,
          position: "relative",
        }}
        className="no-scrollbar"
      >
        <BookBody
          bookId={book.id}
          chapter={chapter}
          chapterCount={chapterCount}
          theme={contentTheme}
          themeKey={themeKey}
          highlights={state.highlights}
          fontFamily={t.fontFamily}
          fontSize={t.fontSize}
          lineHeight={t.lineHeight}
          letterSpacing={t.letterSpacing}
          textAlign={t.textAlign}
          // Mobile ignores the desktop-only layout tweaks (reading mode,
          // page width) — the screen is narrow enough that paginated columns
          // or >360px page width would just overflow.
          rtl={isRtlLanguage(book.language)}
          paragraphSpacing={t.paragraphSpacing}
          hyphenation={t.hyphenation}
          language={book.language}
          widthPercent={t.contentWidth}
          selectable={false}
        />
      </div>

      {/* Bottom chrome — same always-mounted pattern as the top bar.
          Slides down off-screen when hidden and gives up pointer events. */}
      <div
        className={glassBottom.className}
        aria-hidden={chromeHidden}
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 10,
          padding: "14px 20px calc(env(safe-area-inset-bottom, 0px) + 16px)",
          color: theme.chromeInk,
          ...glassBottom.style,
          transform: chromeHidden ? "translateY(100%)" : "translateY(0)",
          opacity: chromeHidden ? 0 : 1,
          transition: chromeTransition,
          pointerEvents: chromeHidden ? "none" : "auto",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
          {showProgress && (
            <ReaderProgressBar
              theme={theme}
              rtl={dir === "rtl"}
              fraction={barFraction}
              formatPct={(f) => `${formatNum(Math.round(f * 100), locale)}%`}
              formatLabel={(f) =>
                tr("reader.chapterDash", {
                  n: formatNum(chapterAt(f) + 1, locale),
                  title: book.chapters[chapterAt(f)]?.title ?? "",
                })
              }
              ticks={ticks}
              prevLabel={tr("reader.prevChapter")}
              nextLabel={tr("reader.nextChapter")}
              onPrev={prevChapter}
              onNext={nextChapter}
              prevDisabled={currentChapter === 0}
              nextDisabled={currentChapter >= chapterCount - 1}
              // No `onScrub`: the reader stays put while the finger moves, so a
              // sweep across the book doesn't load every chapter it crosses.
              // The handle and the chip preview the target; release commits.
              onSeek={(f) => {
                const next = chapterAt(f);
                if (next !== currentChapter) onChapterChange(next);
              }}
              ariaLabel={tr("reader.chapterProgress")}
              valueMin={1}
              valueMax={Math.max(1, chapterCount)}
              valueNow={currentChapter + 1}
              valueText={chapter.title}
              reducedMotion={reduced}
              labelWidth={0}
              padding="0 6px 6px"
            />
          )}
          <ReaderTabBar
            theme={theme}
            active={sheet === "toc" || sheet === "highlights" || sheet === "progress" || sheet === "settings" ? sheet : null}
            onOpen={setSheet}
            showProgress={showProgress}
            onToggleProgress={() => setShowProgress((s) => !s)}
          />
        </div>

      {/* Sheet stays mounted while it animates out — pass `open` so it
          knows whether to show the enter or exit keyframes. */}
      <MobileSheet
        theme={theme}
        open={sheet !== null}
        onClose={() => setSheet(null)}
        height="82%"
        label={
          sheet === "toc"
            ? tr("reader.toc")
            : sheet === "settings"
              ? tr("reader.readingSettings")
              : sheet === "highlights"
                ? tr("reader.highlights")
                : sheet === "progress"
                  ? tr("reader.readingProgress")
                  : undefined
        }
      >
        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {sheet === "toc" && (
              <TOCPanel
                theme={theme}
                onClose={() => setSheet(null)}
                bookTitle={book.title}
                chapters={book.chapters}
                currentChapter={currentChapter}
                volumes={tocVolumes}
                onJump={(order) => {
                  onChapterChange(order);
                  setSheet(null);
                }}
                // Fluid layout inside the sheet — phone widths vary
                // (360px to 430px+) and the desktop 340px column would
                // leave dead space on the right. The sheet itself owns
                // the rounded chrome, so we drop the panel's side border.
                width="100%"
                side={undefined}
              />
            )}
            {sheet === "highlights" && (
              <HighlightsPanel
                theme={theme}
                themeKey={themeKey}
                onClose={() => setSheet(null)}
                highlights={state.highlights}
                onJump={(h) => {
                  onJumpToHighlight(h);
                  setSheet(null);
                }}
                onDelete={onDeleteHighlight}
                onUpdateNote={onUpdateHighlightNote}
                width="100%"
                side={undefined}
              />
            )}
            {sheet === "settings" && (
              <SettingsPanel
                theme={theme}
                themeKey={themeKey}
                t={t}
                setTweak={setTweak}
                onClose={() => setSheet(null)}
                width="100%"
                side={undefined}
                mobile
                onOpenFullSettings={
                  onOpenFullSettings
                    ? () => {
                        setSheet(null);
                        onOpenFullSettings();
                      }
                    : undefined
                }
              />
            )}
            {sheet === "progress" && (
              <div
                style={{
                  padding: 22,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "center",
                }}
              >
                <ProgressOverlay
                  theme={theme}
                  themeKey={themeKey}
                  currentChapter={currentChapter}
                  chapterCount={chapterCount}
                  chapterTitle={chapter.title}
                />
              </div>
            )}
        </div>
      </MobileSheet>
      {selAnchor && (
        <>
          <SelectionOverlay rects={selRects} />
          {handleRects && (
            <>
              <SelectionHandle
                rect={handleRects.start}
                position="start"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  draggingHandleRef.current = "start";
                  draggingPointerIdRef.current = e.pointerId;
                }}
              />
              <SelectionHandle
                rect={handleRects.end}
                position="end"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  draggingHandleRef.current = "end";
                  draggingPointerIdRef.current = e.pointerId;
                }}
              />
            </>
          )}
          <SelectionPopover
            theme={theme}
            anchor={selAnchor.rect}
            placement="below"
            onPick={(color) => createFromSelection(color)}
            onAddNote={(color, note) => createFromSelection(color, note)}
            onDismiss={dismissSelection}
          />
        </>
      )}
      {activeHl && (
        <HighlightActionPopover
          theme={theme}
          highlight={activeHl.highlight}
          anchor={activeHl.rect}
          onDelete={() => {
            onDeleteHighlight(activeHl.highlight.id);
            setActiveHl(null);
          }}
          onUpdateNote={(note) => {
            onUpdateHighlightNote(activeHl.highlight.id, note);
            setActiveHl(null);
          }}
          onDismiss={() => setActiveHl(null)}
        />
      )}
    </div>
  );
}
