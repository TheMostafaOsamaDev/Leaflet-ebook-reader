import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { isImageItem, type ChapterItem, type EpubChapter } from "../epub/types";
import { chapterImageSrcFor, type Highlight } from "../store/library";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  hlBg,
  type FontFamilyKey,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";

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
  /** "auto" lets BookBody pick a sensible default from the script
      direction — justify for LTR, right for RTL. The user's explicit
      choices ("left" / "justify" / "right") always win. */
  textAlign: "auto" | "left" | "justify" | "right";
  /** Whether to render the chapter as RTL — derived from the book's
      language tag by the caller. Drives `dir`, alignment fallback, and
      title font choice. */
  rtl: boolean;
  maxWidth?: number;
  /** Width of the body column as a percentage of the container (50–100).
      Combines with `maxWidth` (px cap) so the column scales with the
      viewport but never exceeds the configured cap. */
  widthPercent?: number;
  /** Highlights that anchor into this chapter. BookBody renders any
      whose paragraphIndex matches the displayed paragraph index. */
  highlights?: Highlight[];
}

/** Resolve every image item's storage-relative src to a webview-loadable
 *  asset URL once per chapter switch. Brief flash on first render of each
 *  chapter while these promises settle is acceptable — once resolved the
 *  Map is stable and the same image rendered twice picks up the same URL. */
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
  textAlign,
  rtl,
  maxWidth = 680,
  widthPercent = 100,
  highlights = [],
}: Props) {
  const clampedPercent = Math.max(50, Math.min(100, widthPercent));
  const resolvedAlign =
    textAlign === "auto" ? (rtl ? "right" : "justify") : textAlign;
  // BookBody renders a flat linear flow. Multi-column layout (paginated or
  // otherwise) is now the wrapper's job — that lets DesktopReader switch
  // between scroll and paginated modes by changing only the container,
  // without BookBody having to know which one it's inside.
  const common: CSSProperties = {
    fontSize,
    lineHeight,
    letterSpacing: `${letterSpacing}em`,
    color: theme.ink,
    width: `${clampedPercent}%`,
    maxWidth,
    margin: "0 auto",
  };

  // Honour the user's font choice in both LTR and RTL. Each FONT_STACKS
  // entry already lists an Arabic-capable fallback (Readex Pro for the
  // Latin-first stacks; Cairo/Lateef/Tajawal are Arabic-primary), so the
  // old `FONT_ARABIC` force-override is no longer needed and was silently
  // ignoring the user's selection in RTL mode.
  const bodyFont = FONT_STACKS[fontFamily];

  const imageUrls = useChapterImageUrls(bookId, chapter.paragraphs);

  // Drop the first paragraph if it's just the chapter title repeated — many
  // EPUBs include an <h1>/<h2> with the title as the first block element.
  // We track each kept paragraph's *original* index so highlights anchored
  // to chapter.paragraphs[i] resolve to the same paragraph after filtering.
  // Image items at index 0 always pass through — those are figures, not
  // duplicate titles.
  const normalizedTitle = chapter.title.trim().toLowerCase();
  const paragraphs = chapter.paragraphs
    .map((p, originalIndex) => ({ p, originalIndex }))
    .filter(({ p, originalIndex }) => {
      if (originalIndex !== 0) return true;
      if (isImageItem(p)) return true;
      return p.text.trim().toLowerCase() !== normalizedTitle;
    });

  // Bucket the chapter's highlights by paragraph index once so each
  // paragraph render is O(matches) instead of O(highlights).
  const highlightsByParagraph = new Map<number, Highlight[]>();
  for (const h of highlights) {
    if (h.chapter !== chapter.order) continue;
    const list = highlightsByParagraph.get(h.paragraphIndex) ?? [];
    list.push(h);
    highlightsByParagraph.set(h.paragraphIndex, list);
  }

  return (
    <div
      dir={rtl ? "rtl" : "ltr"}
      style={{
        ...common,
        fontFamily: bodyFont,
        textAlign: resolvedAlign,
      }}
    >
      <div style={{ marginBottom: "1.4em", breakInside: "avoid-column" }}>
        <div
          style={{
            fontFamily: FONT_STACKS.sans,
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
            fontSize: fontSize * 1.7,
            fontWeight: 500,
            fontStyle: rtl ? "normal" : "italic",
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
              style={{
                maxWidth: "100%",
                height: "auto",
                // The image dimensions come from the file itself. We render a
                // subtle placeholder background while loading + a corner
                // radius so unstyled photos look intentional in-flow.
                borderRadius: 6,
                background: theme.chrome,
              }}
            />
          </figure>
        ) : (
          <p
            key={originalIndex}
            data-p-index={originalIndex}
            style={{ margin: "0 0 1.1em" }}
          >
            {renderParagraph(
              p.text,
              highlightsByParagraph.get(originalIndex) ?? [],
              themeKey,
            )}
          </p>
        ),
      )}
    </div>
  );
}

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
          style={{
            background: hlBg(h.color, themeKey),
            color: "inherit",
            borderRadius: 2,
            padding: "0 0.05em",
            cursor: "pointer",
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
