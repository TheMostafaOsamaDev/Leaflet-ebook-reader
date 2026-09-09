// Dev-only rig for what the reader SHOWS while a streamed chapter is still
// loading, and for where it lands when the chapter turns.
//
// Why it exists: after the wheel fix landed, two position bugs surfaced in the
// real app that no existing rig could reproduce — a chapter turn sometimes
// lands on a blank page, and sometimes lands at the BOTTOM of the chapter
// instead of its top. Both only happen for `kind: "source"` books, whose
// chapters arrive over the network, and the existing harnesses all mount books
// whose content is present from the first render.
//
// So this rig copies SourceStreamReader's actual model: every chapter starts
// as `paragraphs: []`, content is spliced in later behind a configurable
// delay, the splice bumps the chapter id (which re-keys BookBody), and only
// currentChapter+1 is prefetched — never the chapter behind you. The overlay
// reports what the reader is actually showing, since "blank" is a claim about
// scroll position and node count, not something to eyeball.
//
// `?delay=<ms>` sets the fetch delay, `?start=<n>` the chapter to open on
// (needed to reach an uncached chapter by scrolling BACK), `?theme=` the theme.
//
// Nothing here is imported by the app. Open it at /stream-harness.html.

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopReader } from "../components/DesktopReader";
import { ReaderErrorBoundary } from "../components/ReaderErrorBoundary";
import { I18nProvider } from "../i18n/I18nProvider";
import { DEFAULT_TWEAKS } from "../hooks/useTweaks";
import { THEMES, ACCENT, type ThemeKey } from "../styles/tokens";
import type { EpubBook } from "../epub/types";
import type { ChapterItem } from "../epub/types";
import type { BookState } from "../store/library";
import type { ActivePanel, Tweaks } from "../types/reader";
import "../styles/global.css";

const PARA =
  "التقط فانغ يوان الثوب الأسود والجوارب التي غيّرها، ألم أقل ذلك من قبل، " +
  "سنذهب إلى جبل باي غو الآن. أما بالنسبة إلى غو اليانغ، فانتظر على الأقل " +
  "حتى أكون في الرتبة الثالثة أولاً، وحتى ذلك الحين لا تتحدث عن الأمر مع أحد.";

const params = new URLSearchParams(location.search);
const DELAY = Number(params.get("delay") ?? 700);
const themeKey = (params.get("theme") ?? "sepia") as ThemeKey;
/**
 * Chapter to open on. Opening deep in the book is the ordinary case in the
 * real app — a resumed novel starts wherever the reader left off — and it is
 * the only way to make a BACKWARD turn land on an uncached chapter, since the
 * prefetch only ever warms the chapter ahead.
 */
const START = Number(params.get("start") ?? 0);
/** `?boom=1` throws during render, to check the reader's error boundary. */
const BOOM = params.get("boom") === "1";

const CHAPTERS = 40;
/** Paragraph counts, mixing chapters shorter and longer than the viewport. */
const LENGTHS = [30, 4, 3, 8, 22, 3, 5, 40, 2, 14];

/** Empty placeholders, exactly as SourceStreamReader builds them from stubs. */
function makeStubBook(): EpubBook {
  return {
    id: "stream-harness-book",
    title: "القس المجنون",
    author: "مؤلف",
    language: "ar",
    chapters: Array.from({ length: CHAPTERS }, (_, i) => ({
      id: `src-${i}`, // stub.sourceId in the real reader
      href: `ch-${i}.xhtml`,
      title: `الفصل ${i + 1}`,
      order: i,
      paragraphs: [],
    })),
  };
}

function contentFor(idx: number): ChapterItem[] {
  const n = LENGTHS[idx % LENGTHS.length];
  return Array.from({ length: n }, () => ({ kind: "text" as const, text: PARA }));
}

/** Verbatim copy of SourceStreamReader's splice, including the id bump. */
function spliceChapter(prev: EpubBook, idx: number, items: ChapterItem[]): EpubBook {
  const existing = prev.chapters[idx];
  if (!existing) return prev;
  if (existing.paragraphs === items) return prev;
  const next = { ...existing, paragraphs: items, id: `${existing.href}#${items.length}` };
  const chapters = prev.chapters.slice();
  chapters[idx] = next;
  return { ...prev, chapters };
}

