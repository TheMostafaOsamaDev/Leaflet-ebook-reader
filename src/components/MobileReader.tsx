import { useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./Icon";
import { BookBody } from "./BookBody";
import { MobileSheet } from "./MobileSheet";
import type { EpubBook } from "../epub/types";
import type { BookState, Bookmark } from "../store/library";
import { type Theme, type ThemeKey } from "../styles/tokens";
import { BookmarksPanel } from "../panels/BookmarksPanel";
import { HighlightsPanel } from "../panels/HighlightsPanel";
import { ProgressOverlay } from "../panels/ProgressOverlay";
import { SettingsPanel } from "../panels/SettingsPanel";
import { TOCPanel } from "../panels/TOCPanel";
import type { ActivePanel, Tweaks } from "../types/reader";

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  book: EpubBook;
  state: BookState;
  currentChapter: number;
  onChapterChange: (order: number) => void;
  onToggleBookmark: () => void;
  onDeleteBookmark: (id: string) => void;
  onBack: () => void;
}

function mobileTab(theme: Theme): CSSProperties {
  return {
    width: 44,
    height: 44,
    borderRadius: 10,
    border: "none",
    background: "transparent",
    color: theme.chromeInk,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

export function MobileReader({
  theme,
  themeKey,
  t,
  setTweak,
  book,
  state,
  currentChapter,
  onChapterChange,
  onToggleBookmark,
  onDeleteBookmark,
  onBack,
}: Props) {
  const [showChrome, setShowChrome] = useState(true);
  const [sheet, setSheet] = useState<ActivePanel>(null);

  const chapter = book.chapters[currentChapter] ?? book.chapters[0];
  const chapterCount = book.chapters.length;
  const pct = chapterCount > 0
    ? Math.round(((currentChapter + 1) / chapterCount) * 100)
    : 0;
  const isBookmarked = state.bookmarks.some(
    (b: Bookmark) => b.chapter === currentChapter,
  );
  const ticks =
    chapterCount > 1
      ? Array.from({ length: chapterCount - 1 }, (_, i) => (i + 1) / chapterCount)
      : [];

  const prevChapter = () => {
    if (currentChapter > 0) onChapterChange(currentChapter - 1);
  };
  const nextChapter = () => {
    if (currentChapter < chapterCount - 1) onChapterChange(currentChapter + 1);
  };

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
        fontFamily: '"Inter", system-ui, sans-serif',
      }}
    >
      {showChrome && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            padding: "env(safe-area-inset-top, 12px) 14px 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: `linear-gradient(180deg, ${theme.chrome} 70%, transparent)`,
          }}
        >
          <button
            onClick={onBack}
            style={{ ...mobileTab(theme), width: 36, height: 36 }}
            aria-label="Back to library"
          >
            <Icon name="arrowL" size={16} />
          </button>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 1,
              minWidth: 0,
            }}
          >
            <div
              style={{
                fontFamily: '"Fraunces", serif',
                fontSize: 13,
                fontStyle: "italic",
                fontWeight: 500,
                color: theme.ink,
                letterSpacing: "-0.01em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "100%",
              }}
            >
              {book.title}
            </div>
            <div style={{ fontSize: 10, color: theme.muted }}>
              Chapter {currentChapter + 1} / {chapterCount}
            </div>
          </div>
          <button
            onClick={onToggleBookmark}
            style={{ ...mobileTab(theme), width: 36, height: 36 }}
            aria-label={isBookmarked ? "Remove bookmark" : "Bookmark chapter"}
          >
            <Icon
              name="bookmark"
              size={16}
              fill={isBookmarked ? theme.ink : "none"}
            />
          </button>
        </div>
      )}

      <div
        onClick={() => setShowChrome((s) => !s)}
        style={{
          flex: 1,
          overflow: "auto",
          padding: showChrome ? "88px 28px 140px" : "44px 28px 44px",
          position: "relative",
        }}
        className="no-scrollbar"
      >
        <BookBody
          chapter={chapter}
          chapterCount={chapterCount}
          theme={theme}
          fontFamily={t.fontFamily}
          fontSize={t.fontSize}
          lineHeight={t.lineHeight}
          letterSpacing={t.letterSpacing}
          textAlign={t.textAlign}
          columns={1}
          rtl={t.rtl}
          maxWidth={360}
        />
      </div>

      {showChrome && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            padding: "14px 20px calc(env(safe-area-inset-bottom, 0px) + 16px)",
            color: theme.chromeInk,
            background: `linear-gradient(0deg, ${theme.chrome} 70%, transparent)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
              color: theme.muted,
              fontSize: 10.5,
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                prevChapter();
              }}
              disabled={currentChapter === 0}
              aria-label="Previous chapter"
              style={{
                ...mobileTab(theme),
                width: 28,
                height: 28,
                opacity: currentChapter === 0 ? 0.35 : 1,
              }}
            >
              <Icon name="arrowL" size={14} />
            </button>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
            <div style={{ flex: 1, position: "relative", height: 3 }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: theme.rule,
                  borderRadius: 1.5,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${pct}%`,
                  background: theme.ink,
                  borderRadius: 1.5,
                }}
              />
              {ticks.map((p, i) => (
                <span
                  key={i}
                  style={{
                    position: "absolute",
                    left: `${p * 100}%`,
                    top: -2,
                    width: 1,
                    height: 7,
                    background: theme.muted,
                    opacity: 0.5,
                  }}
                />
              ))}
              <div
                style={{
                  position: "absolute",
                  left: `${pct}%`,
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  background: theme.ink,
                  boxShadow: `0 0 0 3px ${theme.chrome}`,
                }}
              />
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                nextChapter();
              }}
              disabled={currentChapter >= chapterCount - 1}
              aria-label="Next chapter"
              style={{
                ...mobileTab(theme),
                width: 28,
                height: 28,
                opacity: currentChapter >= chapterCount - 1 ? 0.35 : 1,
              }}
            >
              <Icon name="arrowR" size={14} />
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-around" }}>
            <button
              onClick={() => setSheet("toc")}
              style={mobileTab(theme)}
              aria-label="Table of contents"
            >
              <Icon name="list" size={18} />
            </button>
            <button
              onClick={() => setSheet("bookmarks")}
              style={mobileTab(theme)}
              aria-label="Bookmarks"
            >
              <Icon name="bookmark" size={18} />
            </button>
            <button
              onClick={() => setSheet("highlights")}
              style={mobileTab(theme)}
              aria-label="Highlights"
            >
              <Icon name="highlight" size={18} />
            </button>
            <button
              onClick={() => setSheet("progress")}
              style={mobileTab(theme)}
              aria-label="Progress"
            >
              <Icon name="clock" size={18} />
            </button>
            <button
              onClick={() => setSheet("settings")}
              style={mobileTab(theme)}
              aria-label="Settings"
            >
              <Icon name="type" size={18} />
            </button>
          </div>
        </div>
      )}

      {sheet && (
        <MobileSheet theme={theme} onClose={() => setSheet(null)} height="82%">
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {sheet === "toc" && (
              <TOCPanel
                theme={theme}
                onClose={() => setSheet(null)}
                bookTitle={book.title}
                chapters={book.chapters}
                currentChapter={currentChapter}
                onJump={(order) => {
                  onChapterChange(order);
                  setSheet(null);
                }}
              />
            )}
            {sheet === "bookmarks" && (
              <BookmarksPanel
                theme={theme}
                onClose={() => setSheet(null)}
                bookmarks={state.bookmarks}
                onJump={(ch) => {
                  onChapterChange(ch);
                  setSheet(null);
                }}
                onDelete={onDeleteBookmark}
              />
            )}
            {sheet === "highlights" && (
              <HighlightsPanel
                theme={theme}
                themeKey={themeKey}
                onClose={() => setSheet(null)}
                highlights={state.highlights}
              />
            )}
            {sheet === "settings" && (
              <SettingsPanel
                theme={theme}
                themeKey={themeKey}
                t={t}
                setTweak={setTweak}
                onClose={() => setSheet(null)}
              />
            )}
            {sheet === "progress" && (
              <div
                style={{
                  padding: 22,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "center",
                }}
              >
                <ProgressOverlay
                  theme={theme}
                  themeKey={themeKey}
                  currentChapter={currentChapter}
                  chapterCount={chapterCount}
                  chapterTitle={chapter.title}
                />
              </div>
            )}
          </div>
        </MobileSheet>
      )}
    </div>
  );
}
