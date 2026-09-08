// Dev-only rig for the PHONE reader's chrome (MobileReader).
//
// Mounts the real MobileReader over a synthetic Arabic book so the frosted top
// and bottom bars can be seen and measured without Tauri or the emulator —
// which is what the reader's chrome actually needs checked, since the whole
// point of the glass is how it composites over body text.
//
// `?theme=light|sepia|dark|oled` picks the theme, so a screenshot loop can
// sweep all four without touching localStorage. `?safe=<px>` fakes an Android
// status-bar inset, since a desktop browser reports `env(safe-area-inset-top)`
// as 0 and the top bar's notch padding would otherwise never be exercised.
//
// Nothing here is imported by the app. Open it at /mobile-harness.html.

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MobileReader } from "../components/MobileReader";
import { I18nProvider } from "../i18n/I18nProvider";
import { DEFAULT_TWEAKS } from "../hooks/useTweaks";
import { THEMES, type ThemeKey } from "../styles/tokens";
import type { EpubBook } from "../epub/types";
import type { BookState } from "../store/library";
import type { Tweaks } from "../types/reader";
import "../styles/global.css";

// Arabic body text, so the glass is judged over the script it will actually
// sit on — Latin at the same size covers far fewer pixels per line, which
// flatters the blur.
const PARA =
  "التقط فانغ يوان الثوب الأسود والجوارب التي غيّرها ، ألم أقل ذلك من قبل ، " +
  "سنذهب إلى جبل باي غو الآن. أما بالنسبة إلى غو اليانغ ، فانتظر على الأقل " +
  "حتى أكون في الرتبة الثالثة أولاً.";

function makeBook(): EpubBook {
  return {
    id: "mobile-harness-book",
    title: "القس المجنون",
    author: "مؤلف",
    language: "ar",
    chapters: Array.from({ length: 2372 }, (_, i) => ({
      id: `ch-${i}`,
      href: `ch-${i}.xhtml`,
      title: `الفصل ${i + 1}`,
      order: i,
      paragraphs: Array.from({ length: 40 }, () => ({
        kind: "text" as const,
        text: PARA,
      })),
    })),
  };
}

const params = new URLSearchParams(location.search);
const themeKey = (params.get("theme") ?? "dark") as ThemeKey;
const safeTop = Number(params.get("safe") ?? 0);

function Harness() {
  const [book] = useState(makeBook);
  const [t, setT] = useState<Tweaks>({ ...DEFAULT_TWEAKS, theme: themeKey });
  const [chapter, setChapter] = useState(238);

  const state: BookState = {
    bookId: book.id,
    currentChapter: chapter,
    paragraphIndex: 0,
    highlights: [],
  };

  return (
    <MobileReader
      theme={THEMES[themeKey] ?? THEMES.dark}
      themeKey={themeKey}
      t={t}
      setTweak={(k, v) => setT((prev) => ({ ...prev, [k]: v }))}
      book={book}
      state={state}
      currentChapter={chapter}
      resumeParagraph={0}
      jumpNonce={0}
      onChapterChange={setChapter}
      onParagraphChange={() => {}}
      onCreateHighlight={() => {}}
      onDeleteHighlight={() => {}}
      onUpdateHighlightNote={() => {}}
      onJumpToHighlight={() => {}}
      onBack={() => {}}
    />
  );
}

// Fake the Android status-bar inset. `env()` cannot be assigned, so the rig
// pads the mount instead and paints the strip like a system bar — enough to
// show whether the top bar's own inset padding clears it.
const root = document.getElementById("root")!;
if (safeTop > 0) {
  root.style.paddingTop = `${safeTop}px`;
  root.style.boxSizing = "border-box";
  document.body.style.background = "#000";
}

createRoot(root).render(
  <I18nProvider locale="ar">
    <Harness />
  </I18nProvider>,
);
