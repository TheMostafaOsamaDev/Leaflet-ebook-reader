import type { CSSProperties } from "react";
import type { EpubChapter } from "../epub/types";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  type FontFamilyKey,
  type Theme,
} from "../styles/tokens";

interface Props {
  chapter: EpubChapter;
  chapterCount: number;
  theme: Theme;
  fontFamily: FontFamilyKey;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  textAlign: "left" | "justify" | "right";
  columns: 1 | 2;
  rtl: boolean;
  maxWidth?: number;
}

export function BookBody({
  chapter,
  chapterCount,
  theme,
  fontFamily,
  fontSize,
  lineHeight,
  letterSpacing,
  textAlign,
  columns,
  rtl,
  maxWidth = 680,
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
  const normalizedTitle = chapter.title.trim().toLowerCase();
  const paragraphs = chapter.paragraphs.filter((p, i) => {
    if (i !== 0) return true;
    return p.text.trim().toLowerCase() !== normalizedTitle;
  });

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
      {paragraphs.map((p, i) => (
        <p key={i} style={{ margin: "0 0 1.1em" }}>
          {p.text}
        </p>
      ))}
    </div>
  );
}
