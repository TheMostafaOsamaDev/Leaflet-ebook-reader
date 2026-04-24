import { useCallback, useEffect, useState } from "react";
import { DesktopReader } from "./components/DesktopReader";
import { Library } from "./components/Library";
import { MobileReader } from "./components/MobileReader";
import type { EpubBook } from "./epub/types";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useTweaks } from "./hooks/useTweaks";
import {
  deleteBookmark,
  loadBook,
  saveBookmark,
  updateReadingPosition,
  type BookState,
} from "./store/library";
import { FONT_SERIF_DISPLAY, FONT_STACKS, THEMES } from "./styles/tokens";
import type { ActivePanel } from "./types/reader";

interface Loaded {
  book: EpubBook;
  state: BookState;
  currentChapter: number;
}

function App() {
  const [t, setTweak] = useTweaks();
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const isMobile = useMediaQuery("(max-width: 720px)");
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
      setLoaded({ book, state, currentChapter: state.currentChapter });
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
        return { ...prev, currentChapter: clamped };
      });
    },
    [],
  );

  const toggleBookmark = useCallback(async () => {
    if (!loaded) return;
    const { book, state, currentChapter } = loaded;
    const existing = state.bookmarks.find((b) => b.chapter === currentChapter);
    if (existing) {
      await deleteBookmark(book.id, existing.id);
      setLoaded({
        ...loaded,
        state: {
          ...state,
          bookmarks: state.bookmarks.filter((b) => b.id !== existing.id),
        },
      });
      return;
    }
    const excerpt =
      book.chapters[currentChapter]?.paragraphs[0]?.text.slice(0, 120) ??
      book.chapters[currentChapter]?.title ??
      "";
    const bm = await saveBookmark(book.id, {
      chapter: currentChapter,
      excerpt,
    });
    setLoaded({
      ...loaded,
      state: { ...state, bookmarks: [...state.bookmarks, bm] },
    });
  }, [loaded]);

  const removeBookmark = useCallback(
    async (bookmarkId: string) => {
      if (!loaded) return;
      await deleteBookmark(loaded.book.id, bookmarkId);
      setLoaded({
        ...loaded,
        state: {
          ...loaded.state,
          bookmarks: loaded.state.bookmarks.filter((b) => b.id !== bookmarkId),
        },
      });
    },
    [loaded],
  );

  const inReader = loaded !== null;

  return (
    <div
      dir={t.rtl && inReader ? "rtl" : "ltr"}
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
          onChapterChange={changeChapter}
          onToggleBookmark={toggleBookmark}
          onDeleteBookmark={removeBookmark}
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
          onChapterChange={changeChapter}
          onToggleBookmark={toggleBookmark}
          onDeleteBookmark={removeBookmark}
          activePanel={activePanel}
          setActivePanel={setActivePanel}
          onBack={closeBook}
        />
      )}
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
