// Dev-only rig for the DOCKED Contents panel.
//
// Mounts the real DesktopReader over a synthetic book so the docking layout
// can be seen and measured without a Tauri backend — the app's own library and
// import paths need `invoke`, and driving the installed desktop app would
// rewrite the real library.
//
// What it is here to show: Contents claims a real 340px strip beside the
// reading column rather than floating over it, the column keeps its place in
// the book across the reflow that causes, and the panel stays open while you
// move between chapters.
//
// Nothing here is imported by the app. Open it with `pnpm dev` at
// /dock-harness.html.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopReader } from "../components/DesktopReader";
import { I18nProvider } from "../i18n/I18nProvider";
import { DEFAULT_TWEAKS } from "../hooks/useTweaks";
import { THEMES } from "../styles/tokens";
import type { EpubBook } from "../epub/types";
import type { BookState, Highlight } from "../store/library";
import type { ActivePanel, Tweaks } from "../types/reader";
import "../styles/global.css";

const LOREM =
  "The corridor smelled of rain and old paper. She counted the doors as she " +
  "passed them, the way she had as a child, and found that the number had " +
  "changed again. Nothing in the building stayed where it was put for long.";

function makeBook(chapters: number): EpubBook {
  return {
    id: "harness-book",
    title: "The Sunken City",
    author: "A. Novelist",
    language: "en",
    chapters: Array.from({ length: chapters }, (_, i) => ({
      id: `ch-${i}`,
      href: `ch-${i}.xhtml`,
      title:
        i % 7 === 0
          ? `${i + 1}. The Long Road Out of the Sunken City`
          : `Chapter ${i + 1}`,
      order: i,
      paragraphs: Array.from({ length: 24 }, (_, p) => ({
        kind: "text" as const,
        text: `${p + 1}. ${LOREM}`,
      })),
    })),
  };
}

function Harness() {
  const [chapterCount] = useState(2000);
  const [book] = useState(() => makeBook(chapterCount));
  const [t, setT] = useState<Tweaks>(DEFAULT_TWEAKS);
  const [chapter, setChapter] = useState(0);
  const [panel, setPanel] = useState<ActivePanel>(null);

  // Highlights are live here, not stubbed out. The docking layout is
  // what this rig is for, but the paginated reader is also the only
  // place the note bars can be seen doing their job — BookBody inside
  // PaginatedView's CSS columns, where "the margin" is a column gap
  // rather than the page edge. See components/NoteSpines.
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  const state: BookState = {
    bookId: book.id,
    currentChapter: chapter,
    paragraphIndex: 0,
    highlights,
  };

  return (
    <DesktopReader
      theme={THEMES[t.theme === "system" ? "sepia" : t.theme] ?? THEMES.sepia}
      themeKey={t.theme === "system" ? "sepia" : t.theme}
      t={t}
      setTweak={(k, v) => setT((prev) => ({ ...prev, [k]: v }))}
      book={book}
      state={state}
      currentChapter={chapter}
      resumeParagraph={0}
      jumpNonce={0}
      onChapterChange={setChapter}
      onParagraphChange={() => {}}
      onCreateHighlight={(h) =>
        setHighlights((prev) => [
          ...prev,
          { ...h, id: crypto.randomUUID(), ts: Date.now() },
        ])
      }
      onDeleteHighlight={(id) =>
        setHighlights((prev) => prev.filter((h) => h.id !== id))
      }
      onUpdateHighlightNote={(id, note) =>
        setHighlights((prev) =>
          prev.map((h) =>
            h.id === id ? { ...h, note: note.trim() || undefined } : h,
          ),
        )
      }
      onJumpToHighlight={() => {}}
      activePanel={panel}
      setActivePanel={setPanel}
      onBack={() => {}}
    />
  );
}

// ?locale=ar to check that the docked strip lands on the leading edge under an
// RTL interface — the reader chrome is direction-pinned, so this is not
// something to assume.
const locale = new URLSearchParams(location.search).get("locale") === "ar" ? "ar" : "en";

createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={locale}>
    <Harness />
  </I18nProvider>,
);
