// The shared reader shell for fixed-layout books (PDF / DOCX): the same chrome
// + panels as the EPUB readers (Contents / Bookmarks / Progress / Settings via
// PanelShell, the shared SettingsSection primitives), with a FixedPageViewer in
// the center instead of reflowable text. Only the center differs by format; the
// shell is identical. The page source is created via a `createSource` factory
// so this component is agnostic to how the pages were loaded.
//
// Panel presentation matches the EPUB readers exactly: desktop slides a
// SideSheet in over the viewer, mobile raises the same MobileSheet bottom
// sheet the reflow reader uses (drag handle, snap points, drag-to-dismiss).
// Both readers therefore share one panel surface AND one settings body
// (panels/SettingsPanel.tsx) — see its `variant` prop.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ACCENT,
  FONT_SERIF_DISPLAY,
  titleFontFor,
  type HighlightColor,
  type Theme,
  type ThemeKey,
} from "../../styles/tokens";
import { useReducedMotion } from "../../styles/motion";
import type { Tweaks, TocEntry } from "../../types/reader";
import type {
  BookState,
  DocxHighlightAnchor,
  FixedBook,
  Highlight,
  PdfHighlightAnchor,
} from "../../store/library";
import type { FixedPageSource } from "./FixedPageSource";
import {
  FixedPageViewer,
  type FixedPageViewerHandle,
  type FixedSelection,
} from "./FixedPageViewer";
import { PanelShell } from "../../panels/PanelShell";
import { HighlightsPanel } from "../../panels/HighlightsPanel";
import { SelectionPopover } from "../../components/SelectionPopover";
import { HighlightActionPopover } from "../../components/HighlightActionPopover";
import { copyText } from "../../lib/clipboard";
import { SideSheet } from "../../components/SideSheet";
import { MobileSheet } from "../../components/MobileSheet";
import { ReaderTopBar } from "../chrome/ReaderTopBar";
import { ReaderProgressBar } from "../chrome/ReaderProgressBar";
import { ReaderTabBar } from "../chrome/ReaderTabBar";
import { ReaderIconButton } from "../chrome/ReaderIconButton";
import { SettingsPanel } from "../../panels/SettingsPanel";
import {
  CHROME_INSET_BOTTOM,
  CHROME_INSET_TOP,
  FocusHint,
  useFocusChrome,
} from "../chrome/focusChrome";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { DOCK_QUERY, DOCK_WIDTH, shouldDockContents } from "../chrome/dockContents";
import { useI18n } from "../../i18n/useI18n";
import { formatNum } from "../../i18n";

type SetTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
type Panel = null | "toc" | "highlights" | "progress" | "settings";

/** A highlight the fixed reader asks App to persist: colour + note + the
 *  fixed-layout anchor. App fills the unused reflow fields (chapter/paragraph/
 *  char) with 0. */
export interface NewFixedHighlight {
  text: string;
  color: HighlightColor;
  note?: string;
  groupId?: string;
  fixed: DocxHighlightAnchor | PdfHighlightAnchor;
}

export interface FixedPageReaderProps {
  theme: Theme;
  themeKey: ThemeKey;
  t: Tweaks;
  setTweak: SetTweak;
  book: FixedBook;
  state: BookState;
  /** This book's highlights (fixed-layout, carrying a `fixed` anchor). */
  highlights: Highlight[];
  onCreateHighlight: (h: NewFixedHighlight) => void;
  onDeleteHighlight: (highlightId: string) => void;
  onUpdateHighlightNote: (highlightId: string, note: string) => void;
  layout: "mobile" | "desktop";
  /** Chrome (UI) direction — follows the app language. */
  uiDir: "ltr" | "rtl";
  /** Build the page source (PDF from disk, DOCX from disk, or bytes in tests). */
  createSource: () => Promise<FixedPageSource>;
  /** Persist the reading position (debounced upstream in App). `pageCount` is
   *  the source's total — needed for docx, whose count is only known after
   *  pagination at read time. */
  onLocationChange?: (page: number, pageOffset: number, pageCount: number) => void;
  onOpenFullSettings?: () => void;
  onBack: () => void;
}

