import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { isImageItem, type ChapterItem, type EpubChapter } from "../epub/types";
import { chapterImageSrcFor, type Highlight } from "../store/library";
import { ensureEpubImages } from "../store/epubImages";
import { open as openLightbox } from "../store/lightbox";
import {
  FONT_READING_SANS,
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  hlBg,
  type FontFamilyKey,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";
import { useFontScale } from "../hooks/useFontScale";
import { NoteSpines } from "./NoteSpines";
import { useNoteSpines } from "../hooks/useNoteSpines";

/** Horizontal gutter for the reading surface, derived from the content-width
 *  setting.
 *
 *  The readers used to impose a fixed gutter and then size the text column to a
 *  percentage of what was left, so "100%" was never the screen: on a 412px
 *  phone a 28px gutter left 356px, or 86% — visibly short of the edges while
 *  the control claimed to be maxed out. Scaling the gutter instead gives the
 *  setting its full range: `min` at 100% (a hairline, so text never touches the
 *  bezel) widening to `max` at 50%. */
export function readingGutter(
  widthPercent: number,
  min: number,
  max: number,
): number {
  const pct = Math.max(50, Math.min(100, widthPercent));
  return Math.round(min + (max - min) * ((100 - pct) / 50));
}

interface Props {
  /** Book id — needed to resolve image item `src` to an asset:// URL. */
  bookId: string;
  chapter: EpubChapter;
  chapterCount: number;
  theme: Theme;
  themeKey: ThemeKey;
  fontFamily: FontFamilyKey;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing?: number;
  hyphenation?: boolean;
  language?: string;
  /** "auto" lets BookBody pick a sensible default from the script
      direction — justify for LTR, right for RTL. The user's explicit
      choices ("left" / "justify" / "right") always win. */
  textAlign: "auto" | "left" | "justify" | "right";
  /** Whether to render the chapter as RTL — derived from the book's
      language tag by the caller. Drives `dir`, alignment fallback, and
      title font choice. */
  rtl: boolean;
  /** Width of the body column as a percentage of the container (50–100).
      The reader's own padding frames the column, so 100% means the column
      fills the available container width. */
  widthPercent?: number;
  /** Highlights that anchor into this chapter. BookBody renders any
      whose paragraphIndex matches the displayed paragraph index. */
  highlights?: Highlight[];
  /** When false, disables native text selection in the body — used by
      MobileReader, which drives its own selection via custom pointer
      handlers. Defaults to true so the desktop reader is unaffected. */
  selectable?: boolean;
}

/** Resolve every image item's storage-relative src to a webview-loadable
 *  asset URL once per chapter switch. Brief flash on first render of each
 *  chapter while these promises settle is acceptable — once resolved the
 *  Map is stable and the same image rendered twice picks up the same URL.
 *
 *  That flash is also where lazy extraction hides: the first visit to a
 *  chapter of an illustrated EPUB extracts its images out of the archive
 *  before the URLs resolve. Later visits find them on disk. */
function useChapterImageUrls(
  bookId: string,
  paragraphs: ChapterItem[],
): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const srcs = Array.from(
      new Set(paragraphs.filter(isImageItem).map((p) => p.src)),
    );
    if (srcs.length === 0) {
      setUrls(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      // Images live inside book.epub until a chapter asks for them. No-op
      // for books whose images are already on disk and for streaming books,
      // whose srcs are remote URLs.
      await ensureEpubImages(bookId, srcs);
      if (cancelled) return;
      const entries = await Promise.all(
        srcs.map(
          async (src) =>
            [src, await chapterImageSrcFor(bookId, src)] as const,
        ),
      );
      if (cancelled) return;
      setUrls(new Map(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId, paragraphs]);
  return urls;
}

export function BookBody({
  bookId,
  chapter,
  chapterCount,
  theme,
  themeKey,
  fontFamily,
  fontSize,
  lineHeight,
  letterSpacing,
  paragraphSpacing = 1.1,
  hyphenation = false,
  language,
  textAlign,
  rtl,
  widthPercent = 100,
  highlights = [],
  selectable = true,
}: Props) {
  const clampedPercent = Math.max(50, Math.min(100, widthPercent));
  const resolvedAlign =
    textAlign === "auto" ? (rtl ? "right" : "justify") : textAlign;
  // Honour the user's font choice in both LTR and RTL. Each FONT_STACKS
  // entry already lists an Arabic-capable fallback (Readex Pro for the
  // Latin-first stacks; Cairo/Lateef/Tajawal are Arabic-primary), so the
  // old `FONT_ARABIC` force-override is no longer needed and was silently
  // ignoring the user's selection in RTL mode.
  const bodyFont =
    fontFamily === "sans" ? FONT_READING_SANS : FONT_STACKS[fontFamily];

  // Normalize apparent size across the reading fonts, measured off the face
  // that actually resolved. Without it the same slider value reads ~28%
  // smaller in Lateef than in Readex Pro, and the size control stops meaning
  // one thing. Measured against the script the book is actually set in — a
  // face's Latin and Arabic need different corrections.
  const fontScale = useFontScale(bodyFont, rtl ? "arabic" : "latin");
  const scaledFontSize = Math.round(fontSize * fontScale * 100) / 100;

  // BookBody renders a flat linear flow. Multi-column layout (paginated or
  // otherwise) is now the wrapper's job — that lets DesktopReader switch
  // between scroll and paginated modes by changing only the container,
  // without BookBody having to know which one it's inside.
  const common: CSSProperties = {
    fontSize: scaledFontSize,
    lineHeight,
    letterSpacing: `${letterSpacing}em`,
    color: theme.ink,
    width: `${clampedPercent}%`,
    margin: "0 auto",
  };

  const imageUrls = useChapterImageUrls(bookId, chapter.paragraphs);

  // Drop the first paragraph if it's just the chapter title repeated — many
  // EPUBs include an <h1>/<h2> with the title as the first block element.
  // We track each kept paragraph's *original* index so highlights anchored
  // to chapter.paragraphs[i] resolve to the same paragraph after filtering.
  // Image items at index 0 always pass through — those are figures, not
  // duplicate titles.
  const paragraphs = useMemo(() => {
    const normalizedTitle = chapter.title.trim().toLowerCase();
    return chapter.paragraphs
      .map((p, originalIndex) => ({ p, originalIndex }))
      .filter(({ p, originalIndex }) => {
        if (originalIndex !== 0) return true;
        if (isImageItem(p)) return true;
        return p.text.trim().toLowerCase() !== normalizedTitle;
      });
  }, [chapter]);

  // Bucket the chapter's highlights by paragraph index once so each
  // paragraph render is O(matches) instead of O(highlights). Memoised
  // because the reader re-renders on things that touch neither.
  const highlightsByParagraph = useMemo(() => {
    const byParagraph = new Map<number, Highlight[]>();
    for (const h of highlights) {
      if (h.chapter !== chapter.order) continue;
      const list = byParagraph.get(h.paragraphIndex) ?? [];
      list.push(h);
      byParagraph.set(h.paragraphIndex, list);
    }
    return byParagraph;
  }, [highlights, chapter.order]);

  return (
    <div
      dir={rtl ? "rtl" : "ltr"}
      {...(language ? { lang: language } : null)}
      data-book-body
      style={{
        ...common,
        fontFamily: bodyFont,
        // Reading content keeps natural glyph metrics — opt out of the chrome's
        // per-UI-font glyph normalization.
        fontSizeAdjust: "none",
        textAlign: resolvedAlign,
        // Native selection is suppressed when selectable=false (mobile
        // reader). MobileReader drives its own selection via custom
        // pointer handlers — without this, Android/Samsung shows the
        // OS text-selection toolbar which can't be hidden at the app
        // layer. Desktop passes selectable=true (the default) so its
        // native selection is unaffected.
        userSelect: selectable ? undefined : "none",
        WebkitUserSelect: selectable ? undefined : "none",
        // touch-action: pan-y so the browser handles vertical scroll
        // natively with momentum (the compositor-driven smooth scroll
        // we lost when we briefly used touch-action: none). MobileReader's
        // gesture effect calls preventDefault on pointermove during
        // active selection drag to suppress scroll only when needed.
        touchAction: selectable ? undefined : "pan-y",
      }}
    >
      <div style={{ marginBottom: "1.4em", breakInside: "avoid-column" }}>
        <div
          style={{
            // Reading-surface meta label: stays on the fixed reading sans, not
            // the selectable chrome font (var(--ui-font)).
            fontFamily: FONT_READING_SANS,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: theme.muted,
            marginBottom: 6,
          }}
        >
          Chapter {chapter.order + 1} of {chapterCount}
        </div>
        <h2
          style={{
            // In RTL, match the body font so the chapter title doesn't
            // jump to a different typeface than the paragraphs. In LTR,
            // keep the italic display serif for the editorial look.
            fontFamily: rtl ? bodyFont : FONT_SERIF_DISPLAY,
            fontSize: (rtl ? scaledFontSize : fontSize) * 1.7,
            fontWeight: 500,
            fontStyle: "normal",
            margin: 0,
            color: theme.ink,
            letterSpacing: "-0.01em",
            lineHeight: 1.15,
          }}
        >
          {chapter.title}
        </h2>
      </div>
      {paragraphs.map(({ p, originalIndex }) =>
        isImageItem(p) ? (
          <figure
            key={originalIndex}
            data-p-index={originalIndex}
            style={{
              margin: "1.4em 0",
              textAlign: "center",
            }}
          >
            <img
              src={imageUrls.get(p.src)}
              alt={p.alt ?? ""}
              loading="lazy"
              onClick={() => {
                const url = imageUrls.get(p.src);
                if (url) openLightbox(url, p.alt);
              }}
              style={{
                maxWidth: "100%",
                height: "auto",
                // The image dimensions come from the file itself. We render a
                // subtle placeholder background while loading + a corner
                // radius so unstyled photos look intentional in-flow.
                borderRadius: 6,
                background: theme.chrome,
                cursor: "zoom-in",
              }}
            />
          </figure>
        ) : (
          <TextParagraph
            key={originalIndex}
            index={originalIndex}
            text={p.text}
            highlights={highlightsByParagraph.get(originalIndex) ?? NO_HIGHLIGHTS}
            themeKey={themeKey}
            spacing={paragraphSpacing}
            hyphenation={hyphenation}
          />
        ),
      )}
    </div>
  );
}

/**
 * One paragraph of the book, and the note bars beside it.
 *
 * It is a component rather than inline JSX because the bars have to be
 * measured against something, and that something is this paragraph: it
 * is their containing block, which is what lets them sit in the margin
 * in the scrolling reader and inside a CSS column in the paginated one
 * without either knowing about the other. See NoteSpines.
 */
const TextParagraph = memo(function TextParagraph({
  index,
  text,
  highlights,
  themeKey,
  spacing,
  hyphenation,
}: {
  index: number;
  text: string;
  highlights: Highlight[];
  themeKey: ThemeKey;
  spacing: number;
  hyphenation: boolean;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  // Most paragraphs have no highlights at all, so this bails before
  // allocating anything: it runs for every paragraph on every render.
  const noteIds = useMemo(
    () =>
      highlights.length === 0
        ? NO_IDS
        : highlights.filter((h) => h.note).map((h) => h.id),
    [highlights],
  );
  const spines = useNoteSpines(ref, noteIds, [text, spacing, hyphenation]);

  return (
    <p
      ref={ref}
      data-p-index={index}
      style={{
        margin: `0 0 ${spacing}em`,
        // Containing block for the note bars. Costs nothing on its own
        // and does not affect the text.
        position: noteIds.length > 0 ? "relative" : undefined,
        ...(hyphenation
          ? { hyphens: "auto", WebkitHyphens: "auto" as const }
          : null),
      }}
    >
      {renderParagraph(text, highlights, themeKey)}
      <NoteSpines
        spines={spines}
        colorOf={(id) => highlights.find((h) => h.id === id)?.color}
        themeKey={themeKey}
      />
    </p>
  );
});

/** Shared empty arrays. A fresh `[]` per paragraph per render would be
 *  N allocations and would also make every memo boundary miss. */
const NO_IDS: string[] = [];
const NO_HIGHLIGHTS: Highlight[] = [];

/** Slice a paragraph's plain text into alternating plain segments and
 *  <mark> spans for each highlight. Highlights are rendered in document
 *  order; if two overlap, later ones win for the overlap span. */
function renderParagraph(
  text: string,
  hs: Highlight[],
  themeKey: ThemeKey,
): ReactNode {
  if (hs.length === 0) return text;
  const sorted = [...hs].sort((a, b) => a.charStart - b.charStart);
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const h of sorted) {
    const start = Math.max(cursor, Math.min(h.charStart, text.length));
    const end = Math.max(start, Math.min(h.charEnd, text.length));
    if (start > cursor) out.push(text.slice(cursor, start));
    if (end > start) {
      out.push(
        <mark
          key={h.id}
          data-h-id={h.id}
          // What a reader's cursor is really asking about when it
          // stops on a highlight.
          title={h.note}
          style={{
            background: hlBg(h.color, themeKey),
            color: "inherit",
            borderRadius: 2,
            // No `padding` here. Earlier we used `padding: 0 0.05em` for
            // a little colored breathing room around the text, but with
            // `box-decoration-break: clone` the padding is applied to
            // every wrapped fragment — reflowing the paragraph the
            // moment a highlight is created and shifting where the user
            // was reading. Box-shadow paints the same visual extension
            // without occupying inline-direction layout space.
            boxShadow: `0.05em 0 0 ${hlBg(h.color, themeKey)}, -0.05em 0 0 ${hlBg(h.color, themeKey)}`,
            cursor: "pointer",
            // Treat the highlight as a complete box on every wrapped
            // line. Without this, the default `slice` mode renders the
            // background and box-shadow only on the very first/last
            // line, and middle lines stretch flush to the line edges —
            // which visually breaks across line wraps.
            boxDecorationBreak: "clone",
            WebkitBoxDecorationBreak: "clone",
          }}
        >
          {text.slice(start, end)}
        </mark>,
      );
    }
    cursor = end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
