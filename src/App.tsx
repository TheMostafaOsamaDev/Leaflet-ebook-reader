import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import { AnimatedSwap } from "./components/AnimatedSwap";
import { useLaunchIntent } from "./hooks/useLaunchIntent";
import { useIncomingFiles } from "./hooks/useIncomingFiles";
import { useFileDrop } from "./hooks/useFileDrop";
import { useDropOverlayState } from "./store/dropOverlay";
import { DesktopReader } from "./components/DesktopReader";
import { DropOverlay } from "./components/DropOverlay";
import { ImportProgress } from "./components/ImportProgress";
import { Library } from "./components/Library";
import { Lightbox } from "./components/Lightbox";
import { MobileReader } from "./components/MobileReader";
import { SourceStreamReader } from "./components/SourceStreamReader";
import { ReaderErrorBoundary } from "./components/ReaderErrorBoundary";
import { SettingsPage } from "./components/SettingsPage";
import { FixedPageReader } from "./reader/fixed/FixedPageReader";
import { createPdfPageSource } from "./reader/fixed/PdfPageSource";
import { createDocxPageSource } from "./reader/fixed/DocxPageSource";
import { startBackgroundTaskCoordinator } from "./store/backgroundTasks";
import { startDownloadNotifier } from "./store/downloadNotifier";
import {
  loadPersistedQueue,
  setDownloadConcurrency,
  setWifiOnlyDownloads,
} from "./store/downloadQueue";
import type { EpubBook } from "./epub/types";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useTweaks } from "./hooks/useTweaks";
import { useWakeLock } from "./hooks/useWakeLock";
import { close as closeLightbox, useLightbox } from "./store/lightbox";
import {
  useNav,
  goReader,
  goSettings,
  openOverlay,
  back,
  forward,
} from "./store/navigation";
import {
  deleteHighlights,
  getEntry,
  listBooks,
  loadBook,
  loadFixedBook,
  markBookOpened,
  saveHighlight,
  updateHighlightNote,
  updatePagePosition,
  updatePageProgress,
  updateParagraphPosition,
  updateReadingPosition,
  type BookState,
  type DocxHighlightAnchor,
  type FixedBook,
  type Highlight,
  type PdfHighlightAnchor,
} from "./store/library";
import { MOTION, setReduceMotionOverride, useReducedMotion } from "./styles/motion";
import { installScrollbarAutoHide } from "./styles/scrollbarAutoHide";
import type { HighlightColor } from "./styles/tokens";
import {
  FONT_READING_SANS,
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  THEMES,
  UI_FONT_ADJUST,
  UI_FONT_STACKS,
  resolveTheme,
} from "./styles/tokens";
import type { ActivePanel } from "./types/reader";
import { I18nProvider } from "./i18n/I18nProvider";
import { detectLocale, DIR_FOR, makeTr } from "./i18n";

interface Loaded {
  book: EpubBook;
  state: BookState;
  currentChapter: number;
  /**
   * Paragraph index to scroll to when the chapter mounts. Set from the
   * persisted BookState on initial open, then reset to 0 whenever the user
   * navigates between chapters (each new chapter starts at the top). The
   * reader reads this only on chapter change — live scroll position lives
   * in the reader's own ref.
   */
  resumeParagraph: number;
  /**
   * 0..1 sub-paragraph scroll offset to resume at, paired with
   * resumeParagraph. Set from the persisted BookState on open, reset to 0 on
   * chapter change / highlight jump (those land at a paragraph's top).
   */
  resumeOffset: number;
  /**
   * Bumped by every highlight-jump (or other targeted scroll) so the
   * reader's chapter-mount effect re-fires even when the jump target is
   * inside the chapter already on screen. Without this, tapping a
   * highlight in the current chapter is a no-op for the scroll effect
   * (deps unchanged).
   */
  jumpNonce: number;
}

/** State for an open fixed-layout (PDF/DOCX) book. Kept separate from `Loaded`
 *  (the reflowable path) so the EPUB reader's handlers stay untouched. */
interface LoadedFixed {
  book: FixedBook;
  state: BookState;
}

