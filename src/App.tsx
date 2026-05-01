import { useCallback, useEffect, useRef, useState } from "react";
import { DesktopReader } from "./components/DesktopReader";
import { ImportProgress } from "./components/ImportProgress";
import { Library } from "./components/Library";
import { MobileReader } from "./components/MobileReader";
import type { EpubBook } from "./epub/types";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useTweaks } from "./hooks/useTweaks";
import {
  deleteHighlight,
  loadBook,
  saveHighlight,
  updateHighlightNote,
  updateParagraphPosition,
  updateReadingPosition,
  type BookState,
  type Highlight,
} from "./store/library";
import type { HighlightColor } from "./styles/tokens";
import { FONT_SERIF_DISPLAY, FONT_STACKS, THEMES } from "./styles/tokens";
import type { ActivePanel } from "./types/reader";

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
}

function App() {
  const [t, setTweak] = useTweaks();
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // Phones in landscape exceed 720px wide but still need the mobile reader
  // (tap-to-toggle chrome, single-column layout). Treat any coarse-pointer
  // device with a short viewport as mobile too.
  const isMobile = useMediaQuery(
    "(max-width: 720px), (pointer: coarse) and (max-height: 480px)",
  );
  const themeKey = t.theme;
  const theme = THEMES[themeKey];

  useEffect(() => {
    document.body.style.background = theme.bg;
    document.body.style.color = theme.ink;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (meta) meta.content = theme.bg;
  }, [theme.bg, theme.ink]);

  const openBook = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const { book, state } = await loadBook(id);
      setLoaded({
        book,
        state,
        currentChapter: state.currentChapter,
        resumeParagraph: state.paragraphIndex,
      });
      setActivePanel(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const closeBook = useCallback(() => {
    setLoaded(null);
    setActivePanel(null);
    setError(null);
  }, []);

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
        return { ...prev, currentChapter: clamped, resumeParagraph: 0 };
      });
    },
    [],
  );

  // Debounce paragraph saves so we don't hammer disk on every scroll event.
  const paragraphSaveTimer = useRef<number | null>(null);
  const onParagraphChange = useCallback((idx: number) => {
    if (paragraphSaveTimer.current)
      clearTimeout(paragraphSaveTimer.current);
    paragraphSaveTimer.current = window.setTimeout(() => {
      paragraphSaveTimer.current = null;
      setLoaded((prev) => {
        if (!prev) return prev;
        if (prev.state.paragraphIndex === idx) return prev;
        void updateParagraphPosition(prev.book.id, idx);
        return { ...prev, state: { ...prev.state, paragraphIndex: idx } };
      });
    }, 600);
  }, []);

  useEffect(() => {
    return () => {
      if (paragraphSaveTimer.current)
        clearTimeout(paragraphSaveTimer.current);
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
      await deleteHighlight(loaded.book.id, highlightId);
      setLoaded((prev) =>
        prev
          ? {
              ...prev,
              state: {
                ...prev.state,
                highlights: prev.state.highlights.filter(
                  (h) => h.id !== highlightId,
                ),
              },
            }
          : prev,
      );
    },
    [loaded],
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
            }
          : prev,
      );
    },
    [loaded],
  );

  const inReader = loaded !== null;

  return (
    <div
      // Keep the app shell LTR — BookBody sets its own `dir` so the book
      // content flips to RTL while the surrounding reader UI (settings
      // panel, TOC, header, buttons) stays in its natural left-to-right
      // orientation.
      dir="ltr"
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        overflow: "hidden",
      }}
    >
      {loading && <FullPageSpinner theme={theme} label="Loading book…" />}
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
      {!inReader ? (
        <Library
          theme={theme}
          layout={isMobile ? "mobile" : "desktop"}
          onOpen={openBook}
        />
      ) : isMobile ? (
        <MobileReader
          theme={theme}
          themeKey={themeKey}
          t={t}
          setTweak={setTweak}
          book={loaded!.book}
          state={loaded!.state}
          currentChapter={loaded!.currentChapter}
          resumeParagraph={loaded!.resumeParagraph}
          onChapterChange={changeChapter}
          onParagraphChange={onParagraphChange}
          onCreateHighlight={createHighlight}
          onDeleteHighlight={removeHighlight}
          onUpdateHighlightNote={editHighlightNote}
          onJumpToHighlight={jumpToHighlight}
          onBack={closeBook}
        />
      ) : (
        <DesktopReader
          theme={theme}
          themeKey={themeKey}
          t={t}
          setTweak={setTweak}
          book={loaded!.book}
          state={loaded!.state}
          currentChapter={loaded!.currentChapter}
          resumeParagraph={loaded!.resumeParagraph}
          onChapterChange={changeChapter}
          onParagraphChange={onParagraphChange}
          onCreateHighlight={createHighlight}
          onDeleteHighlight={removeHighlight}
          onUpdateHighlightNote={editHighlightNote}
          onJumpToHighlight={jumpToHighlight}
          activePanel={activePanel}
          setActivePanel={setActivePanel}
          onBack={closeBook}
        />
      )}
      {/* Mounted at the app root so a docx import keeps showing across the
          Library → Reader transition (e.g. user clicks "Continue in
          background" then opens an existing book while the import finishes). */}
      <ImportProgress theme={theme} />
    </div>
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
        fontStyle: "italic",
        fontSize: 20,
        zIndex: 40,
      }}
    >
      {label}
    </div>
  );
}

export default App;