export function FixedPageReader(props: FixedPageReaderProps) {
  const {
    theme,
    themeKey,
    t,
    setTweak,
    book,
    state,
    highlights,
    onCreateHighlight,
    onDeleteHighlight,
    onUpdateHighlightNote,
    layout,
    uiDir,
    createSource,
    onLocationChange,
    onOpenFullSettings,
    onBack,
  } = props;
  const { tr, locale } = useI18n();
  const reduced = useReducedMotion();
  const isMobile = layout === "mobile";

  const [source, setSource] = useState<FixedPageSource | null>(null);
  const [panel, setPanel] = useState<Panel>(null);

  // Contents docks beside the page rather than covering it, on exactly the
  // same rule the reflowable reader uses — see reader/chrome/dockContents.ts.
  // The two readers disagreeing about this is what got docking removed the
  // last time round, so neither of them owns the rule any more.
  const roomToDock = useMediaQuery(DOCK_QUERY);
  const tocDocked = !isMobile && shouldDockContents(panel, roomToDock);
  // Same affordance the EPUB reader has: the scrubber can be folded away when
  // you want the page and nothing else.
  const [showProgress, setShowProgress] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [progress, setProgress] = useState<{ page: number; fraction: number; label: string }>(
    () => ({ page: state.currentPage ?? 0, fraction: 0, label: "" }),
  );
  const viewerRef = useRef<FixedPageViewerHandle>(null);

  // Highlighting popovers: `sel` drives the create-color popover after a text
  // selection; `activeHl` drives the edit/delete popover after clicking a mark.
  const [sel, setSel] = useState<FixedSelection | null>(null);
  const [activeHl, setActiveHl] = useState<{ id: string; rect: DOMRect } | null>(null);

  const createFromSelection = (color: HighlightColor, note?: string) => {
    if (!sel) return;
    // The anchor follows the format the selection came from. A DOCX page is
    // real text, so it anchors to a block and a char range; a PDF page is a
    // bitmap, so it anchors to the page plus the rectangles the selection
    // covered, normalized to the page box.
    onCreateHighlight({
      text: sel.text,
      color,
      note,
      fixed:
        sel.kind === "pdf"
          ? { fmt: "pdf", page: sel.page, rects: sel.rects }
          : {
              fmt: "docx",
              blockId: sel.blockId,
              charStart: sel.charStart,
              charEnd: sel.charEnd,
            },
    });
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  // ── Focus mode ────────────────────────────────────────────────────────────
  // The same affordance the reflow reader has, off the same persisted tweak —
  // see reader/chrome/focusChrome.tsx. Desktop only: the reveal is driven by
  // pointer proximity, and a phone has no pointer to track. On a phone the tab
  // bar is the reader's way back to everything, so hiding it would strand them.
  const focus = useFocusChrome({
    active: t.focusMode,
    setActive: (next) => setTweak("focusMode", next),
    panelOpen: panel !== null,
    closePanels: () => setPanel(null),
    theme,
    reducedMotion: reduced,
    enabled: !isMobile,
    // A docked Contents panel keeps the floating bars off its own header.
    dockInset: tocDocked ? DOCK_WIDTH : 0,
  });
  const glassBottom = focus.glass("bottom");

  // How much room the two floating bars take, for the page area to inset
  // itself by. Unlike the reflow reader — where text simply scrolls under the
  // bars — a fitted page has to sit BETWEEN them: at `fit: "page"` the sheet
  // is sized to the space it is given, so anything not reserved here is page
  // that ends up behind a bar with no way to scroll it out.
  //
  // The top bar's own padding carries `env(safe-area-inset-top)`, so this
  // does too — an Android tablet in landscape reports `isMobile === false`
  // and runs this reader's desktop branch with a real notch (see App.tsx).
  const padTop = `calc(${CHROME_INSET_TOP}px + env(safe-area-inset-top, 0px))`;
  // The phone's bottom bar stacks: 8px of its own padding, the scrubber row
  // when it is showing (a 44px track plus its 6px tail), the 44px tab row,
  // then 6px above the gesture bar. Desktop shows the scrubber alone.
  const padBottom = isMobile
    ? `calc(${8 + (showProgress ? 50 : 0) + 44 + 6}px + env(safe-area-inset-bottom, 0px))`
    : `${CHROME_INSET_BOTTOM}px`;
  // Where the floating bars sit relative to an open panel, which differs by
  // platform because the panels do. Desktop keeps `pin`'s default 45, above
  // SideSheet's scrim — that is what leaves a revealed bar undimmed with its
  // buttons still clickable. A phone raises MobileSheet (zIndex 20) instead,
  // which is meant to cover the chrome the way it does in the reflow reader
  // (whose bars sit at 10), so the bars go under it.
  const barLayer = isMobile ? { zIndex: 10 } : null;

  // Content/page-flip direction: DOCX carries its own; PDF follows the UI.
  const contentDir = book.kind === "docx" ? book.dir : uiDir;

  // Create + own the page source lifecycle.
  useEffect(() => {
    let live = true;
    let created: FixedPageSource | null = null;
    void createSource().then((s) => {
      if (!live) {
        s.destroy();
        return;
      }
      created = s;
      setSource(s);
    });
    return () => {
      live = false;
      created?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  const fmt = useCallback(
    (n: number) => formatNum(n, locale),
    [locale],
  );
  const formatCounter = useCallback(
    (page1: number, total: number) => `${fmt(page1)} / ${fmt(total)}`,
    [fmt],
  );

  const resume = useMemo(
    () => ({ page: state.currentPage ?? 0, pageOffset: state.pageOffset ?? 0 }),
    [state.currentPage, state.pageOffset],
  );

  const openPanel = (p: Exclude<Panel, null>) =>
    setPanel((cur) => (cur === p ? null : p));
  const closePanel = () => setPanel(null);

  const jumpToPage = (page: number) => {
    viewerRef.current?.goToPage(page);
    closePanel();
  };

  // Jump to a highlight's page: PDF highlights carry their page directly; DOCX
  // highlights resolve their block id to whatever page it currently sits on.
  const jumpToFixedHighlight = (h: Highlight) => {
    if (!h.fixed) return;
    const page =
      h.fixed.fmt === "pdf" ? h.fixed.page : source?.pageForBlock?.(h.fixed.blockId);
    if (page != null) jumpToPage(page);
  };

  // Logical edge a desktop panel's border faces: navigation panels lead,
  // tool panels trail (SideSheet / PanelShell handle the RTL flip). On mobile
  // there is no edge — the bottom sheet renders its own rounded chrome
  // edge-to-edge — so panels get `side: undefined` and a fluid width, exactly
  // as MobileReader passes them.
  const panelSide = (p: Panel): "left" | "right" | undefined =>
    isMobile ? undefined : p === "settings" || p === "progress" ? "right" : "left";

  // Body for the currently-open panel, reused by the desktop SideSheet and the
  // mobile bottom sheet so the panel content lives in exactly one place.
  const renderPanelBody = () => {
    const side = panelSide(panel);
    // Phone widths vary (360-430px+); the desktop 340px column would leave
    // dead space beside the sheet.
    const width = isMobile ? "100%" : undefined;
    switch (panel) {
      case "toc":
        return (
          <OutlinePanel
            theme={theme}
            outline={source ? source.outline : []}
            title={book.title}
            current={progress.page}
            onJump={jumpToPage}
            onClose={closePanel}
            side={side}
            width={width}
          />
        );
      case "highlights":
        return (
          <HighlightsPanel
            theme={theme}
            themeKey={themeKey}
            onClose={closePanel}
            highlights={highlights}
            onJump={jumpToFixedHighlight}
            onDelete={onDeleteHighlight}
            onUpdateNote={onUpdateHighlightNote}
            side={side}
            width={width}
          />
        );
      case "progress":
        return (
          <PanelShell
            theme={theme}
            title={tr("reader.readingProgress")}
            onClose={closePanel}
            side={side}
            width={width}
          >
            <PageProgressBody
              theme={theme}
              page={progress.page}
              total={sourcePageCount(source)}
              fmt={fmt}
              isAr={locale === "ar"}
            />
          </PanelShell>
        );
      case "settings":
        // Same component the reflow readers render — only the control set
        // differs (`variant="fixed"`), so the shell, language row, theme row
        // and "All settings" footer stay identical across formats.
        return (
          <SettingsPanel
            variant="fixed"
            theme={theme}
            themeKey={themeKey}
            t={t}
            setTweak={setTweak}
            onClose={closePanel}
            side={side}
            width={width}
            mobile={isMobile}
            zoom={zoom}
            onZoomChange={setZoom}
            onOpenFullSettings={onOpenFullSettings}
          />
        );
      default:
        return null;
    }
  };

  const panelLabel =
    panel === "toc"
      ? tr("reader.toc")
      : panel === "highlights"
        ? tr("reader.highlights")
        : panel === "progress"
          ? tr("reader.readingProgress")
          : panel === "settings"
            ? tr("reader.readingSettings")
            : undefined;

  const title = book.title || tr("common.untitled");
  const total = sourcePageCount(source);
  const pageCounterFor = useCallback(
    (page: number) =>
      locale === "ar"
        ? `صفحة ${fmt(page + 1)} من ${fmt(total)}`
        : `Page ${page + 1} of ${total}`,
    [locale, fmt, total],
  );
  const pageCounter = pageCounterFor(progress.page);

  // The progress bar runs on its own fraction, not `progress.fraction`.
  //
  // The viewer reports (page + 1) / pageCount, which is the right shape for the
  // top bar's fill but is NOT invertible: feeding it back through a seek lands
  // a page late. The bar needs a position it can round-trip — page 0 at the
  // start, the last page at the end — so that the counter under a dragged
  // handle names the page the release will actually go to.
  const pageAt = useCallback(
    (f: number) => Math.min(total - 1, Math.max(0, Math.round(f * Math.max(0, total - 1)))),
    [total],
  );
  const barFraction = total > 1 ? progress.page / (total - 1) : 0;
  // Landmarks come from the file's own outline. Top level only — a deep PDF
  // outline would stipple the whole track and say nothing.
  const barTicks = useMemo(() => {
    if (!source || total <= 1) return [];
    return source.outline
      .filter((e) => e.level === 0 && e.dest.fmt === "page")
      .map((e) => (e.dest as { page: number }).page / (total - 1))
      .filter((f) => f > 0 && f < 1);
  }, [source, total]);

  const progressBar = (
    <ReaderProgressBar
      theme={theme}
      rtl={uiDir === "rtl"}
      fraction={barFraction}
      formatPct={(f) => `${fmt(Math.round(f * 100))}%`}
      formatLabel={(f) => pageCounterFor(pageAt(f))}
      ticks={barTicks}
      prevLabel={locale === "ar" ? "الصفحة السابقة" : "Previous page"}
      nextLabel={locale === "ar" ? "الصفحة التالية" : "Next page"}
      onPrev={() => viewerRef.current?.goToPage(Math.max(0, progress.page - 1))}
      onNext={() =>
        viewerRef.current?.goToPage(Math.min(total - 1, progress.page + 1))
      }
      prevDisabled={progress.page <= 0}
      nextDisabled={progress.page >= total - 1}
      // No `onScrub`: rasterising every page the finger sweeps past would
      // thrash the renderer for pages nobody looks at. The handle and the
      // counter preview the target; release commits the one jump.
      onSeek={(f) => viewerRef.current?.goToPage(pageAt(f))}
      ariaLabel={tr("reader.readingProgress")}
      valueMin={1}
      valueMax={Math.max(1, total)}
      valueNow={progress.page + 1}
      valueText={progress.label || pageCounter}
      reducedMotion={reduced}
      labelWidth={isMobile ? 0 : 200}
      padding={isMobile ? "0 6px 6px" : "6px 80px 14px"}
    />
  );

  return (
    <div
      dir={uiDir}
      // Pointer proximity summons a hidden bar; leaving the window retires both.
      {...focus.rootHandlers}
      style={{
        position: "absolute",
        inset: 0,
        background: theme.bg,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* top chrome — shared with the reflow reader. It floats over the page
          in both modes so it reads like the phone reader's; focus mode adds
          the clip window that lets it slide away, out of focus mode it is
          simply pinned. The page area insets itself by `padTop` either way. */}
      <div
        style={
          focus.floating
            ? focus.clip("top", focus.showTop)
            : { ...focus.pin("top"), ...barLayer }
        }
      >
        <div
          style={focus.floating ? focus.slide("top", focus.showTop) : undefined}
        >
      <ReaderTopBar
        theme={theme}
        onBack={onBack}
        backLabel={tr("common.back")}
        title={title}
        subtitle={pageCounter}
        titleStyle={{ fontFamily: titleFontFor(title) }}
        progressFraction={progress.fraction}
        fillRtl={contentDir === "rtl"}
        navButtons={
          isMobile ? undefined : (
          <>
            <ReaderIconButton
              theme={theme}
              icon="list"
              label={tr("reader.toc")}
              onClick={() => openPanel("toc")}
              active={panel === "toc"}
            />
            <ReaderIconButton
              theme={theme}
              icon="highlight"
              label={tr("reader.highlights")}
              onClick={() => openPanel("highlights")}
              active={panel === "highlights"}
            />
          </>
          )
        }
        trailing={
          isMobile ? undefined : (
          <>
            <ReaderIconButton
              theme={theme}
              icon="focus"
              label={
                t.focusMode ? tr("reader.exitFocusMode") : tr("reader.focusMode")
              }
              onClick={focus.toggle}
              active={t.focusMode}
            />
            <ReaderIconButton
              theme={theme}
              icon="clock"
              label={tr("reader.readingProgress")}
              onClick={() => openPanel("progress")}
              active={panel === "progress"}
            />
            <ReaderIconButton
              theme={theme}
              icon="type"
              label={tr("settings.title")}
              onClick={() => openPanel("settings")}
              active={panel === "settings"}
            />
          </>
          )
        }
      />
        </div>
      </div>

      {/* Center region — fills the gap between the bars. It is the flex row a
          DOCKED Contents panel joins (the page area shrinks beside it) and the
          positioning context an OVERLAY sheet fills. The sheet comes first so
          a docked panel lands on the leading edge in flow, matching the
          reflowable reader. */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {/* Desktop: panels either dock beside the viewer (Contents) or slide
            in over it. Mobile keeps its own bottom-anchored sheet below. */}
        {!isMobile && (
          <SideSheet
            open={panel !== null}
            onClose={closePanel}
            dock={tocDocked}
            // Same reasoning as the reflow reader: clear of the pinned bars,
            // full height in focus mode where they start hidden.
            chromeInset={
              focus.floating ? undefined : { top: padTop, bottom: padBottom }
            }
            side={panel === "settings" || panel === "progress" ? "right" : "left"}
            label={panelLabel}
          >
            {renderPanelBody()}
          </SideSheet>
        )}

        {/* Positioned context for the viewer's own absolute-inset scroll
            layer, so it fills whatever width is left once Contents has taken
            its strip. */}
        <div
          // MARGINS, not padding. The viewer's scroll layer is `position:
          // absolute; inset: 0`, and an absolutely positioned box resolves its
          // offsets against its containing block's PADDING box — which
          // includes the padding. Padding here therefore left the page
          // full-bleed under both bars (measured: the layer's rect stayed
          // identical to this element's), so at `fit: "page"` the head and
          // foot of every page sat behind a bar with no way to scroll them
          // out. Margins shrink this element's own box instead, which is what
          // the `inset: 0` then lands inside — and the viewer's fit/zoom maths
          // needs no changes, since it measures this container.
          style={{
            flex: 1,
            position: "relative",
            minHeight: 0,
            minWidth: 0,
            marginTop: padTop,
            marginBottom: padBottom,
          }}
        >
          {source ? (
            <FixedPageViewer
              ref={viewerRef}
              source={source}
              flow={t.fixedFlow}
              fit={t.fixedFit}
              zoom={zoom}
              tint={t.fixedPageTint}
              dir={contentDir}
              // Turns follow the gesture that drives them: a sideways swipe on
              // mobile, the wheel on desktop.
              turnAxis={isMobile ? "x" : "y"}
              theme={theme}
              themeKey={themeKey}
              highlights={highlights}
              onSelect={setSel}
              onHighlightClick={(id, rect) => {
                setSel(null);
                setActiveHl({ id, rect });
              }}
              resume={resume}
              reducedMotion={reduced}
              formatCounter={formatCounter}
              onProgress={(p) =>
                setProgress((prev) => {
                  // Take the page the viewer reports; `fraction` is not
                  // invertible (see ReaderProgress.page).
                  const page = p.page ?? prev.page;
                  return prev.label === p.label
                    ? prev
                    : { page, fraction: p.fraction, label: p.label };
                })
              }
              onLocationChange={(page, off) =>
                onLocationChange?.(page, off, source?.pageCount ?? 0)
              }
            />
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                color: theme.muted,
                fontFamily: FONT_SERIF_DISPLAY,
                fontSize: 18,
              }}
            >
              {tr("app.loadingBook")}
            </div>
          )}
        </div>
      </div>

      {/* bottom scrubber — shared with the reflow reader (seeks pages) */}
      {/* Bottom chrome. On a phone the panel tabs live down here with the
          scrubber — the EPUB reader has always put them within thumb reach and
          the fixed-page reader kept its four in the top bar, which is the main
          reason the two formats felt like different readers. Desktop keeps the
          tabs up top, where there is room and no thumb involved. */}
      {isMobile ? (
        <div
          className={glassBottom.className}
          style={{
            ...focus.pin("bottom"),
            ...barLayer,
            ...glassBottom.style,
            color: theme.chromeInk,
            padding: "8px 14px calc(env(safe-area-inset-bottom, 0px) + 6px)",
          }}
        >
          {showProgress && progressBar}
          <ReaderTabBar
            theme={theme}
            active={panel}
            onOpen={openPanel}
            showProgress={showProgress}
            onToggleProgress={() => setShowProgress((v) => !v)}
          />
        </div>
      ) : (
        <div
          style={
            focus.floating
              ? focus.clip("bottom", focus.showBottom)
              : focus.pin("bottom")
          }
        >
          <div
            // The glass sits here, not on ReaderProgressBar: that component is
            // also used inside the phone bar above and in the panels, where it
            // is not the floating surface. `backdrop-filter` has to be on the
            // element carrying the fill, so the two stay together.
            className={glassBottom.className}
            style={{
              ...glassBottom.style,
              ...(focus.floating
                ? focus.slide("bottom", focus.showBottom)
                : null),
            }}
          >
            {progressBar}
          </div>
        </div>
      )}

      {focus.hint > 0 && (
        <FocusHint
          key={focus.hint}
          theme={theme}
          title={tr("reader.focusMode")}
          body={tr("reader.focusHintBody")}
          isAr={uiDir === "rtl"}
        />
      )}

      {/* Mobile panels: the same bottom sheet the reflow reader raises, at the
          same default snap. It stays mounted while it animates out, so `open`
          drives the exit rather than an unmount. Desktop uses the SideSheet
          mounted inside the viewer above. */}
      {isMobile && (
        <MobileSheet
          theme={theme}
          open={panel !== null}
          onClose={closePanel}
          height="82%"
          label={panelLabel}
        >
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {renderPanelBody()}
          </div>
        </MobileSheet>
      )}

      {/* Highlighting popovers. Positioned from viewport-coordinate rects. */}
      {sel && (
        <SelectionPopover
          theme={theme}
          // Fixed pages turn, they don't scroll, so there is nothing
          // for the toolbar to follow — it keeps the rect it opened
          // with. (The reflowable readers pass a live re-measure.)
          anchor={{
            getAnchor: () => sel.rect,
            insets: { top: CHROME_INSET_TOP, bottom: CHROME_INSET_BOTTOM },
          }}
          onPick={(color) => createFromSelection(color)}
          onAddNote={(color, note) => createFromSelection(color, note)}
          onCopy={() => copyText(sel.text)}
          onDismiss={() => setSel(null)}
        />
      )}
      {activeHl &&
        (() => {
          const hl = highlights.find((h) => h.id === activeHl.id);
          return hl ? (
            <HighlightActionPopover
              theme={theme}
              themeKey={themeKey}
              highlight={hl}
              anchor={{
                getAnchor: () => activeHl.rect,
                insets: { top: CHROME_INSET_TOP, bottom: CHROME_INSET_BOTTOM },
              }}
              onDelete={() => {
                onDeleteHighlight(hl.id);
                setActiveHl(null);
              }}
              onUpdateNote={(note) => {
                onUpdateHighlightNote(hl.id, note);
                setActiveHl(null);
              }}
              onDismiss={() => setActiveHl(null)}
            />
          ) : null;
        })()}
    </div>
  );
}

function sourcePageCount(source: FixedPageSource | null): number {
  return source ? source.pageCount : 1;
}

function OutlinePanel({
  theme,
  outline,
  title,
  current,
  onJump,
  onClose,
  side,
  width,
}: {
  theme: Theme;
  outline: TocEntry[];
  title: string;
  current: number;
  onJump: (page: number) => void;
  onClose: () => void;
  side?: "left" | "right";
  width?: number | string;
}) {
  const { tr, locale } = useI18n();
  return (
    <PanelShell
      theme={theme}
      title={tr("reader.toc")}
      subtitle={title || tr("common.untitled")}
      onClose={onClose}
      side={side}
      width={width}
    >
      <div style={{ padding: "8px 6px" }}>
        {outline.length === 0 && (
          <div style={{ padding: "32px 18px", textAlign: "center", color: theme.muted, fontSize: 12.5, lineHeight: 1.5 }}>
            {locale === "ar" ? "لا يحتوي هذا المستند على فهرس." : "This document has no contents."}
          </div>
        )}
        {outline.map((entry, i) => {
          const page = entry.dest.fmt === "page" ? entry.dest.page : 0;
          const active = page === current;
          return (
            <button
              key={i}
              onClick={() => onJump(page)}
              style={{
                width: "100%",
                textAlign: "start",
                border: "none",
                background: active ? theme.hover : "transparent",
                padding: "11px 14px",
                borderRadius: 8,
                cursor: "pointer",
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                color: theme.ink,
                paddingInlineStart: 14 + entry.level * 14,
              }}
            >
              <span
                style={{
                  fontFamily: FONT_SERIF_DISPLAY,
                  fontSize: 14.5,
                  fontStyle: "normal",
                  fontWeight: active ? 500 : 400,
                  color: theme.ink,
                  flex: 1,
                  lineHeight: 1.3,
                }}
              >
                {entry.title}
              </span>
            </button>
          );
        })}
      </div>
    </PanelShell>
  );
}

function PageProgressBody({
  theme,
  page,
  total,
  fmt,
  isAr,
}: {
  theme: Theme;
  page: number;
  total: number;
  fmt: (n: number) => string;
  isAr: boolean;
}) {
  const pct = total > 0 ? Math.round(((page + 1) / total) * 100) : 0;
  return (
    <div style={{ padding: 22, textAlign: "center" }}>
      <div
        style={{
          width: 132,
          height: 132,
          margin: "6px auto 16px",
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: `conic-gradient(${ACCENT} ${pct}%, ${theme.rule} 0)`,
        }}
      >
        <div
          style={{
            width: 104,
            height: 104,
            borderRadius: "50%",
            background: theme.chrome,
            display: "grid",
            placeItems: "center",
            fontSize: 24,
            fontWeight: 700,
            color: theme.ink,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {isAr ? `٪${fmt(pct)}` : `${pct}%`}
        </div>
      </div>
      <div style={{ color: theme.muted, fontSize: 13.5 }}>
        {isAr
          ? `صفحة ${fmt(page + 1)} من ${fmt(total)}`
          : `Page ${fmt(page + 1)} of ${fmt(total)}`}
      </div>
    </div>
  );
}