function App() {
  // Listen for Android launch-intent extras (e.g., notification taps
  // routing to the download queue). Has to live above the Library so
  // any emitted intents reach the Library's subscriber.
  useLaunchIntent();
  // Files handed to us from outside — Open with, the Android share sheet,
  // a drag-and-drop. Lives above the Library for the same reason
  // useLaunchIntent does: the Library subscribes, and it isn't always
  // mounted.
  useIncomingFiles();
  const [t, setTweak, applyTweaks] = useTweaks();
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadedFixed, setLoadedFixed] = useState<LoadedFixed | null>(null);
  const lightbox = useLightbox();

  // Navigation is the single source of truth for which destination is shown.
  // `base` drives App's top-level view swap (Library / Reader / Settings);
  // `overlay` layers the streaming reader (and, inside Library, the download
  // queue) on top without unmounting the base underneath.
  const nav = useNav();
  const base = nav.snapshot.base;
  const overlay = nav.snapshot.overlay;
  const streaming = overlay?.kind === "stream" ? overlay : null;

  // Streaming reader — opened from the Store when the user clicks "Read" on a
  // novel detail page. Rendered as an overlay so the Library (with the open
  // novel detail) stays mounted underneath; Back closes it and returns there.
  const openStream = useCallback(
    (sourceId: string, novelUrl: string, chapterId?: number) =>
      openOverlay({ kind: "stream", sourceId, novelUrl, chapterId }),
    [],
  );
  const closeStream = useCallback(() => back(), []);

  // Settings is a top-level base destination (peer of Library/Reader). Opening
  // it pushes a history entry; Back pops to whatever was showing before.
  const openSettings = useCallback(() => goSettings(), []);
  const closeSettings = useCallback(() => back(), []);

  // Phones in landscape exceed 720px wide but still need the mobile reader
  // (tap-to-toggle chrome, single-column layout). Treat any coarse-pointer
  // device with a short viewport as mobile too.
  const isMobile = useMediaQuery(
    "(max-width: 720px), (pointer: coarse) and (max-height: 480px)",
  );
  // Drag-and-drop is desktop-only: Android has no pointer drag onto the
  // window, and Tauri emits no drag events there. Gate on the actual OS via
  // plugin-os's platform() — NOT window width. `isMobile` is a media query
  // (narrow width OR coarse pointer + short viewport), so it breaks in both
  // directions here: a desktop user narrowing the window past 720px (normal
  // for side-by-side reading) would silently lose drag-and-drop, and a
  // large Android tablet in landscape reports isMobile === false, which
  // would subscribe the hook on a platform that never emits the events.
  //
  // platform() itself is synchronous (it reads a value the plugin stashes
  // at webview init, not an IPC round-trip) but throws outside a real Tauri
  // webview — e.g. `pnpm dev` in a plain browser — so it's wrapped the same
  // defensive way backgroundTasks.ts's isAndroid() and
  // downloadNotifier/transport.ts's getPlatform() are. Lazy useState
  // initializer: runs once, no need for an effect since there's nothing
  // async to wait on.
  const [dropCapable] = useState(() => {
    try {
      // Mirrors the Rust `desktop` cfg alias (not(any(android, ios))) —
      // ios has no gen/ scaffold yet, but the exclusion is cheap and keeps
      // this in lockstep with the backend's own definition of "desktop".
      const p = platform();
      return p !== "android" && p !== "ios";
    } catch {
      return false;
    }
  });
  useFileDrop(dropCapable);
  const dropState = useDropOverlayState();
  // "system" resolves to light/dark from the OS setting; useMediaQuery
  // re-renders when the user flips OS appearance, so the whole app
  // (and the theme-aware brand mark) re-themes live.
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const themePref = t.theme;
  const themeKey = resolveTheme(themePref, prefersDark);
  const theme = THEMES[themeKey];

  const uiLocale = detectLocale(
    t.uiLang,
    typeof navigator !== "undefined" ? navigator.language : "en",
  );
  const uiDir = DIR_FOR[uiLocale];
  // App owns the I18nProvider (below), so it's above that context and
  // can't call useI18n() itself — build the translator directly instead.
  const tr = useMemo(() => makeTr(uiLocale), [uiLocale]);

  useEffect(() => {
    document.documentElement.lang = uiLocale;
    document.documentElement.dir = uiDir;
  }, [uiLocale, uiDir]);

  useEffect(() => {
    document.body.style.background = theme.bg;
    document.body.style.color = theme.ink;
    // Publish the theme-aware values that CSS pseudo-elements need (they
    // can't read the inline `theme` object). global.css consumes these for
    // `::placeholder` and the scrollbar so every input/scroll area themes in
    // lock-step instead of relying on browser defaults (which render the
    // placeholder as a bright tint of `ink` in dark mode — like pre-filled
    // text — and leave a sepia-tinted scrollbar thumb on dark backgrounds).
    const root = document.documentElement.style;
    root.setProperty("--ph", theme.muted);
    root.setProperty("--sb-thumb", theme.ruleStrong);
    root.setProperty("--sb-thumb-hover", theme.muted);
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (meta) meta.content = theme.bg;
    // Match the Android status/navigation-bar icon contrast to the
    // in-app theme. Light themes (light, sepia) need dark icons; dark
    // themes (dark, oled) need light icons. The OS DayNight setting
    // would otherwise leave white icons on a light bar. No-op / silent
    // throw off Android — invoke just rejects and we ignore it.
    //
    // `background` is stashed natively and painted as the launch window on
    // the next cold start, so startup no longer shows a black frame in front
    // of the app while the webview boots.
    const darkIcons = themeKey === "light" || themeKey === "sepia";
    void invoke("set_status_bar_style", {
      darkIcons,
      background: theme.bg,
    }).catch(() => {});
  }, [theme.bg, theme.ink, theme.muted, theme.ruleStrong, themeKey]);

  // Overlay-scrollbar behaviour for every scroll area in the app: the thumb
  // paints while scrolling and fades once it stops. One delegated listener,
  // installed once — see styles/scrollbarAutoHide.ts.
  useEffect(() => installScrollbarAutoHide(), []);

  // Apply the selectable UI (chrome) font through a CSS variable that
  // FONT_STACKS.sans falls back through. Set on documentElement so any
  // portalled overlays inherit it too. Unset → defaults to Readex Pro.
  useEffect(() => {
    // Fallback guards a corrupt/unknown uiFont (e.g. from imported settings):
    // an undefined lookup would set the var to the string "undefined" and break
    // the entire chrome font.
    document.documentElement.style.setProperty(
      "--ui-font",
      UI_FONT_STACKS[t.uiFont] ?? FONT_READING_SANS,
    );
    // Per-font glyph-size normalization: keeps each UI font's apparent size
    // consistent WITHOUT changing the layout (font-size-adjust only scales
    // glyph rendering). Book content opts out (font-size-adjust:none).
    document.documentElement.style.setProperty(
      "--ui-font-adjust",
      String(UI_FONT_ADJUST[t.uiFont] ?? 0.525),
    );
  }, [t.uiFont]);

  // App-level reduce-motion override ("auto" = follow the OS). Composes on
  // top of the OS preference inside useReducedMotion via a tiny pub-sub, so
  // every call site (AnimatedSwap, panels, readers) picks it up.
  useEffect(() => {
    setReduceMotionOverride(t.reduceMotion);
  }, [t.reduceMotion]);

  // Desktop back/forward, routed through nav history. Alt+←/→ and (on macOS)
  // ⌘[ / ⌘] mirror the browser convention (Alt+Left = back in every locale,
  // independent of text direction). Mouse side-buttons are left to the
  // webview, which emits `popstate` — already handled by the nav store.
  // preventDefault stops any native key mapping so each press navigates once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isBack =
        (e.altKey && e.key === "ArrowLeft") || (e.metaKey && e.key === "[");
      const isForward =
        (e.altKey && e.key === "ArrowRight") || (e.metaKey && e.key === "]");
      if (isBack) {
        e.preventDefault();
        back();
      } else if (isForward) {
        e.preventDefault();
        forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Push download-queue runtime config from the tweaks.
  useEffect(() => {
    setDownloadConcurrency(t.maxConcurrentDownloads);
  }, [t.maxConcurrentDownloads]);
  useEffect(() => {
    setWifiOnlyDownloads(t.wifiOnlyDownloads);
  }, [t.wifiOnlyDownloads]);

  // Bridge the download queue to the system notification tray.
  // Idempotent — subsequent calls are no-ops, so React 18 dev
  // re-mount doesn't double-subscribe.
  useEffect(() => {
    // Restore any jobs that were in flight when the app last died.
    // The function is idempotent. Order matters: load BEFORE the
    // notifier subscribes so the initial emit (which marks
    // interrupted jobs) doesn't trigger a notification flurry on
    // launch.
    (async () => {
      await loadPersistedQueue();
      startDownloadNotifier();
      startBackgroundTaskCoordinator();
    })();
  }, []);

  const reduced = useReducedMotion();
  // Hold a screen wake lock while actively reading (a book is open or a
  // stream is playing) and the user enabled it. Best-effort; no-ops where
  // the Wake Lock API is unavailable.
  useWakeLock(t.keepScreenAwake && (loaded !== null || streaming !== null));
  // Holds the deferred setLoading(false) so a rapid re-open of a different
  // book can clear it before it fires for the previous load.
  const loadingTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (loadingTimeoutRef.current !== null) {
        window.clearTimeout(loadingTimeoutRef.current);
      }
    };
  }, []);

  const openBook = useCallback(
    async (id: string) => {
      if (loadingTimeoutRef.current !== null) {
        window.clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = null;
      }
      setLoading(true);
      setError(null);
      try {
        // Route fixed-layout books (PDF/DOCX) to their own reader; everything
        // else stays on the reflowable EPUB path. Stamp `lastReadAt` on open so
        // the Library's "Continue reading" hero picks the just-opened book.
        const entry = await getEntry(id);
        await markBookOpened(id);
        if (entry && (entry.kind === "pdf" || entry.kind === "docx")) {
          const { book, state } = await loadFixedBook(id);
          setLoaded(null);
          setLoadedFixed({ book, state });
        } else {
          const { book, state } = await loadBook(id);
          setLoadedFixed(null);
          setLoaded({
            book,
            state,
            currentChapter: state.currentChapter,
            resumeParagraph: state.paragraphIndex,
            resumeOffset: state.paragraphOffset ?? 0,
            jumpNonce: 0,
          });
        }
        setActivePanel(null);
        // Data is ready — now flip the base to the reader so the crossfade
        // lands on a fully-loaded view (no blank frame). A no-op push when
        // we're already on this reader entry (the restore path below).
        goReader(id);
        // Keep the spinner up over the AnimatedSwap crossfade so the
        // user doesn't catch the Library through the reader's fade-in.
        // The delay matches the .riwaq-view-enter keyframe (MOTION.med
        // = 240ms); reduced-motion users get the swap instantly, so
        // there's nothing to wait for.
        if (reduced) {
          setLoading(false);
        } else {
          loadingTimeoutRef.current = window.setTimeout(() => {
            loadingTimeoutRef.current = null;
            setLoading(false);
          }, MOTION.med);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    },
    [reduced],
  );

  // Reader data is keyed to the nav location. The common path (openBook) loads
  // first, then navigates — so this effect no-ops there. It's the safety net
  // for the other direction: landing on a reader entry WITHOUT its data (a
  // browser-forward back into a book, or a dev reload) loads it; leaving the
  // reader drops the data so a later re-open starts fresh.
  const readerBookId = base.screen === "reader" ? base.bookId : null;
  useEffect(() => {
    if (readerBookId == null) {
      setLoaded(null);
      setLoadedFixed(null);
      setActivePanel(null);
      setError(null);
      return;
    }
    if (
      loaded?.book.id === readerBookId ||
      loadedFixed?.book.id === readerBookId
    )
      return;
    void openBook(readerBookId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerBookId]);

  // First-run startup routing. When "Resume last book" is chosen, open the
  // most-recently-read local book once on mount (listBooks is sorted newest
  // first). Guarded so React's dev double-invoke doesn't fire it twice.
  const didStartupRef = useRef(false);
  useEffect(() => {
    if (didStartupRef.current) return;
    didStartupRef.current = true;
    if (t.startupView !== "resume") return;
    // No cancellation guard: didStartupRef already dedupes, and the App root
    // never unmounts mid-startup. A `cancelled` flag here would be flipped by
    // StrictMode's dev cleanup and suppress the one legitimate run.
    void (async () => {
      try {
        const books = await listBooks();
        const newest = books.find((b) => b.kind !== "source");
        if (newest) void openBook(newest.id);
      } catch {
        // ignore — fall back to the Library
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back out of the reader by popping history — returns to wherever the book
  // was opened from (shelf, search, a novel detail…). The reader-location
  // effect above clears the loaded book once the base leaves the reader.
  const closeBook = useCallback(() => back(), []);

  const changeChapter = useCallback(
    (order: number) => {
      setLoaded((prev) => {
        if (!prev) return prev;
        const clamped = Math.max(
          0,
          Math.min(prev.book.chapters.length - 1, order),
        );
        void updateReadingPosition(
          prev.book.id,
          clamped,
          prev.book.chapters.length,
        );
        // New chapter starts at the top — clear any pending paragraph save
        // and reset the resume hint so the reader scrolls to paragraph 0.
        if (paragraphSaveTimer.current) {
          clearTimeout(paragraphSaveTimer.current);
          paragraphSaveTimer.current = null;
        }
        return {
          ...prev,
          currentChapter: clamped,
          resumeParagraph: 0,
          resumeOffset: 0,
        };
      });
    },
    [],
  );

  // Debounce paragraph saves so we don't hammer disk on every scroll event.
  const paragraphSaveTimer = useRef<number | null>(null);
  const onParagraphChange = useCallback((idx: number, offset?: number) => {
    if (paragraphSaveTimer.current)
      clearTimeout(paragraphSaveTimer.current);
    paragraphSaveTimer.current = window.setTimeout(() => {
      paragraphSaveTimer.current = null;
      setLoaded((prev) => {
        if (!prev) return prev;
        const off = offset ?? 0;
        if (
          prev.state.paragraphIndex === idx &&
          (prev.state.paragraphOffset ?? 0) === off
        )
          return prev;
        void updateParagraphPosition(prev.book.id, idx, off);
        return {
          ...prev,
          state: { ...prev.state, paragraphIndex: idx, paragraphOffset: off },
        };
      });
    }, 600);
  }, []);

  useEffect(() => {
    return () => {
      if (paragraphSaveTimer.current)
        clearTimeout(paragraphSaveTimer.current);
    };
  }, []);

  // Debounced persistence of fixed-page (PDF/DOCX) reading position + progress.
  const pageSaveTimer = useRef<number | null>(null);
  const savePagePosition = useCallback(
    (bookId: string, pageCount: number, page: number, pageOffset: number) => {
      if (pageSaveTimer.current) clearTimeout(pageSaveTimer.current);
      pageSaveTimer.current = window.setTimeout(() => {
        pageSaveTimer.current = null;
        void updatePagePosition(bookId, page, pageOffset);
        void updatePageProgress(bookId, page, pageCount);
      }, 600);
    },
    [],
  );
  useEffect(() => {
    return () => {
      if (pageSaveTimer.current) clearTimeout(pageSaveTimer.current);
    };
  }, []);

  const createHighlight = useCallback(
    async (input: {
      chapter: number;
      paragraphIndex: number;
      charStart: number;
      charEnd: number;
      text: string;
      color: HighlightColor;
      note?: string;
      groupId?: string;
    }) => {
      if (!loaded) return;
      const saved = await saveHighlight(loaded.book.id, input);
      setLoaded((prev) =>
        prev
          ? {
              ...prev,
              state: {
                ...prev.state,
                highlights: [...prev.state.highlights, saved],
              },
            }
          : prev,
      );
    },
    [loaded],
  );

  const removeHighlight = useCallback(
    async (highlightId: string) => {
      if (!loaded) return;
      // If the highlight is part of a multi-paragraph group, delete
      // every member of the group so the user-visible "one selection
      // = one highlight" mental model holds.
      const target = loaded.state.highlights.find((h) => h.id === highlightId);
      if (!target) return;
      const ids = target.groupId
        ? loaded.state.highlights
            .filter((h) => h.groupId === target.groupId)
            .map((h) => h.id)
        : [highlightId];
      await deleteHighlights(loaded.book.id, ids);
      const idSet = new Set(ids);
      setLoaded((prev) =>
        prev
          ? {
              ...prev,
              state: {
                ...prev.state,
                highlights: prev.state.highlights.filter(
                  (h) => !idSet.has(h.id),
                ),
              },
            }
          : prev,
      );
    },
    [loaded],
  );

  // Fixed-layout (PDF/DOCX) highlight handlers. The EPUB handlers above operate
  // on `loaded`, which is null for a fixed book — these mirror them against
  // `loadedFixed`. Fixed highlights carry a `fixed` anchor and leave the reflow
  // fields (chapter/paragraph/char) at 0.
  const createFixedHighlight = useCallback(
    async (h: {
      text: string;
      color: HighlightColor;
      note?: string;
      groupId?: string;
      fixed: DocxHighlightAnchor | PdfHighlightAnchor;
    }) => {
      if (!loadedFixed) return;
      const saved = await saveHighlight(loadedFixed.book.id, {
        chapter: 0,
        paragraphIndex: 0,
        charStart: 0,
        charEnd: 0,
        text: h.text,
        color: h.color,
        note: h.note,
        groupId: h.groupId,
        fixed: h.fixed,
      });
      setLoadedFixed((prev) =>
        prev
          ? {
              ...prev,
              state: {
                ...prev.state,
                highlights: [...prev.state.highlights, saved],
              },
            }
          : prev,
      );
    },
    [loadedFixed],
  );

  const removeFixedHighlight = useCallback(
    async (highlightId: string) => {
      if (!loadedFixed) return;
      const target = loadedFixed.state.highlights.find((h) => h.id === highlightId);
      if (!target) return;
      const ids = target.groupId
        ? loadedFixed.state.highlights
            .filter((h) => h.groupId === target.groupId)
            .map((h) => h.id)
        : [highlightId];
      await deleteHighlights(loadedFixed.book.id, ids);
      const idSet = new Set(ids);
      setLoadedFixed((prev) =>
        prev
          ? {
              ...prev,
              state: {
                ...prev.state,
                highlights: prev.state.highlights.filter((h) => !idSet.has(h.id)),
              },
            }
          : prev,
      );
    },
    [loadedFixed],
  );

  const editFixedHighlightNote = useCallback(
    async (highlightId: string, note: string) => {
      if (!loadedFixed) return;
      const trimmed = note.trim();
      await updateHighlightNote(loadedFixed.book.id, highlightId, trimmed);
      setLoadedFixed((prev) =>
        prev
          ? {
              ...prev,
              state: {
                ...prev.state,
                highlights: prev.state.highlights.map((h) =>
                  h.id === highlightId
                    ? { ...h, note: trimmed.length > 0 ? trimmed : undefined }
                    : h,
                ),
              },
            }
          : prev,
      );
    },
    [loadedFixed],
  );

  const editHighlightNote = useCallback(
    async (highlightId: string, note: string) => {
      if (!loaded) return;
      const trimmed = note.trim();
      await updateHighlightNote(loaded.book.id, highlightId, trimmed);
      setLoaded((prev) =>
        prev
          ? {
              ...prev,
              state: {
                ...prev.state,
                highlights: prev.state.highlights.map((h) =>
                  h.id === highlightId
                    ? { ...h, note: trimmed.length > 0 ? trimmed : undefined }
                    : h,
                ),
              },
            }
          : prev,
      );
    },
    [loaded],
  );

  // Jump from the sidebar to a highlight's exact spot. Reuses the
  // existing chapter-mount scroll-to-paragraph effect by setting the
  // resumeParagraph alongside the chapter switch.
  const jumpToHighlight = useCallback(
    (h: Highlight) => {
      if (!loaded) return;
      void updateReadingPosition(
        loaded.book.id,
        h.chapter,
        loaded.book.chapters.length,
      );
      if (paragraphSaveTimer.current) {
        clearTimeout(paragraphSaveTimer.current);
        paragraphSaveTimer.current = null;
      }
      setLoaded((prev) =>
        prev
          ? {
              ...prev,
              currentChapter: h.chapter,
              resumeParagraph: h.paragraphIndex,
              // A highlight jump lands at the paragraph's top, not a stale
              // mid-paragraph offset from wherever the reader last was.
              resumeOffset: 0,
              // Bump even if chapter + paragraph are identical to what
              // they were last jump — guarantees the reader's scroll
              // effect re-runs and lands on the highlight.
              jumpNonce: prev.jumpNonce + 1,
            }
          : prev,
      );
    },
    [loaded],
  );

  return (
    <I18nProvider locale={uiLocale}>
      <div
        // Shell direction follows the UI language. BookBody sets its own dir,
        // so book content stays independent of the chrome.
        dir={uiDir}
        style={{
          width: "100%",
          height: "100%",
          background: theme.bg,
          color: theme.ink,
          overflow: "hidden",
        }}
      >
        {loading && <FullPageSpinner theme={theme} label={tr("app.loadingBook")} />}
        {error && !loading && (
          <div
            style={{
              position: "absolute",
              top: 20,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 50,
              padding: "10px 16px",
              background: "rgba(180,60,60,0.12)",
              border: "0.5px solid rgba(180,60,60,0.4)",
              borderRadius: 8,
              fontSize: 12,
              color: theme.ink,
              fontFamily: FONT_STACKS.sans,
            }}
          >
            {error}
          </div>
        )}
        {/* Stream reader overlay. AnimatedSwap's slots are position:absolute
            with no z-index, so without this wrapper the next AnimatedSwap
            (Library/Reader) sits on top in document order and hides the
            streaming layer for the duration of its fade-in. The wrapper's
            z-index keeps the streaming layer above the Library throughout
            the animation; pointer-events flips off when no stream is active
            so the empty slot doesn't swallow clicks meant for the Library. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 30,
            pointerEvents: streaming ? "auto" : "none",
          }}
        >
          <AnimatedSwap viewKey={streaming ? "stream" : "none"}>
            {streaming ? (
              <ReaderErrorBoundary theme={theme} onBack={closeStream}>
              <SourceStreamReader
                theme={theme}
                themeKey={themeKey}
                t={t}
                setTweak={setTweak}
                layout={isMobile ? "mobile" : "desktop"}
                sourceId={streaming.sourceId}
                novelUrl={streaming.novelUrl}
                startChapterId={streaming.chapterId}
                onClose={closeStream}
              />
              </ReaderErrorBoundary>
            ) : null}
          </AnimatedSwap>
        </div>
        {/* Library ↔ Reader transition. viewKey is derived from the open
            book + layout so a layout change (e.g., rotating into landscape
            on mobile-landscape) ALSO crossfades cleanly. */}
        <AnimatedSwap
          viewKey={
            base.screen === "settings"
              ? "settings"
              : base.screen === "reader"
                ? isMobile
                  ? "reader-mobile"
                  : "reader-desktop"
                : "library"
          }
        >
          {base.screen === "settings" ? (
            <SettingsPage
              theme={theme}
              themeKey={themeKey}
              t={t}
              setTweak={setTweak}
              applyTweaks={applyTweaks}
              layout={isMobile ? "mobile" : "desktop"}
              onClose={closeSettings}
            />
          ) : base.screen === "library" ? (
            <Library
              theme={theme}
              themeKey={themeKey}
              layout={isMobile ? "mobile" : "desktop"}
              view={base.view}
              onOpen={openBook}
              onStreamRead={openStream}
              streamActive={streaming !== null}
              onOpenSettings={openSettings}
              confirmDelete={t.confirmDelete}
            />
          ) : loadedFixed && loadedFixed.book.id === base.bookId ? (
            <FixedPageReader
              theme={theme}
              themeKey={themeKey}
              t={t}
              setTweak={setTweak}
              book={loadedFixed.book}
              state={loadedFixed.state}
              highlights={loadedFixed.state.highlights}
              onCreateHighlight={createFixedHighlight}
              onDeleteHighlight={removeFixedHighlight}
              onUpdateHighlightNote={editFixedHighlightNote}
              layout={isMobile ? "mobile" : "desktop"}
              uiDir={uiDir}
              createSource={() => {
                const b = loadedFixed.book;
                return b.kind === "pdf"
                  ? createPdfPageSource(b)
                  : createDocxPageSource(b);
              }}
              onLocationChange={(page, off, pageCount) =>
                savePagePosition(loadedFixed.book.id, pageCount, page, off)
              }
              onOpenFullSettings={openSettings}
              onBack={closeBook}
            />
          ) : loaded && loaded.book.id === base.bookId ? (
            <ReaderErrorBoundary theme={theme} onBack={closeBook}>
            {isMobile ? (
              <MobileReader
                theme={theme}
                themeKey={themeKey}
                t={t}
                setTweak={setTweak}
                book={loaded.book}
                state={loaded.state}
                currentChapter={loaded.currentChapter}
                resumeParagraph={loaded.resumeParagraph}
                resumeOffset={loaded.resumeOffset}
                jumpNonce={loaded.jumpNonce}
                onChapterChange={changeChapter}
                onParagraphChange={onParagraphChange}
                onCreateHighlight={createHighlight}
                onDeleteHighlight={removeHighlight}
                onUpdateHighlightNote={editHighlightNote}
                onJumpToHighlight={jumpToHighlight}
                nextChapterAvailability="device"
                onOpenFullSettings={openSettings}
                onBack={closeBook}
              />
            ) : (
              <DesktopReader
                theme={theme}
                themeKey={themeKey}
                t={t}
                setTweak={setTweak}
                book={loaded.book}
                state={loaded.state}
                currentChapter={loaded.currentChapter}
                resumeParagraph={loaded.resumeParagraph}
                resumeOffset={loaded.resumeOffset}
                jumpNonce={loaded.jumpNonce}
                onChapterChange={changeChapter}
                onParagraphChange={onParagraphChange}
                onCreateHighlight={createHighlight}
                onDeleteHighlight={removeHighlight}
                onUpdateHighlightNote={editHighlightNote}
                onJumpToHighlight={jumpToHighlight}
                nextChapterAvailability="device"
                activePanel={activePanel}
                setActivePanel={setActivePanel}
                onOpenFullSettings={openSettings}
                onBack={closeBook}
              />
            )}
            </ReaderErrorBoundary>
          ) : (
            // base is reader but its data isn't loaded yet (browser-forward
            // into a book / dev reload) — the reader-location effect is
            // loading it; the full-page spinner covers this blank frame.
            null
          )}
        </AnimatedSwap>
        {/* Mounted at the app root so a docx import keeps showing across the
            Library → Reader transition (e.g. user clicks "Continue in
            background" then opens an existing book while the import finishes). */}
        <ImportProgress theme={theme} />
        {/* Image lightbox — opens when a chapter image is tapped, anywhere. */}
        <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={closeLightbox} />
        {/* Drag-and-drop overlay — last, so it layers above the reader, the
            library, and any open dialog while a drag is in progress. */}
        <DropOverlay state={dropState} theme={theme} />
      </div>
    </I18nProvider>
  );
}

function FullPageSpinner({
  theme,
  label,
}: {
  theme: { bg: string; ink: string; muted: string };
  label: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT_SERIF_DISPLAY,
        fontSize: 20,
        zIndex: 40,
      }}
    >
      {label}
    </div>
  );
}

export default App;
