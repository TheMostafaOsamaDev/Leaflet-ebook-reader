import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "./Icon";
import { BookBody } from "./BookBody";
import { SelectionPopover } from "./SelectionPopover";
import type { EpubBook } from "../epub/types";
import type { BookState, Highlight } from "../store/library";
import type { HighlightColor } from "../styles/tokens";
import {
  resolveSelectionAnchor,
  type SelectionAnchor,
} from "../lib/selectionAnchor";
import {
  FONT_STACKS,
  isArabicTitle,
  titleFontFor,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";
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
  /** Paragraph to scroll to when the chapter mounts. Read once per chapter
      change; live scroll position is owned by the reader itself. */
  resumeParagraph: number;
  onChapterChange: (order: number) => void;
  onParagraphChange: (idx: number) => void;
  onCreateHighlight: (input: {
    chapter: number;
    paragraphIndex: number;
    charStart: number;
    charEnd: number;
    text: string;
    color: HighlightColor;
    note?: string;
  }) => void;
  onDeleteHighlight: (id: string) => void;
  onUpdateHighlightNote: (id: string, note: string) => void;
  onJumpToHighlight: (h: Highlight) => void;
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
  resumeParagraph,
  onChapterChange,
  onParagraphChange,
  onCreateHighlight,
  onDeleteHighlight,
  onUpdateHighlightNote,
  onJumpToHighlight,
  activePanel,
  setActivePanel,
  onBack,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stash the latest resumeParagraph in a ref so the chapter-change effect
  // can read it without re-running on every paragraph save.
  const resumeRef = useRef(resumeParagraph);
  resumeRef.current = resumeParagraph;
  // Same trick for onParagraphChange — keeps the scroll listener stable.
  const onParagraphChangeRef = useRef(onParagraphChange);
  onParagraphChangeRef.current = onParagraphChange;
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

  // Scroll to the resume paragraph whenever the chapter changes. Runs
  // once per chapter mount; later live scrolling doesn't trigger this
  // because resumeParagraph isn't in the deps.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>(
      `[data-p-index="${resumeRef.current}"]`,
    );
    if (target) {
      el.scrollTop = target.offsetTop;
    } else {
      el.scrollTop = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, book.id]);

  // Throttled scroll listener — find the topmost-visible paragraph and
  // bubble its index up to the App state for persistence.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let queued = false;
    const handler = () => {
      if (queued) return;
      queued = true;
      window.setTimeout(() => {
        queued = false;
        const ps = el.querySelectorAll<HTMLElement>("[data-p-index]");
        if (ps.length === 0) return;
        const containerTop = el.getBoundingClientRect().top;
        let best = 0;
        for (const p of ps) {
          const offset = p.getBoundingClientRect().top - containerTop;
          if (offset > 8) break;
          best = Number(p.dataset.pIndex);
        }
        onParagraphChangeRef.current(best);
      }, 250);
    };
    el.addEventListener("scroll", handler, { passive: true });
    return () => el.removeEventListener("scroll", handler);
  }, []);

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

  // Chapter ticks on the bottom progress bar — skip current position so
  // the scrubber sits cleanly on top.
  const ticks =
    chapterCount > 1
      ? Array.from({ length: chapterCount - 1 }, (_, i) => (i + 1) / chapterCount)
      : [];

  // Selection-driven highlight popover. We resolve the selection on
  // mouseup (after the browser has finalized it) and again on
  // selectionchange (so keyboard-driven extends update the anchor in
  // place). Dismiss when the selection collapses.
  const [selAnchor, setSelAnchor] = useState<SelectionAnchor | null>(null);
  useEffect(() => {
    const refresh = () => {
      const next = resolveSelectionAnchor();
      setSelAnchor((prev) => {
        if (!next) return null;
        if (
          prev &&
          prev.paragraphIndex === next.paragraphIndex &&
          prev.charStart === next.charStart &&
          prev.charEnd === next.charEnd
        ) {
          return prev;
        }
        return next;
      });
    };
    const onMouseUp = () => window.setTimeout(refresh, 0);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", refresh);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", refresh);
    };
  }, []);
  const dismissSelection = () => {
    setSelAnchor(null);
    window.getSelection()?.removeAllRanges();
  };
  const createFromSelection = (color: HighlightColor, note?: string) => {
    if (!selAnchor) return;
    onCreateHighlight({
      chapter: currentChapter,
      paragraphIndex: selAnchor.paragraphIndex,
      charStart: selAnchor.charStart,
      charEnd: selAnchor.charEnd,
      text: selAnchor.text,
      color,
      note: note?.trim() || undefined,
    });
    dismissSelection();
  };

  // Click + drag the bottom progress bar to scrub through chapters.
  // Pointer capture keeps drag alive after the cursor leaves the track.
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const chapterFromClientX = (clientX: number): number | null => {
    const el = trackRef.current;
    if (!el || chapterCount === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null;
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width),
    );
    return Math.min(chapterCount - 1, Math.floor(ratio * chapterCount));
  };
  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDragging(true);
    const next = chapterFromClientX(e.clientX);
    if (next !== null && next !== currentChapter) onChapterChange(next);
  };
  const onTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const next = chapterFromClientX(e.clientX);
    if (next !== null && next !== currentChapter) onChapterChange(next);
  };
  const onTrackPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      // Force LTR on the reader chrome regardless of the user's RTL
      // preference — only BookBody flips. Belt-and-suspenders with the
      // App-level `dir="ltr"` so a stray nested dir cascade can't reach
      // the header, panels, or bottom progress bar.
      dir="ltr"
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: FONT_STACKS.sans,
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
            title={chapter.title}
            style={{
              // Arabic / mixed titles render in Readex Pro (via the sans
              // stack) so digits and Latin punctuation interleaved with
              // Arabic share the same family. Suppress italic on Arabic
              // — Readex Pro doesn't ship an italic, and synthetic
              // italic on Arabic looks broken.
              fontFamily: titleFontFor(chapter.title),
              fontSize: 13,
              // Explicit line-height — Readex Pro's Arabic glyphs need
              // more vertical room than Fraunces' Latin, and without it
              // `overflow: hidden` (needed for the ellipsis) clips the
              // ascenders/descenders.
              lineHeight: 1.55,
              fontStyle: isArabicTitle(chapter.title) ? "normal" : "italic",
              fontWeight: 500,
              color: theme.ink,
              letterSpacing: "-0.01em",
              width: "100%",
              textAlign: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {chapter.title}
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
        {activePanel === "highlights" && (
          <HighlightsPanel
            theme={theme}
            themeKey={themeKey}
            onClose={() => setActivePanel(null)}
            highlights={state.highlights}
            onJump={(h) => {
              onJumpToHighlight(h);
              setActivePanel(null);
            }}
            onDelete={onDeleteHighlight}
            onUpdateNote={onUpdateHighlightNote}
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
            ref={scrollRef}
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
              themeKey={themeKey}
              fontFamily={t.fontFamily}
              fontSize={t.fontSize}
              lineHeight={t.lineHeight}
              letterSpacing={t.letterSpacing}
              textAlign={t.textAlign}
              columns={t.columns}
              rtl={t.rtl}
              maxWidth={t.pageWidth}
              highlights={state.highlights}
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
            <div
              role="slider"
              aria-label="Chapter"
              aria-valuemin={1}
              aria-valuemax={Math.max(1, chapterCount)}
              aria-valuenow={currentChapter + 1}
              aria-valuetext={chapter.title}
              onPointerDown={onTrackPointerDown}
              onPointerMove={onTrackPointerMove}
              onPointerUp={onTrackPointerUp}
              onPointerCancel={onTrackPointerUp}
              style={{
                flex: 1,
                height: 22,
                display: "flex",
                alignItems: "center",
                cursor: dragging ? "grabbing" : "pointer",
                // Stop the browser from interpreting horizontal pointer
                // moves as scroll/zoom while we're scrubbing.
                touchAction: "none",
                userSelect: "none",
              }}
            >
              <div
                ref={trackRef}
                style={{ position: "relative", width: "100%", height: 3 }}
              >
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
                    transform: `translate(-50%, -50%) scale(${dragging ? 1.25 : 1})`,
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    background: theme.ink,
                    boxShadow: `0 0 0 3px ${theme.bg}`,
                    transition: "transform 120ms ease",
                  }}
                />
              </div>
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
      {selAnchor && (
        <SelectionPopover
          theme={theme}
          anchor={selAnchor.rect}
          onPick={(color) => createFromSelection(color)}
          onAddNote={(color, note) => createFromSelection(color, note)}
          onDismiss={dismissSelection}
        />
      )}
    </div>
  );
}
