import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  currentChapter: number;
  chapterCount: number;
  chapterTitle: string;
}

export function ProgressOverlay({
  theme,
  themeKey,
  currentChapter,
  chapterCount,
  chapterTitle,
}: Props) {
  const pct = chapterCount > 0
    ? Math.round(((currentChapter + 1) / chapterCount) * 100)
    : 0;
  const chaptersLeft = Math.max(0, chapterCount - currentChapter - 1);

  const shadow =
    themeKey === "light" ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.5)";

  // Evenly-spaced chapter ticks — skip the tick at the current position so
  // the scrubber reads cleanly on top of it.
  const ticks =
    chapterCount > 1
      ? Array.from({ length: chapterCount - 1 }, (_, i) => (i + 1) / chapterCount)
      : [];

  return (
    <div
      style={{
        background: theme.chrome,
        color: theme.ink,
        borderRadius: 14,
        padding: 22,
        minWidth: 340,
        boxShadow: `0 20px 60px ${shadow}`,
        border: `0.5px solid ${theme.rule}`,
        fontFamily: FONT_STACKS.sans,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: theme.muted,
          marginBottom: 14,
        }}
      >
        Reading progress
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: FONT_SERIF_DISPLAY,
            fontSize: 42,
            fontWeight: 400,
            color: theme.ink,
            letterSpacing: "-0.02em",
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {pct}
        </span>
        <span style={{ fontSize: 18, color: theme.muted, fontWeight: 400 }}>
          %
        </span>
        <span
          style={{ fontSize: 11, color: theme.muted, marginLeft: "auto" }}
        >
          of book
        </span>
      </div>

      <div
        style={{
          fontSize: 12,
          color: theme.muted,
          marginBottom: 16,
          lineHeight: 1.4,
        }}
      >
        <span
          style={{
            fontFamily: FONT_SERIF_DISPLAY,
            fontStyle: "italic",
            color: theme.ink,
          }}
        >
          {chapterTitle}
        </span>
        {" · "}
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          chapter {currentChapter + 1} of {chapterCount}
        </span>
        {chaptersLeft > 0 && (
          <>
            {" · "}
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {chaptersLeft} left
            </span>
          </>
        )}
      </div>

      <div
        style={{
          position: "relative",
          height: 6,
          background: theme.rule,
          borderRadius: 3,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${pct}%`,
            background: theme.ink,
            borderRadius: 3,
          }}
        />
        {ticks.map((p, i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: `${p * 100}%`,
              top: -3,
              width: 1.5,
              height: 12,
              background: theme.muted,
              opacity: 0.5,
            }}
          />
        ))}
      </div>
    </div>
  );
}
