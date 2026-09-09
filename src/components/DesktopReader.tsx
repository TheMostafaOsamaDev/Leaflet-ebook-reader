import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SideSheet } from "./SideSheet";
import {
  CHROME_INSET_BOTTOM,
  CHROME_INSET_TOP,
  FocusHint,
  useFocusChrome,
} from "../reader/chrome/focusChrome";
import { ReaderTopBar } from "../reader/chrome/ReaderTopBar";
import { MAX_TICKS, ReaderProgressBar } from "../reader/chrome/ReaderProgressBar";
import { ReaderIconButton } from "../reader/chrome/ReaderIconButton";
import { BookBody, readingGutter } from "./BookBody";
import { ChapterEndCard, ChapterStartLink } from "./ChapterEnd";
import { PaginatedView, type PaginatedAPI } from "./PaginatedView";
import {
  chapterScrollFraction,
  paragraphScrollOffset,
  restoreScrollTop,
  fractionToWidth,
  landAtEndFor,
} from "./readerProgress";
import { ReaderDiagnostics } from "./ReaderDiagnostics";
import { jumpScrollTop } from "./scrollJump";
import { ReaderLogMarker } from "./ReaderLogMarker";
import {
  log as logEvent,
  logSessionStart,
  snapshotReader,
} from "../lib/devLog";
import { finishStuckAnimations } from "../lib/finishStuckAnimations";

/** See the probe's render site below. Read once, so a reload is the switch. */
const READER_PROBE = (() => {
  try {
    return localStorage.getItem("riwaq:dev:probe") === "1";
  } catch {
    return false;
  }
})();
import { SelectionPopover } from "./SelectionPopover";
import { HighlightActionPopover } from "./HighlightActionPopover";
import type { EpubBook } from "../epub/types";
import type { BookState, Highlight } from "../store/library";
import type { HighlightColor } from "../styles/tokens";
import {
  resolveSelectionAnchor,
  type SelectionAnchor,
} from "../lib/selectionAnchor";
import {
  FONT_STACKS,
  isRtlLanguage,
  readingSurfaces,
  titleFontFor,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";
import { useMediaQuery } from "../hooks/useMediaQuery";
import {
  DOCK_QUERY,
  DOCK_WIDTH,
  shouldDockContents,
} from "../reader/chrome/dockContents";
import { useI18n } from "../i18n/useI18n";
import { formatNum } from "../i18n";
import { useReducedMotion } from "../styles/motion";
import { useLineScroll } from "../reader/scroll/useLineScroll";
import { HighlightsPanel } from "../panels/HighlightsPanel";
import { ProgressOverlay } from "../panels/ProgressOverlay";
import { SettingsPanel } from "../panels/SettingsPanel";
import { TOCPanel } from "../panels/TOCPanel";
import type { ActivePanel, TocVolume, Tweaks } from "../types/reader";

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  book: EpubBook;
  state: BookState;
  currentChapter: number;
  /** Paragraph to scroll to when the chapter mounts. Read once per chapter
      change; live scroll position is owned by the reader itself. */
  resumeParagraph: number;
  /** 0..1 sub-paragraph scroll offset to resume at (scroll mode). Optional;
      defaults to 0 (paragraph top) for callers that don't track it yet. */
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
  /** Volume ranges for the Contents panel, when the book's origin knows them
   *  (source novels). Omit for local EPUBs — Contents stays ungrouped. */
  tocVolumes?: TocVolume[];
  /** Whether the NEXT chapter is already on the device, shown on the
   *  end-of-chapter card because it predicts whether the turn will wait.
   *  Omit when unknown — the card then says nothing rather than guessing. */
  nextChapterAvailability?: "device" | "online";
  activePanel: ActivePanel;
  setActivePanel: (next: ActivePanel) => void;
  /** Navigate to the top-level Settings page (from the quick-panel link). */
  onOpenFullSettings?: () => void;
  onBack: () => void;
}

