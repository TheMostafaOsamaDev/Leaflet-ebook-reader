import { useEffect } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./Icon";
import { BookBody } from "./BookBody";
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
  activePanel: ActivePanel;
  setActivePanel: (next: ActivePanel) => void;
  onBack: () => void;
}

function chromeBtn(theme: Theme, active = false): CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "none",
    background: active ? theme.hover : "transparent",
    color: active ? theme.ink : theme.chromeInk,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

export function DesktopReader({
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
  activePanel,
  setActivePanel,
  onBack,
}: Props) {
  const chapter = book.chapters[currentChapter] ?? book.chapters[0];
  const chapterCount = book.chapters.length;
  const pct = chapterCount > 0
    ? Math.round(((currentChapter + 1) / chapterCount) * 100)
    : 0;
  const toggle = (panel: ActivePanel) =>
    setActivePanel(activePanel === panel ? null : panel);

  const prevChapter = () => {
    if (currentChapter > 0) onChapterChange(currentChapter - 1);
  };
  const nextChapter = () => {
    if (currentChapter < chapterCount - 1) onChapterChange(currentChapter + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable))
        return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        nextChapter();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevChapter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const isBookmarked = state.bookmarks.some(
    (b: Bookmark) => b.chapter === currentChapter,
  );

  // Chapter ticks on the bottom progress bar — skip current position so
  // the scrubber sits cleanly on top.
  const ticks =
    chapterCount > 1
      ? Array.from({ length: chapterCount - 1 }, (_, i) => (i + 1) / chapterCount)
      : [];

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
        fontFamily: '"Inter", system-ui, sans-serif',
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "14px 22px",
          borderBottom: `0.5px solid ${theme.rule}`,
          color: theme.chromeInk,
          flexShrink: 0,
        }}
      >
        <button onClick={onBack} style={chromeBtn(theme)} aria-label="Back to library">
          <Icon name="home" size={16} />
        </button>
        <div style={{ width: 1, height: 18, background: theme.rule, margin: "0 4px" }} />
        <button
          onClick={() => toggle("toc")}
          style={chromeBtn(theme, activePanel === "toc")}
          aria-label="Table of contents"
        >
          <Icon name="list" size={16} />
        </button>
        <button
          onClick={() => toggle("bookmarks")}
          style={chromeBtn(theme, activePanel === "bookmarks")}
          aria-label="Bookmarks"
        >
          <Icon name="bookmark" size={16} />
        </button>
        <button
          onClick={() => toggle("highlights")}
          style={chromeBtn(theme, activePanel === "highlights")}
          aria-label="Highlights"
        >
          <Icon name="highlight" size={16} />
        </button>

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
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
              maxWidth: "80%",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {book.title}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: theme.muted,
              display: "flex",
              gap: 10,
              alignItems: "center",
            }}
          >
            <span>
              Chapter {currentChapter + 1} of {chapterCount}
            </span>
          </div>
        </div>

        <button
          onClick={onToggleBookmark}
          style={chromeBtn(theme, isBookmarked)}
          aria-label={isBookmarked ? "Remove bookmark" : "Bookmark chapter"}
        >
          <Icon name="bookmark" size={16} fill={isBookmarked ? theme.ink : "none"} />
        </button>
        <button
          onClick={() => toggle("progress")}
          style={chromeBtn(theme, activePanel === "progress")}
          aria-label="Progress"
        >
          <Icon name="clock" size={16} />
        </button>
        <button
          onClick={() => toggle("settings")}
          style={chromeBtn(theme, activePanel === "settings")}
          aria-label="Settings"
        >
          <Icon name="type" size={16} />
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {activePanel === "toc" && (
          <TOCPanel
            theme={theme}
            onClose={() => setActivePanel(null)}
            bookTitle={book.title}
            chapters={book.chapters}
            currentChapter={currentChapter}
            onJump={(order) => {
              onChapterChange(order);
              setActivePanel(null);
            }}
          />
        )}
        {activePanel === "bookmarks" && (
          <BookmarksPanel
            theme={theme}
            onClose={() => setActivePanel(null)}
            bookmarks={state.bookmarks}
            onJump={(ch) => {
              onChapterChange(ch);
              setActivePanel(null);
            }}
            onDelete={onDeleteBookmark}
          />
        )}
        {activePanel === "highlights" && (
          <HighlightsPanel
            theme={theme}
            themeKey={themeKey}
            onClose={() => setActivePanel(null)}
            highlights={state.highlights}
          />
        )}

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            position: "relative",
            minWidth: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: "60px 80px 30px",
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
              columns={2}
              rtl={t.rtl}
              maxWidth={900}
            />
          </div>

          <div
            style={{
              padding: "14px 80px 22px",
              display: "flex",
              alignItems: "center",
              gap: 16,
              color: theme.muted,
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            <button
              onClick={prevChapter}
              disabled={currentChapter === 0}
              aria-label="Previous chapter"
              style={{
                ...chromeBtn(theme),
                width: 28,
                height: 28,
                opacity: currentChapter === 0 ? 0.35 : 1,
                cursor: currentChapter === 0 ? "not-allowed" : "pointer",
              }}
            >
              <Icon name="arrowL" size={14} />
            </button>
            <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 32 }}>
              {pct}%
            </span>
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
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  background: theme.ink,
                  boxShadow: `0 0 0 3px ${theme.bg}`,
                }}
              />
            </div>
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                maxWidth: 200,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {chapter.title}
            </span>
            <button
              onClick={nextChapter}
              disabled={currentChapter >= chapterCount - 1}
              aria-label="Next chapter"
              style={{
                ...chromeBtn(theme),
                width: 28,
                height: 28,
                opacity: currentChapter >= chapterCount - 1 ? 0.35 : 1,
                cursor:
                  currentChapter >= chapterCount - 1 ? "not-allowed" : "pointer",
              }}
            >
              <Icon name="arrowR" size={14} />
            </button>
          </div>
        </div>

        {activePanel === "settings" && (
          <SettingsPanel
            theme={theme}
            themeKey={themeKey}
            t={t}
            setTweak={setTweak}
            onClose={() => setActivePanel(null)}
          />
        )}
        {activePanel === "progress" && (
          <div
            style={{
              width: 380,
              borderLeft: `0.5px solid ${theme.rule}`,
              background: theme.bg,
              padding: 24,
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
              flexShrink: 0,
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
    </div>
  );
}
