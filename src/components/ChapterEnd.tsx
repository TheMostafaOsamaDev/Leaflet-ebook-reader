import { useState } from "react";
import { Icon } from "./Icon";
import { FONT_STACKS, type Theme } from "../styles/tokens";
import type { Tr } from "../i18n";

/**
 * The end of a chapter, and the way out of it.
 *
 * Until now the reader rendered NOTHING after a chapter's last paragraph: no
 * end marker, and no way forward except a hidden wheel gesture, the arrow
 * keys, the scrubber or the table of contents. A reader who did not know the
 * gesture had no visible way to continue, and the gesture itself had to be
 * made expensive (up to five notches of deliberate push) purely to keep an
 * invisible action from firing by accident.
 *
 * Making the turn visible is what let that expense go. The card carries the
 * intent, so the gesture no longer has to prove it — see turnGate.
 *
 * Interaction differs by platform on purpose. Desktop can click, press
 * Enter/Space, or simply keep scrolling past the card. Mobile is tap only:
 * touch momentum keeps delivering scroll events after the finger has left the
 * glass, and letting those turn chapters is precisely how one flick used to
 * cross three of them.
 */

/** Shared press state. Changes fill only — never layout, so nothing moves
 *  under a thumb that is already on the target. */
function usePressed() {
  const [pressed, setPressed] = useState(false);
  return [
    pressed,
    {
      onPointerDown: () => setPressed(true),
      onPointerUp: () => setPressed(false),
      onPointerLeave: () => setPressed(false),
      onPointerCancel: () => setPressed(false),
    },
  ] as const;
}

/** Forward in the book points LEFT in an RTL layout; rtl-flip-x does that to
 *  a directional glyph, and leaves it alone in LTR. */
function Forward({ size }: { size: number }) {
  return <Icon name="chevronR" size={size} className="rtl-flip-x" />;
}

interface EndProps {
  theme: Theme;
  tr: Tr;
  /** Font the chapter's own text is set in — the title is book content. */
  titleFont: string;
  /** Phone sizing: bigger targets, tighter gutters. */
  compact?: boolean;
  /** Title of the next chapter, or null at the end of the book. */
  nextTitle: string | null;
  /** 1-based number of the next chapter. */
  nextNumber: number;
  total: number;
  /** Whether the next chapter is already on the device. Omitted when unknown —
   *  better to say nothing than to guess, since it predicts a wait. */
  availability?: "device" | "online";
  onNext: () => void;
}