export function DesktopReader({
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
  nextChapterAvailability,
  activePanel,
  setActivePanel,
  onOpenFullSettings,
  onBack,
}: Props) {
  const { tr, dir, locale } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mode = t.readingMode;
  const isPaginated = mode !== "scroll";
  const paginatedColumns: 1 | 2 = mode === "paginated-2" ? 2 : 1;
  // Content direction — derived from the BOOK's own language, independent of
  // the UI locale above. Feeds BookBody/PaginatedView's own `dir` attribute
  // (set on their own elements, so it never inherits from the chrome below).
  const rtl = isRtlLanguage(book.language);

  // Effective reading colors: the user's ink/paper overrides layered over the
  // active theme ("auto" falls back to theme.ink / theme.bg). `contentTheme`
  // recolors only the reading surface + text, leaving the chrome on `theme`.
  const surfaces = readingSurfaces(theme);
  const contentTheme: Theme = theme;

  // Contents docks beside the reading column instead of covering it, so you
  // can see where you are in the book and keep reading at the same time. The
  // rule (which panel, and how wide the window has to be) lives in
  // reader/chrome/dockContents.ts because the fixed-page reader applies the
  // identical one — the last attempt at docking only did it here, so opening
  // Contents meant one thing on an EPUB and another on a PDF.
  //
  // Docking narrows the reading column, so the book does re-wrap once on open
  // and once on close. That is unavoidable: the panel takes real width and
  // the gutter has nowhere near 340px of slack to give back. What keeps it
  // from throwing the reader's place away is PaginatedView, which re-anchors
  // on the paragraph they were reading whenever its width changes.
  const roomToDock = useMediaQuery(DOCK_QUERY);
  const tocDocked = shouldDockContents(activePanel, roomToDock);

  // ── Focus mode ────────────────────────────────────────────────────────────
  // Shared with the fixed-page reader — see reader/chrome/focusChrome.tsx.
  const reduced = useReducedMotion();
  // Wheel scrolling glides and comes to rest on a whole line. Scroll mode
  // only — the paginated modes do not scroll. See reader/scroll/lineScroll.ts.
  useLineScroll({
    scrollRef,
    mode: mode === "scroll" ? "wheel" : "off",
    reducedMotion: reduced,
  });
  const panelOpen = activePanel !== null;
  const focus = useFocusChrome({
    active: t.focusMode,
    setActive: (next) => setTweak("focusMode", next),
    panelOpen,
    closePanels: () => setActivePanel(null),
    theme,
    reducedMotion: reduced,
    // A docked Contents panel keeps the floating bars off its own header.
    dockInset: tocDocked ? DOCK_WIDTH : 0,
  });
  // The top bar frosts itself (ReaderTopBar); the bottom one is assembled here
  // out of ReaderProgressBar, so its wrapper carries the glass.
  const glassBottom = focus.glass("bottom");

  // The live paragraph for the current chapter — updated by both the
  // scroll listener and PaginatedView. Used so that switching reading
  // modes mid-chapter lands the user on the same paragraph they were
  // reading, not on the chapter's resume hint (which only updates on
  // chapter switch / highlight jump).
  const livePara = useRef(resumeParagraph);
  // Sub-paragraph scroll offset (0..1) to resume at, kept in sync with
  // livePara — re-seeded from resumeOffset on the same chapter/jump changes.
  const liveOffset = useRef(resumeOffset);
  // Imperatively-updated fill for the header's within-chapter progress bar.
  const progressFillRef = useRef<HTMLDivElement>(null);
  const lastChapterRef = useRef(currentChapter);
  const lastJumpNonceRef = useRef(jumpNonce);
  if (lastChapterRef.current !== currentChapter) {
    lastChapterRef.current = currentChapter;
    livePara.current = resumeParagraph;
    liveOffset.current = resumeOffset;
  }
  if (lastJumpNonceRef.current !== jumpNonce) {
    // A targeted jump (e.g., from the highlights panel) within the same
    // chapter — adopt resumeParagraph so the chapter-mount effect lands
    // on the new target instead of where the user was last reading.
    lastJumpNonceRef.current = jumpNonce;
    livePara.current = resumeParagraph;
    liveOffset.current = resumeOffset;
  }

  // The chapter we stepped BACKWARD into via scroll-up overscroll, or null.
  // The chapter-mount effect picks it up and lands the viewport at that
  // chapter's end — natural for an upward scroll, since the reader was just
  // continuing through the chapter edge.
  //
  // It holds the chapter INDEX rather than a bare boolean because the request
  // has to outlive the render that made it (a streamed chapter mounts empty
  // and the effect cannot position anything until its paragraphs arrive) while
  // still being void if the reader goes somewhere else in the meantime. See
  // landAtEndFor.
  const landAtEndRef = useRef<number | null>(null);

  const handleParagraphChange = useCallback(
    (idx: number, offset?: number) => {
      livePara.current = idx;
      if (offset !== undefined) liveOffset.current = offset;
      onParagraphChange(idx, offset);
    },
    [onParagraphChange],
  );
  // Stable so PaginatedView's progress effect only re-fires on page changes,
  // not on every DesktopReader re-render. Writes the bar fill imperatively.
  const onPaginatedProgress = useCallback((f: number) => {
    if (progressFillRef.current)
      progressFillRef.current.style.width = fractionToWidth(f);
  }, []);
  // Same ref trick for the scroll listener — keeps the listener stable
  // while still calling the freshest handler.
  const onParagraphChangeRef = useRef(handleParagraphChange);
  onParagraphChangeRef.current = handleParagraphChange;
  const chapter = book.chapters[currentChapter] ?? book.chapters[0];
  const chapterCount = book.chapters.length;
  const toggle = (panel: ActivePanel) =>
    setActivePanel(activePanel === panel ? null : panel);

  const prevChapter = () => {
    if (currentChapter > 0) onChapterChange(currentChapter - 1);
  };
  /**
   * Back a chapter, landing at its END — what scrolling up past the top
   * already does. Landing at the previous chapter's start would mean
   * scrolling its whole length (fourteen screens, in the book this was built
   * for) to reach the part that adjoins where the reader just was.
   */
  const prevChapterAtEnd = () => {
    if (currentChapter <= 0) return;
    landAtEndRef.current = currentChapter - 1;
    prevChapter();
  };
  const nextChapter = () => {
    if (currentChapter < chapterCount - 1) onChapterChange(currentChapter + 1);
  };

  // Scroll to the live paragraph whenever the chapter changes or the
  // mode flips back to scroll — only active in scroll mode. Paginated
  // mode owns its own resume logic via PaginatedView's `initialParagraph`
  // prop. Using `livePara` (not `resumeRef`) means a paginated→scroll
  // switch lands on the same paragraph the user was just reading, not on
  // the chapter's original entry point.
  // useLayoutEffect, not useEffect: this runs BEFORE the browser paints the
  // new chapter, so the chapter's first paint happens at the position the
  // reader should be at. Under useEffect the browser painted the chapter at
  // the top first and the scroll landed after, and WKWebView would not paint
  // the region that jump revealed — leaving a chapter that was present,
  // laid out, selectable and completely invisible until the reader scrolled.
  // Positioning before the first paint means there is no second position to
  // repaint into. jumpScrollTop's nudge stays as a safety net for the case
  // where the content's height changes after this pass.
  useLayoutEffect(() => {
    if (mode !== "scroll") return;
    const el = scrollRef.current;
    if (!el) return;
    // Streamed (source) chapters load their body async; the paragraphs aren't
    // in the DOM on this effect's first run. Bail until they exist — the
    // chapter content-id dep re-runs this once they mount. Returning here also
    // preserves landAtEndRef (we don't consume it on an empty pass).
    if (el.querySelectorAll("[data-p-index]").length === 0) return;
    logEvent("position:run", {
      chapter: currentChapter,
      chapterId: chapter.id,
      reactItems: chapter.paragraphs?.length ?? 0,
      domParas: el.querySelectorAll("[data-p-index]").length,
      scrollTopBefore: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      livePara: livePara.current,
      liveOffset: liveOffset.current,
      landAtEndPending: landAtEndRef.current,
    });
    if (landAtEndFor(landAtEndRef.current, currentChapter)) {
      // Came in via scroll-up overscroll — drop the reader at the bottom
      // of the new (previous) chapter so reading continues naturally
      // upward instead of jumping to the chapter's top.
      landAtEndRef.current = null;
      // The big one: a jump to the end of a long chapter is exactly the case
      // WKWebView leaves unpainted. See jumpScrollTop.
      jumpScrollTop(el, el.scrollHeight);
      logEvent("position:landAtEnd", { scrollTopAfter: Math.round(el.scrollTop) });
      const ps = el.querySelectorAll<HTMLElement>("[data-p-index]");
      if (ps.length > 0) {
        let lastIdx = 0;
        for (const p of ps) {
          const idx = Number(p.dataset.pIndex);
          if (idx > lastIdx) lastIdx = idx;
        }
        livePara.current = lastIdx;
        // Persist so resume after a restart matches what the user sees.
        onParagraphChangeRef.current(lastIdx);
      }
      return;
    }
    // When resuming at the very first paragraph, snap to scrollTop=0 so
    // the chapter heading (Chapter N of M + title) BookBody renders above
    // paragraph 0 stays visible. Using paragraph 0's offsetTop scrolls the
    // heading off-screen and looks like the title is clipped on load.
    if (livePara.current === 0 && liveOffset.current <= 0.001) {
      jumpScrollTop(el, 0);
      logEvent("position:top", { scrollTopAfter: Math.round(el.scrollTop) });
      return;
    }
    const target = el.querySelector<HTMLElement>(
      `[data-p-index="${livePara.current}"]`,
    );
    if (target) {
      jumpScrollTop(
        el,
        restoreScrollTop(target.offsetTop, target.offsetHeight, liveOffset.current),
      );
      logEvent("position:restore", {
        targetOffsetTop: target.offsetTop,
        scrollTopAfter: Math.round(el.scrollTop),
      });
    } else {
      jumpScrollTop(el, 0);
      logEvent("position:noTarget", { scrollTopAfter: Math.round(el.scrollTop) });
    }
    // book.chapters[currentChapter]?.id changes when a streamed chapter's
    // content is spliced in (its `#0` → `#<n>` id bump), re-running this so
    // resume fires once the paragraphs are actually in the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, book.id, mode, jumpNonce, book.chapters[currentChapter]?.id]);

  // Throttled scroll listener — find the topmost-visible paragraph and
  // bubble its index up to the App state for persistence. Only runs in
  // scroll mode; paginated mode reports paragraphs through PaginatedView.
  useEffect(() => {
    if (mode !== "scroll") return;
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
  }, [mode]);

  // Live within-chapter progress for the header bar. Separate from the 250ms
  // paragraph listener (too coarse for a smooth bar) and written imperatively
  // so scrolling never re-renders React.
  useEffect(() => {
    if (mode !== "scroll") return;
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
    paint(); // initial fill for this chapter
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [mode, currentChapter, book.id]);

  // Imperative handle on the paginated view so the keyboard handler and
  // the bottom-bar arrow buttons can flip pages without rebuilding the
  // PaginatedView's internal page state on every render.
  const paginatedApiRef = useRef<PaginatedAPI | null>(null);
  const onPaginatedApi = useCallback((api: PaginatedAPI) => {
    paginatedApiRef.current = api;
  }, []);

  // Ref on the paginated wrapper so the wheel listener can preventDefault
  // (must be non-passive) without touching the scroll container.
  const paginatedWrapRef = useRef<HTMLDivElement>(null);

  // Wheel-to-flip-page in paginated modes. A short cooldown prevents a
  // single trackpad gesture from skipping multiple pages in one swipe.
  // At a chapter boundary (first/last page) it falls through to chapter
  // navigation so the user can keep scrolling through the book.
  useEffect(() => {
    if (!isPaginated) return;
    const el = paginatedWrapRef.current;
    if (!el) return;
    let cooldown = false;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 4) return; // ignore minor trackpad noise
      e.preventDefault();
      if (cooldown) return;
      cooldown = true;
      window.setTimeout(() => { cooldown = false; }, 380);
      const api = paginatedApiRef.current;
      if (e.deltaY > 0) {
        // Forward — next page, or next chapter at the last page.
        if (!api?.nextPage()) {
          if (currentChapter < chapterCount - 1) onChapterChange(currentChapter + 1);
        }
      } else {
        // Backward — prev page, or prev chapter at the first page.
        if (!api?.prevPage()) {
          if (currentChapter > 0) onChapterChange(currentChapter - 1);
        }
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaginated, currentChapter, chapterCount, onChapterChange]);

  // Scrolling at a chapter edge does NOT turn the chapter. The card at the
  // chapter's end and the link at its top are the ways through, alongside the
  // arrow keys.
  //
  // This reverses the "or keep scrolling past it" half of the original brief,
  // and it is a decision rather than an omission. Three scroll-based rules were
  // tried in the app and each failed the same way:
  //
  //   1. A velocity threshold, 1.6-4.6 notches scaled by wheel speed. Safe,
  //      but every deliberate turn cost a push — which is what made the old
  //      behaviour feel inefficient in the first place.
  //   2. One turn per gesture, silence-based. A turn lands the reader ON an
  //      edge (the last pixel going back, the first going forward), so their
  //      next scroll reversed it. Measured: four turns in ten seconds,
  //      alternating, never more than 359px into a chapter.
  //   3. Disarming the direction that would undo the arrival until the reader
  //      moved off that edge. Better, and still wrong: the guard cleared on
  //      any movement, so landing at 7753, nudging up 157px to read, and
  //      nudging back down turned the chapter anyway.
  //
  // The shared cause is that a wheel at an edge cannot distinguish "reading
  // near the end" from "take me onward" — the intent is not in the gesture. It
  // is in the card. Restoring scroll-to-turn means reviving
  // reader/scroll/turnGate.ts, which is still in the tree with its tests.

  // A chapter change from anywhere else — TOC, the scrubber, the keyboard —
  // is not the reader pushing at an edge, so drop any in-flight arming
  // instead of leaving a stale pill on screen or half-armed state behind.
  // The pill always goes; the engine's own state survives its own turns.
  // Opens the log with everything needed to read it cold: which book, how long,
  // which layout, and how big the window is. Runs once per mount, and the log
  // file is truncated at that point, so the file always describes this run.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    logSessionStart({
      book: { id: book.id, title: book.title, chapters: chapterCount, lang: book.language },
      startChapter: currentChapter,
      readingMode: mode,
      theme: themeKey,
      focusMode: t.focusMode,
      contentWidth: t.contentWidth,
      fontSize: t.fontSize,
    });
    const onResize = () =>
      logEvent("window:resize", { w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // The docked Contents panel reflows the reading column, and both blank-page
  // reports so far had it open — so its state belongs in the log.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    logEvent("panel", { activePanel, tocDocked, focusMode: t.focusMode });
    if (mode === "scroll") {
      // Sample after the reflow has had a frame to happen.
      const id = window.setTimeout(
        () => snapshotReader(scrollRef.current, "panel-change"),
        250,
      );
      return () => window.clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanel, tocDocked, t.focusMode, mode]);

  // Insurance against the class of bug that produced blank chapters: WKWebView
  // holds an animation's first keyframe while the document is hidden, so
  // anything that mounted occluded can come back invisible. The entry
  // animation that caused it is gone; this lands anything else that was queued
  // while hidden, the moment the reader looks at the window again.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      const landed = finishStuckAnimations(scrollRef.current);
      if (landed > 0) logEvent("animations:finished", { count: landed });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // A chapter turn is the moment the bug happens, so the pane is sampled as
  // the frames after it go by: the positioning decision is logged above, and
  // these say whether what landed stayed correct once layout, streamed content
  // and animations had all settled.
  useEffect(() => {
    if (!import.meta.env.DEV || mode !== "scroll") return;
    const el = () => scrollRef.current;
    snapshotReader(el(), "turn+0ms", { chapter: currentChapter });
    const timers = [120, 400, 1200, 2500].map((ms) =>
      window.setTimeout(
        () => snapshotReader(el(), `turn+${ms}ms`, { chapter: currentChapter }),
        ms,
      ),
    );
    return () => timers.forEach(window.clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, book.id, mode, book.chapters[currentChapter]?.id]);

  useEffect(() => {
    logEvent("chapter:external", { chapter: currentChapter });
    // A TOC jump or scrub is an explicit destination, so any outstanding
    // land-at-end request is void — otherwise it would still be waiting if the
    // reader ever came back to that chapter by another route.
    landAtEndRef.current = null;
  }, [currentChapter, book.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable))
        return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      // In RTL, "forward in the book" is the LEFT arrow — the same arrow
      // that visually points the way pages flip in a RTL-bound book.
      const forward = rtl ? e.key === "ArrowLeft" : e.key === "ArrowRight";
      if (isPaginated) {
        // Paginated: arrows flip pages. At a chapter boundary, fall
        // through to chapter navigation so the user can keep pressing
        // the arrow to keep moving through the book.
        const api = paginatedApiRef.current;
        if (forward) {
          if (!api || !api.nextPage()) nextChapter();
        } else {
          if (!api || !api.prevPage()) prevChapter();
        }
      } else {
        if (forward) nextChapter();
        else prevChapter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Chapter landmarks on the bottom progress bar. The bar's fraction is
  // `chapter / (count - 1)` — chapter 0 at the start, the last chapter at the
  // end — so it round-trips through a seek and a landmark sits exactly where
  // its chapter begins. The first and last are the track's own ends, so they
  // are dropped rather than drawn under the caps.
  const chapterAt = (f: number) =>
    Math.min(chapterCount - 1, Math.max(0, Math.round(f * Math.max(0, chapterCount - 1))));
  const barFraction = chapterCount > 1 ? currentChapter / (chapterCount - 1) : 0;
  const ticks =
    chapterCount > 2 && chapterCount - 2 <= MAX_TICKS
      ? Array.from({ length: chapterCount - 2 }, (_, i) => (i + 1) / (chapterCount - 1))
      : [];

  // Two mutually-exclusive popovers:
  //   - selAnchor: shown when the user just finished selecting text
  //   - activeHl: shown when the user clicked an existing highlight
  // Showing one always clears the other.
  const [selAnchor, setSelAnchor] = useState<SelectionAnchor | null>(null);
  const [activeHl, setActiveHl] = useState<{
    highlight: Highlight;
    rect: DOMRect;
  } | null>(null);

  // Resolve the selection only when the user *stops* selecting (pointerup),
  // not while they're still dragging. Pointerups inside our popover are
  // ignored — those are interactions with the toolbar itself.
  useEffect(() => {
    const onPointerUp = (e: PointerEvent) => {
      const path = (e.composedPath?.() ?? []) as EventTarget[];
      const inPopover = path.some(
        (node) =>
          node instanceof HTMLElement &&
          node.dataset.popover === "highlight",
      );
      if (inPopover) return;
      // Defer one tick so the browser has finalized the selection.
      window.setTimeout(() => {
        const next = resolveSelectionAnchor();
        if (next) {
          setSelAnchor(next);
          setActiveHl(null);
        }
      }, 0);
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, []);

  // All popover dismissal flows through clicks: outside a popover and
  // outside a mark → dismiss both. We deliberately don't use
  // selectionchange — typing in the popover's note editor moves the
  // textarea's caret, which would trigger spurious dismissals.
  const highlightById = (id: string) =>
    state.highlights.find((h) => h.id === id);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // composedPath snapshots the ancestor chain at dispatch time. By
      // the time this bubble-phase handler runs, React may have already
      // unmounted the clicked element (e.g. clicking the popover's
      // pencil swaps in a textarea), so target.closest() would walk a
      // detached node and miss the popover ancestor. Path-based check
      // works regardless of post-dispatch DOM mutations.
      const path = (e.composedPath?.() ?? []) as EventTarget[];
      const inPopover = path.some(
        (node) =>
          node instanceof HTMLElement &&
          node.dataset.popover === "highlight",
      );
      if (inPopover) return;

      // Tail of a drag-select that landed on a mark/text — let the
      // pointerup handler set the create popover; don't dismiss here.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;

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
      // Click outside any highlight or popover — dismiss everything.
      setActiveHl(null);
      setSelAnchor(null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
    // Re-bind when the highlights list changes so the closure sees the
    // fresh array (new IDs need to resolve).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.highlights]);

  const dismissSelection = () => {
    setSelAnchor(null);
    window.getSelection()?.removeAllRanges();
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
      // Reader CHROME follows the UI language (toolbars, panels, bottom
      // progress bar all mirror under Arabic). Book CONTENT direction is
      // independent — BookBody/PaginatedView set their own `dir` from the
      // book's language on their own elements below, which overrides this
      // cascade for their subtree regardless of what `dir` resolves to here.
      dir={dir}
      // Pointer proximity summons a hidden bar; leaving the window retires both.
      {...focus.rootHandlers}
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        // Anchors the chrome bars, which float over the content region in
        // both modes rather than sitting above it in the flow.
        position: "relative",
        fontFamily: FONT_STACKS.sans,
      }}
    >
      {/* The bar floats over the page in BOTH modes, so the paragraph blurs
          through it as it scrolls past — the phone reader's behaviour. Focus
          mode adds the clip window that lets it slide away; out of focus mode
          it is simply pinned. The reading column pads itself clear of the
          space either way (CHROME_INSET_TOP). */}
      <div
        style={
          focus.floating ? focus.clip("top", focus.showTop) : focus.pin("top")
        }
      >
        <div
          style={
            focus.floating ? focus.slide("top", focus.showTop) : undefined
          }
        >
        <ReaderTopBar
        theme={theme}
        onBack={onBack}
        backLabel={tr("reader.backToLibrary")}
        title={chapter.title}
        subtitle={tr("reader.chapterOfTotal", {
          n: currentChapter + 1,
          total: chapterCount,
        })}
        // Arabic / mixed titles render in Readex Pro (via the sans stack) so
        // interleaved digits/Latin share the family; no synthetic italic.
        titleStyle={{ fontFamily: titleFontFor(chapter.title) }}
        progressFillRef={progressFillRef}
        fillRtl={rtl}
        navButtons={
          <>
            <ReaderIconButton
              theme={theme}
              icon="list"
              label={tr("reader.toc")}
              onClick={() => toggle("toc")}
              active={activePanel === "toc"}
            />
            <ReaderIconButton
              theme={theme}
              icon="highlight"
              label={tr("reader.highlights")}
              onClick={() => toggle("highlights")}
              active={activePanel === "highlights"}
            />
          </>
        }
        trailing={
          <>
            <ReaderIconButton
              theme={theme}
              icon="focus"
              label={
                t.focusMode ? tr("reader.exitFocusMode") : tr("reader.focusMode")
              }
              onClick={focus.toggle}
              active={t.focusMode}
            />
            <ReaderIconButton
              theme={theme}
              icon="clock"
              label={tr("reader.progress")}
              onClick={() => toggle("progress")}
              active={activePanel === "progress"}
            />
            <ReaderIconButton
              theme={theme}
              icon="type"
              label={tr("reader.settings")}
              onClick={() => toggle("settings")}
              active={activePanel === "settings"}
            />
          </>
        }
        />
        </div>
      </div>

      {/* Content region. It is both the positioning context for an OVERLAY
          sheet — tool panels float over a full-width reading column — and the
          flex row a DOCKED Contents panel joins, where the reading column
          shrinks beside it instead. The sheet comes first so the docked panel
          lands on the leading edge in flow (and under RTL, on the trailing
          one), with tab order following what the eye sees. The overlay variant
          is absolutely positioned, so its DOM position here costs it nothing. */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        <SideSheet
          open={activePanel !== null}
          onClose={() => setActivePanel(null)}
          dock={tocDocked}
          // Keep an overlay panel clear of the pinned bars. Not applied in
          // focus mode: there the bars start hidden, so insetting the panel
          // would leave two empty strips for no reason.
          chromeInset={
            focus.floating
              ? undefined
              : {
                  top: `calc(${CHROME_INSET_TOP}px + env(safe-area-inset-top, 0px))`,
                  bottom: CHROME_INSET_BOTTOM,
                }
          }
          // Navigation panels rest on the leading edge; tool panels (settings,
          // progress) on the trailing edge. SideSheet flips these under RTL.
          side={
            activePanel === "settings" || activePanel === "progress"
              ? "right"
              : "left"
          }
          label={
            activePanel === "toc"
              ? tr("reader.toc")
              : activePanel === "highlights"
                ? tr("reader.highlights")
                : activePanel === "settings"
                  ? tr("reader.settings")
                  : activePanel === "progress"
                    ? tr("reader.progress")
                    : undefined
          }
        >
          {activePanel === "toc" && (
            <TOCPanel
              theme={theme}
              onClose={() => setActivePanel(null)}
              bookTitle={book.title}
              chapters={book.chapters}
              currentChapter={currentChapter}
              volumes={tocVolumes}
              width={DOCK_WIDTH}
              onJump={(order) => {
                onChapterChange(order);
                // A docked panel isn't in the way, so it stays open: you can
                // pick a chapter, read it, and pick the next one without
                // reopening Contents each time. The overlay still closes —
                // leaving it up would hide the chapter you just jumped to.
                if (!tocDocked) setActivePanel(null);
              }}
            />
          )}
          {activePanel === "highlights" && (
            <HighlightsPanel
              theme={theme}
              themeKey={themeKey}
              onClose={() => setActivePanel(null)}
              highlights={state.highlights}
              onJump={(h) => {
                onJumpToHighlight(h);
                setActivePanel(null);
              }}
              onDelete={onDeleteHighlight}
              onUpdateNote={onUpdateHighlightNote}
            />
          )}
          {activePanel === "settings" && (
            <SettingsPanel
              theme={theme}
              themeKey={themeKey}
              t={t}
              setTweak={setTweak}
              onClose={() => setActivePanel(null)}
              onOpenFullSettings={
                onOpenFullSettings
                  ? () => {
                      // Close the quick-panel first — activePanel is App-level
                      // state that survives the swap to the Settings page, so
                      // without this, Back would return with the panel still open.
                      setActivePanel(null);
                      onOpenFullSettings();
                    }
                  : undefined
              }
            />
          )}
          {activePanel === "progress" && (
            <div
              style={{
                width: 380,
                // Logical, not physical: borderInlineStart always faces the
                // reading column — physical right in LTR, physical left in
                // RTL — matching PanelShell's own side-border logic.
                borderInlineStart: `0.5px solid ${theme.rule}`,
                background: theme.bg,
                padding: 24,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                flexShrink: 0,
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
        </SideSheet>

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            position: "relative",
            minWidth: 0,
          }}
        >
          {isPaginated ? (
            <div
              ref={paginatedWrapRef}
              style={{
                flex: 1,
                // Pads clear of the floating bars, so the first line still sits
                // 60px below the top bar the way it did when the bar was in
                // the flow — but the text now scrolls UNDER it rather than
                // stopping at its edge, which is what the blur samples.
                padding: `calc(${CHROME_INSET_TOP + 60}px + env(safe-area-inset-top, 0px)) ${readingGutter(t.contentWidth, 24, 80)}px ${CHROME_INSET_BOTTOM + 30}px`,
                position: "relative",
                minHeight: 0,
                minWidth: 0,
                background: surfaces.page,
              }}
            >
              <PaginatedView
                columnsPerPage={paginatedColumns}
                rtl={rtl}
                initialParagraph={livePara.current}
                onParagraphChange={handleParagraphChange}
                onApi={onPaginatedApi}
                onChapterProgress={onPaginatedProgress}
                pageTurnAnimation={t.pageTurnAnimation}
              >
                <div key={chapter.id}>
                  <BookBody
                    bookId={book.id}
                    chapter={chapter}
                    chapterCount={chapterCount}
                    theme={contentTheme}
                    themeKey={themeKey}
                    fontFamily={t.fontFamily}
                    fontSize={t.fontSize}
                    lineHeight={t.lineHeight}
                    letterSpacing={t.letterSpacing}
                    textAlign={t.textAlign}
                    rtl={rtl}
                    paragraphSpacing={t.paragraphSpacing}
                    hyphenation={t.hyphenation}
                    language={book.language}
                    highlights={state.highlights}
                  />
                </div>
              </PaginatedView>
            </div>
          ) : (
            <div
              ref={scrollRef}
              style={{
                flex: 1,
                overflow: "auto",
                // Pads clear of the floating bars, so the first line still sits
                // 60px below the top bar the way it did when the bar was in
                // the flow — but the text now scrolls UNDER it rather than
                // stopping at its edge, which is what the blur samples.
                padding: `calc(${CHROME_INSET_TOP + 60}px + env(safe-area-inset-top, 0px)) ${readingGutter(t.contentWidth, 24, 80)}px ${CHROME_INSET_BOTTOM + 30}px`,
                position: "relative",
                background: surfaces.page,
                // overscroll-behavior: contain stops the browser's own
                // chrome bounce so our wheel preventDefault is the
                // authority on what happens past the edge.
                overscrollBehavior: "contain",
              }}
              className="no-scrollbar"
            >
              <div key={chapter.id}>
                {currentChapter > 0 ? (
                  <div
                    style={{
                      maxWidth: 660,
                      margin: "0 auto",
                      padding: `0 ${readingGutter(t.contentWidth, 24, 80)}px`,
                    }}
                  >
                    <ChapterStartLink
                      theme={theme}
                      tr={tr}
                      titleFont={FONT_STACKS[t.fontFamily]}
                      prevNumber={currentChapter}
                      prevTitle={book.chapters[currentChapter - 1]?.title ?? ""}
                      onPrev={prevChapterAtEnd}
                    />
                  </div>
                ) : null}
                <BookBody
                  bookId={book.id}
                  chapter={chapter}
                  chapterCount={chapterCount}
                  theme={contentTheme}
                  themeKey={themeKey}
                  fontFamily={t.fontFamily}
                  fontSize={t.fontSize}
                  lineHeight={t.lineHeight}
                  letterSpacing={t.letterSpacing}
                  textAlign={t.textAlign}
                  rtl={rtl}
                  paragraphSpacing={t.paragraphSpacing}
                  hyphenation={t.hyphenation}
                  language={book.language}
                  highlights={state.highlights}
                />
                <ChapterEndCard
                  theme={theme}
                  tr={tr}
                  titleFont={FONT_STACKS[t.fontFamily]}
                  nextTitle={book.chapters[currentChapter + 1]?.title ?? null}
                  nextNumber={currentChapter + 2}
                  total={chapterCount}
                  availability={nextChapterAvailability}
                  onNext={nextChapter}
                />
              </div>
            </div>
          )}
          {/* Dev-only, and off unless asked for: a blank reading pane has
              several possible causes that look identical in a screenshot, so
              this measures rather than guesses. Switch it on for a session
              with `localStorage["riwaq:dev:probe"] = "1"` and reload. Vite
              replaces import.meta.env.DEV with false in a release build,
              dropping it entirely. */}
          {import.meta.env.DEV && <ReaderLogMarker scrollRef={scrollRef} />}
          {import.meta.env.DEV && READER_PROBE && (
            <ReaderDiagnostics
              scrollRef={scrollRef}
              chapterIndex={currentChapter}
              chapterId={chapter.id}
              reactItemCount={chapter.paragraphs?.length ?? 0}
            />
          )}
        </div>
      </div>

      {/* Bottom scrubber spans the whole window, below BOTH the docked
          panel and the reading column — it reports progress through the
          book, which is not a property of either pane. Keeping it inside
          the reading column made it start at the panel's inner edge and
          left the panel running past it to the window floor. */}
      <div
        style={
          focus.floating
            ? focus.clip("bottom", focus.showBottom)
            : focus.pin("bottom")
        }
      >
        <div
          // The frosted fill and its hairline live here rather than on
          // ReaderProgressBar: that component is also used inside the panels
          // and the phone reader's bottom bar, where it is NOT the floating
          // surface. `backdrop-filter` has to sit on the element that carries
          // the fill, so the two travel together.
          className={glassBottom.className}
          style={{
            ...glassBottom.style,
            ...(focus.floating
              ? focus.slide("bottom", focus.showBottom)
              : null),
          }}
        >
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
          // No `onScrub`: a chapter change is a load, and firing one per
          // pointermove made the reader thrash through every chapter the finger
          // crossed. The handle previews; release commits the one jump.
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
          labelWidth={200}
          padding="6px 80px 14px"
        />
        </div>
      </div>

      {focus.hint > 0 && (
        <FocusHint
          key={focus.hint}
          theme={theme}
          title={tr("reader.focusMode")}
          body={tr("reader.focusHintBody")}
          isAr={dir === "rtl"}
        />
      )}
      {selAnchor && (
        <SelectionPopover
          theme={theme}
          anchor={selAnchor.rect}
          onPick={(color) => createFromSelection(color)}
          onAddNote={(color, note) => createFromSelection(color, note)}
          onDismiss={dismissSelection}
        />
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
