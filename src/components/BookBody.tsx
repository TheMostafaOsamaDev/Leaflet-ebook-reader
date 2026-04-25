import type { CSSProperties, ReactNode } from "react";
import type { EpubChapter } from "../epub/types";
import type { Highlight } from "../store/library";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  hlBg,
  type FontFamilyKey,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";

interface Props {
  chapter: EpubChapter;
  chapterCount: number;
  theme: Theme;
  themeKey: ThemeKey;
  fontFamily: FontFamilyKey;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  textAlign: "left" | "justify" | "right";
  columns: 1 | 2;
  rtl: boolean;
  maxWidth?: number;
  /** Highlights that anchor into this chapter. BookBody renders any
      whose paragraphIndex matches the displayed paragraph index. */
  highlights?: Highlight[];
}

export function BookBody({
  chapter,
  chapterCount,
  theme,
  themeKey,
  fontFamily,
  fontSize,
  lineHeight,
  letterSpacing,
  textAlign,
  columns,
  rtl,
  maxWidth = 680,
  highlights = [],
}: Props) {
  const common: CSSProperties = {
    fontSize,
    lineHeight,
    letterSpacing: `${letterSpacing}em`,
    color: theme.ink,
    maxWidth,
    margin: "0 auto",
    columnCount: columns,
    columnGap: 56,
    columnRule: columns > 1 ? `0.5px solid ${theme.rule}` : "none",
  };

  // Honour the user's font choice in both LTR and RTL. Each FONT_STACKS
  // entry already lists an Arabic-capable fallback (Readex Pro for the
  // Latin-first stacks; Cairo/Lateef/Tajawal are Arabic-primary), so the
  // old `FONT_ARABIC` force-override is no longer needed and was silently
  // ignoring the user's selection in RTL mode.
  const bodyFont = FONT_STACKS[fontFamily];
  // Drop the first paragraph if it's just the chapter title repeated — many
  // EPUBs include an <h1>/<h2> with the title as the first block element.
  // We track each kept paragraph's *original* index so highlights anchored
  // to chapter.paragraphs[i] resolve to the same paragraph after filtering.
  const normalizedTitle = chapter.title.trim().toLowerCase();
  const paragraphs = chapter.paragraphs
    .map((p, originalIndex) => ({ p, originalIndex }))
    .filter(({ p, originalIndex }) =>
      originalIndex !== 0 || p.text.trim().toLowerCase() !== normalizedTitle,
    );

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
        textAlign: rtl ? "right" : textAlign,
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
      {paragraphs.map(({ p, originalIndex }) => (
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
      ))}
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