export function ChapterEndCard({
  theme,
  tr,
  titleFont,
  compact = false,
  nextTitle,
  nextNumber,
  total,
  availability,
  onNext,
}: EndProps) {
  const [pressed, press] = usePressed();
  const gutter = compact ? 20 : 40;

  return (
    <div
      style={{
        maxWidth: compact ? "none" : 660,
        margin: "0 auto",
        padding: `0 ${gutter}px ${compact ? 56 : 96}px`,
      }}
    >
      {/* The end marker itself, which is what was missing entirely. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          margin: "8px 0 22px",
          color: theme.muted,
          fontFamily: FONT_STACKS.sans,
          fontSize: 10.5,
          letterSpacing: "0.1em",
        }}
      >
        <span style={{ flex: 1, height: 1, background: theme.rule }} />
        <span>{nextTitle === null ? tr("reader.endOfBook") : tr("reader.endOfChapter")}</span>
        <span style={{ flex: 1, height: 1, background: theme.rule }} />
      </div>

      {nextTitle === null ? null : (
        <>
          <button
            onClick={onNext}
            {...press}
            aria-label={`${tr("reader.nextChapter")}: ${nextTitle}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              width: "100%",
              // Comfortably past the 44px minimum on both platforms.
              minHeight: compact ? 76 : 64,
              padding: compact ? "18px" : "18px 22px",
              borderRadius: 14,
              cursor: "pointer",
              font: "inherit",
              textAlign: "start",
              background: pressed ? theme.chromeHover : theme.chrome,
              border: `1px solid ${pressed ? theme.ruleStrong : theme.rule}`,
              color: theme.ink,
              transition: "background 120ms ease-out, border-color 120ms ease-out",
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 10.5,
                  letterSpacing: "0.1em",
                  color: theme.muted,
                  fontFamily: FONT_STACKS.sans,
                  marginBottom: 6,
                }}
              >
                {tr("reader.nextChapter")}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: compact ? 18 : 19,
                  fontWeight: 600,
                  fontFamily: titleFont,
                  lineHeight: 1.3,
                }}
              >
                {nextTitle}
              </span>
            </span>
            <span style={{ color: theme.muted, display: "inline-flex", flexShrink: 0 }}>
              <Forward size={20} />
            </span>
          </button>

          {/* Context row. Whether the next chapter is on the device predicts
              whether the turn will wait, which matters on a book this long. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 12,
              padding: "0 4px",
              minHeight: 24,
              fontFamily: FONT_STACKS.sans,
              fontSize: 11,
              color: theme.muted,
            }}
          >
            {availability ? (
              <>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon
                    name={availability === "device" ? "check" : "downloadCirc"}
                    size={13}
                  />
                  {availability === "device"
                    ? tr("reader.savedOnDevice")
                    : tr("reader.needsConnection")}
                </span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span>{tr("reader.chapterOfTotal", { n: nextNumber, total })}</span>
          </div>
        </>
      )}
    </div>
  );
}

interface StartProps {
  theme: Theme;
  tr: Tr;
  /** Font the chapter's own text is set in — the title is book content. */
  titleFont: string;
  compact?: boolean;
  /** 1-based number of the previous chapter. */
  prevNumber: number;
  prevTitle: string;
  onPrev: () => void;
}

/**
 * The way back, above the chapter's heading.
 *
 * Backward navigation had no affordance at all — only a hidden gesture, the
 * scrubber or the table of contents — so a visible way forward would have left
 * a hidden way back.
 *
 * It NAMES the chapter it leads to. The first version was a bare "previous
 * chapter" label, which told the reader nothing about where they would land
 * while the card at the other end of the page showed a title; on a book of
 * 2372 chapters that is the difference between navigating and guessing.
 *
 * Kept deliberately lighter than the end-of-chapter card: no fill, a single
 * hairline beneath it, and a smaller title. It sits directly above the chapter
 * heading and must not compete with it — going back is the secondary move.
 */
export function ChapterStartLink({
  theme,
  tr,
  titleFont,
  compact = false,
  prevNumber,
  prevTitle,
  onPrev,
}: StartProps) {
  const [pressed, press] = usePressed();
  return (
    <button
      onClick={onPrev}
      {...press}
      aria-label={`${tr("reader.prevChapter")}: ${prevTitle}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        minHeight: compact ? 60 : 56,
        padding: compact ? "10px 12px" : "10px 14px",
        marginBottom: compact ? 10 : 14,
        borderRadius: 10,
        cursor: "pointer",
        font: "inherit",
        textAlign: "start",
        background: pressed ? theme.hover : "transparent",
        border: "none",
        borderBottom: `1px solid ${theme.rule}`,
        color: theme.ink,
        transition: "background 120ms ease-out",
      }}
    >
      {/* Backward, so the forward glyph is mirrored on top of the RTL flip. */}
      <span
        style={{
          display: "inline-flex",
          transform: "scaleX(-1)",
          color: theme.muted,
          flexShrink: 0,
        }}
      >
        <Forward size={16} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 10,
            letterSpacing: "0.1em",
            color: theme.muted,
            fontFamily: FONT_STACKS.sans,
            marginBottom: 3,
          }}
        >
          {`${tr("reader.prevChapter")} · ${prevNumber}`}
        </span>
        <span
          style={{
            display: "block",
            fontSize: compact ? 14.5 : 15,
            fontWeight: 500,
            fontFamily: titleFont,
            color: theme.muted,
            lineHeight: 1.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {prevTitle}
        </span>
      </span>
    </button>
  );
}