function Harness() {
  const [book, setBook] = useState(makeStubBook);
  const [t, setT] = useState<Tweaks>({
    ...DEFAULT_TWEAKS,
    theme: themeKey,
    readingMode: "scroll",
  });
  const [chapter, setChapter] = useState(START);
  const [panel, setPanel] = useState<ActivePanel>(null);
  const [resumeParagraph, setResumeParagraph] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const cache = useRef(new Map<number, ChapterItem[]>());

  const say = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toISOString().slice(17, 23)} ${line}`, ...prev].slice(0, 14));
  }, []);

  // Same shape as the real fetchChapter: cache hit is synchronous, a miss
  // takes DELAY ms and only then does the content exist.
  const fetchChapter = useCallback(
    (idx: number) => {
      const hit = cache.current.get(idx);
      if (hit) {
        setBook((prev) => spliceChapter(prev, idx, hit));
        return;
      }
      window.setTimeout(() => {
        const items = contentFor(idx);
        cache.current.set(idx, items);
        setBook((prev) => spliceChapter(prev, idx, items));
        say(`chapter ${idx + 1} content arrived (${items.length} paras)`);
      }, DELAY);
    },
    [say],
  );

  useEffect(() => {
    fetchChapter(chapter);
    // Forward-only prefetch, exactly like the real reader — the chapter
    // BEHIND you is never warmed, which is why scrolling back is the case
    // that always hits an empty render.
    if (chapter + 1 < CHAPTERS) fetchChapter(chapter + 1);
  }, [chapter, fetchChapter]);

  const onChapterChange = useCallback(
    (order: number) => {
      const clamped = Math.max(0, Math.min(CHAPTERS - 1, order));
      say(`turn → chapter ${clamped + 1}`);
      setChapter(clamped);
      setResumeParagraph(0);
    },
    [say],
  );

  const state: BookState = {
    bookId: book.id,
    currentChapter: chapter,
    paragraphIndex: 0,
    highlights: [],
  };

  return (
    // The real app wraps its readers in this, so the rig does too — otherwise
    // a render error here would blank the rig in a way the app no longer can.
    <ReaderErrorBoundary theme={THEMES[themeKey] ?? THEMES.sepia}>
      {BOOM ? <Boom /> : null}
      <DesktopReader
        theme={THEMES[themeKey] ?? THEMES.sepia}
        themeKey={themeKey}
        t={t}
        setTweak={(k, v) => setT((prev) => ({ ...prev, [k]: v }))}
        book={book}
        state={state}
        currentChapter={chapter}
        resumeParagraph={resumeParagraph}
        jumpNonce={0}
        onChapterChange={onChapterChange}
        onParagraphChange={() => {}}
        onCreateHighlight={() => {}}
        onDeleteHighlight={() => {}}
        onUpdateHighlightNote={() => {}}
        onJumpToHighlight={() => {}}
        activePanel={panel}
        setActivePanel={setPanel}
        onBack={() => {}}
      />
      <Probe log={log} chapter={chapter} book={book} />
    </ReaderErrorBoundary>
  );
}

/** `?boom=1` — proves the boundary catches instead of blanking the window. */
function Boom(): never {
  throw new Error("deliberate render error from the stream harness");
}

/**
 * Reports what the reading pane is actually showing. "Blank" is a claim about
 * scroll offset versus where the text nodes are, so it gets measured rather
 * than looked at: the chapter heading is the first thing BookBody renders, so
 * a heading sitting above the viewport with no paragraph in view is exactly
 * the state the user photographed.
 */
function Probe({ log, chapter, book }: { log: string[]; chapter: number; book: EpubBook }) {
  const [info, setInfo] = useState("");
  useEffect(() => {
    const read = () => {
      const el = document.querySelector<HTMLElement>(".no-scrollbar");
      if (!el) return setInfo("no scroller");
      const paras = el.querySelectorAll<HTMLElement>("[data-p-index]");
      const heading = el.querySelector("h2");
      const top = el.getBoundingClientRect().top;
      const headingTop = heading ? heading.getBoundingClientRect().top - top : NaN;
      let visible = 0;
      for (const p of paras) {
        const r = p.getBoundingClientRect();
        if (r.bottom > top && r.top < top + el.clientHeight) visible += 1;
      }
      const blank = visible === 0 && (Number.isNaN(headingTop) || headingTop < -20);
      setInfo(
        [
          `ch ${chapter + 1}  id ${book.chapters[chapter]?.id}`,
          `scrollTop ${Math.round(el.scrollTop)} / ${el.scrollHeight - el.clientHeight}`,
          `paras ${paras.length}  in view ${visible}`,
          `heading offset ${Number.isNaN(headingTop) ? "—" : Math.round(headingTop)}`,
          blank ? "◼ BLANK PANE" : "",
        ].join("   "),
      );
    };
    const id = window.setInterval(read, 120);
    return () => window.clearInterval(id);
  }, [chapter, book]);

  const isBlank = info.includes("BLANK");
  return (
    <div
      style={{
        position: "fixed",
        left: 8,
        top: 8,
        zIndex: 9999,
        maxWidth: 640,
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(0,0,0,0.82)",
        color: isBlank ? "#ff8a7a" : "#d9d2c4",
        font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        pointerEvents: "none",
        direction: "ltr",
      }}
    >
      <div style={{ color: isBlank ? "#ff8a7a" : ACCENT }}>{info}</div>
      {log.map((l, i) => (
        <div key={i} style={{ opacity: 1 - i * 0.06 }}>{l}</div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider locale="ar">
    <Harness />
  </I18nProvider>,
);
