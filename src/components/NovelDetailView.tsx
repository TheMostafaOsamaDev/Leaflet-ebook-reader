// One novel's detail page inside the Store.
//
// Layout from top to bottom:
//   - Header: cover + title + original title + status badge + meta (author,
//     translator, year, type, …) + genre chips
//   - Description (collapsed to ~5 lines; "more" expands)
//   - Action row: Read · Add to library · Download range
//   - Volumes accordion — each volume is collapsible; expanded reveals
//     the chapter list. Clicking a chapter opens the streaming reader at
//     that chapter.
//
// All scrape calls go through getSource(sourceId). Errors land in the
// inline error pane; nothing here owns long-running tasks (the importer
// reports through the global progress modal).

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
} from "react";
import { getSource, getSourceMeta } from "../sources/registry";
import {
  addNovelToLibrary,
  deleteBook,
  findSourceEntry,
} from "../store/library";
import {
  looksLikeMissingPlaceholder,
  optimizedCoverUrl,
} from "../sources/images";
import type { Source, SourceChapter, SourceNovel } from "../sources/types";
import type { DownloadJob } from "../store/downloadQueue";
import { MeasuredVirtualList } from "./VirtualList";
import type { SourceSnapshot } from "../store/sourceLibrary";
import { transition } from "../styles/motion";

interface ChapterFlags {
  downloadedAt?: number;
  readAt?: number;
}

/** Build a chapter-id → {downloadedAt, readAt} lookup from a snapshot.
 *  Lets the volumes accordion render per-chapter status with a single
 *  Map.get() per chapter instead of walking volumes each time. */
function buildFlagMap(snapshot: SourceSnapshot): Map<number, ChapterFlags> {
  const out = new Map<number, ChapterFlags>();
  for (const v of snapshot.volumes) {
    for (const c of v.chapters) {
      if (c.downloadedAt || c.readAt) {
        out.set(c.id, {
          ...(c.downloadedAt ? { downloadedAt: c.downloadedAt } : {}),
          ...(c.readAt ? { readAt: c.readAt } : {}),
        });
      }
    }
  }
  return out;
}
import { ACCENT, FONT_SERIF_DISPLAY, FONT_STACKS, type Theme } from "../styles/tokens";
import { useI18n } from "../i18n/useI18n";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Hero } from "./Hero";
import { SourceBadge } from "./SourceBadge";
import { NovelHeaderSkeleton, VolumesSkeleton } from "./Skeleton";
import { SaveAsOfflineBookDialog } from "./SaveAsOfflineBookDialog";
import { AnimatedDialog } from "./AnimatedDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { ShelfChecklist } from "./ShelfChecklist";
import type { Shelf } from "../store/shelves";
import { Toast, type ToastMessage } from "./Toast";
import { useMediaQuery } from "../hooks/useMediaQuery";

/** Debounce window for the in-novel chapter search. Same rationale as
 *  the homepage suggest debounce — fast enough to feel live, slow enough
 *  not to fire per-keystroke. */
const CHAPTER_SEARCH_DEBOUNCE_MS = 250;
const CHAPTER_SEARCH_MIN_CHARS = 1;

interface Props {
  theme: Theme;
  layout: "desktop" | "mobile";
  sourceId: string;
  novelUrl: string;
  /** Library entry id when this view is opened from a shelf card. The
   *  view then loads its metadata + chapter listing from the persisted
   *  source.json (offline-first), and surfaces per-chapter download
   *  icons + read-state dimming wired to the same entry. Undefined
   *  when opened from the Store before the novel is in the library —
   *  the view falls back to a live `source.getNovel` fetch and hides
   *  the offline-only affordances. */
  libraryEntryId?: string;
  onBack: () => void;
  /** Open the streaming reader at this chapter (or the first chapter when
   *  undefined — used by the top-level "Read" action). */
  onStreamRead: (chapterId?: number) => void;
  /** Notifies the parent Library to refresh its shelf after an import
   *  finishes. */
  onImportComplete: () => void;
  onOpenRangeDialog: () => void;
  /** Shelves membership plumbing for the hero "Shelves" action — all
   *  optional so call sites that don't (yet) support shelves, like the
   *  Store's browsing detail view for a novel not in the library, keep
   *  compiling and simply don't render the button. Only rendered together
   *  when the book is in the library AND these are provided. */
  shelves?: Shelf[];
  /** This book's current shelf ids (its `shelfIds`). */
  bookShelfIds?: string[];
  onToggleShelf?: (shelfId: string) => void;
  /** Opens the "new shelf" dialog (rendered by the parent Library). */
  onNewShelfFromDetail?: () => void;
}

interface State {
  loading: boolean;
  error: string | null;
  novel: SourceNovel | null;
}

export function NovelDetailView({
  theme,
  layout,
  sourceId,
  novelUrl,
  libraryEntryId: libraryEntryIdProp,
  onBack,
  onStreamRead,
  onImportComplete,
  onOpenRangeDialog,
  shelves,
  bookShelfIds,
  onToggleShelf,
  onNewShelfFromDetail,
}: Props) {
  const { tr } = useI18n();
  const source = useMemo<Source | null>(() => getSource(sourceId), [sourceId]);
  const [state, setState] = useState<State>({
    loading: true,
    error: null,
    novel: null,
  });
  // Tracks whether this novel is in the library and, if so, the entry's
  // id (so Remove can target it). Null = not in library, undefined =
  // not yet checked (initial mount, before findSourceEntry resolves).
  // When the parent already knows the entry id (Library card open path),
  // we skip the lookup entirely.
  const [libraryEntryId, setLibraryEntryId] = useState<string | null | undefined>(
    libraryEntryIdProp ?? undefined,
  );
  // Persisted chapter flags (downloadedAt, readAt) keyed by chapter id.
  // Refreshed on snapshot load and after a download mutation. Always an
  // empty map when there's no library entry (the Store-side detail
  // view stays free of offline-only affordances).
  const [chapterFlags, setChapterFlags] = useState<
    Map<number, { downloadedAt?: number; readAt?: number }>
  >(new Map());
  const [working, setWorking] = useState(false);
  // "Save as offline book" dialog is only relevant for in-library
  // source-backed entries (it walks the persisted snapshot). Mounted
  // here so its data load can coexist with NovelDetailView's
  // background snapshot refresh without prop drilling.
  const [saveOfflineOpen, setSaveOfflineOpen] = useState(false);
  const [showFullDesc, setShowFullDesc] = useState(false);
  // "Shelves" checklist popover — only ever opened when the hero button
  // that triggers it is rendered, which itself requires `libraryEntryId`,
  // `shelves`, and `onToggleShelf` (see the `onOpenShelfList` guard below).
  const [shelfListOpen, setShelfListOpen] = useState(false);

  // Two data sources, selected by `libraryEntryIdProp`:
  //   - in-library:  read source.json from disk, then refresh from
  //                  network in the background so the user sees newly
  //                  published chapters next time they reopen.
  //   - not yet:     direct source.getNovel call (existing flow).
  //
  // The local-first path swaps the chapter listing in-place on refresh
  // success — chapter flags are preserved because writeSnapshotFromSourceNovel
  // merges by URL.
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setState({ loading: true, error: null, novel: null });
    setChapterFlags(new Map());

    const fetchFromSource = async () => {
      const novel = await source.getNovel(novelUrl);
      if (cancelled) return;
      if (libraryEntryIdProp) {
        // Library-backed: write the snapshot first so the merge
        // carries forward any chapters loaded by `loadVolume` after
        // the initial snapshot read, THEN render from the merged
        // snapshot. The naive `setState({novel})` would replace the
        // in-memory state with the bare getNovel result (empty
        // volumes for lazy sources), wiping the chapters the user
        // just lazy-loaded — that's the "stuck skeleton" bug.
        const { writeSnapshotFromSourceNovel, snapshotToSourceNovel } =
          await import("../store/sourceLibrary");
        const snap = await writeSnapshotFromSourceNovel(
          libraryEntryIdProp,
          sourceId,
          novelUrl,
          novel,
        );
        if (cancelled) return;
        setState({
          loading: false,
          error: null,
          novel: snapshotToSourceNovel(snap),
        });
        setChapterFlags(buildFlagMap(snap));
      } else {
        setState({ loading: false, error: null, novel });
      }
    };

    (async () => {
      try {
        if (libraryEntryIdProp) {
          const { readSnapshot, snapshotToSourceNovel } = await import(
            "../store/sourceLibrary"
          );
          const snap = await readSnapshot(libraryEntryIdProp);
          if (snap && !cancelled) {
            setState({
              loading: false,
              error: null,
              novel: snapshotToSourceNovel(snap),
            });
            setChapterFlags(buildFlagMap(snap));
            // Refresh from network in the background; failure is
            // silent — the local copy stays visible.
            fetchFromSource().catch(() => {});
            return;
          }
          // No snapshot on disk yet — fall through to a normal fetch
          // and writeSnapshot.
        }
        await fetchFromSource();
      } catch (e) {
        if (cancelled) return;
        setState({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          novel: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, novelUrl, sourceId, libraryEntryIdProp]);

  // Look up whether this novel is already in the library. Skipped when
  // the parent passed `libraryEntryIdProp` (Library card open path);
  // the lookup is only for the Store-side detail view where we
  // didn't navigate from a shelf card.
  useEffect(() => {
    if (libraryEntryIdProp !== undefined) {
      setLibraryEntryId(libraryEntryIdProp);
      return;
    }
    let cancelled = false;
    (async () => {
      const entry = await findSourceEntry(sourceId, novelUrl);
      if (cancelled) return;
      setLibraryEntryId(entry?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, novelUrl, libraryEntryIdProp]);

  // Stable identity: it's threaded down to every memoized ChapterRow, and an
  // inline arrow here would defeat the memo on each parent re-render.
  const openChapter = useCallback(
    (chapterId: number) => onStreamRead(chapterId),
    [onStreamRead],
  );

  const onAddToLibrary = useCallback(async () => {
    if (working) return;
    setWorking(true);
    try {
      const entry = await addNovelToLibrary(sourceId, novelUrl);
      setLibraryEntryId(entry.id);
      onImportComplete();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("addNovelToLibrary failed:", e);
    } finally {
      setWorking(false);
    }
  }, [working, sourceId, novelUrl, onImportComplete]);

  const onRemoveFromLibrary = useCallback(async () => {
    if (working || !libraryEntryId) return;
    if (!confirm(tr("novel.removeConfirm"))) {
      return;
    }
    setWorking(true);
    try {
      await deleteBook(libraryEntryId);
      setLibraryEntryId(null);
      onImportComplete();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("deleteBook failed:", e);
    } finally {
      setWorking(false);
    }
  }, [working, libraryEntryId, onImportComplete, tr]);

  if (!source) {
    return (
      <div style={{ padding: 40, color: theme.muted }}>
        {tr("store.notInstalled", { sourceId })}
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        fontFamily: FONT_STACKS.sans,
        color: theme.ink,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: layout === "mobile" ? "14px 18px 8px" : "18px 40px 8px",
        }}
      >
        <button
          onClick={onBack}
          aria-label={tr("common.back")}
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            border: `0.5px solid ${theme.rule}`,
            background: theme.bg,
            color: theme.ink,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name="arrowL" size={16} className="rtl-flip-x" />
        </button>
      </div>

      {state.loading ? (
        <>
          <NovelHeaderSkeleton theme={theme} layout={layout} />
          <VolumesSkeleton theme={theme} layout={layout} />
        </>
      ) : state.error || !state.novel ? (
        <div
          style={{
            margin: 32,
            padding: 24,
            background: "rgba(180,60,60,0.10)",
            border: "0.5px solid rgba(180,60,60,0.4)",
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          {tr("novel.loadError", {
            error: state.error ?? tr("novel.noDataReturned"),
          })}
        </div>
      ) : (
        <>
          <NovelHero
            theme={theme}
            layout={layout}
            novel={state.novel}
            sourceName={source.meta.name}
            sourceIconUrl={getSourceMeta(source.meta.id)?.iconUrl}
            working={working}
            chapterCount={state.novel.volumes.reduce(
              (a, v) => a + v.chapters.length,
              0,
            )}
            inLibrary={libraryEntryId != null}
            libraryCheckDone={libraryEntryId !== undefined}
            onRead={() => onStreamRead(undefined)}
            onAddToLibrary={onAddToLibrary}
            onRemoveFromLibrary={onRemoveFromLibrary}
            onOpenRangeDialog={onOpenRangeDialog}
            onOpenSaveOffline={
              libraryEntryId ? () => setSaveOfflineOpen(true) : undefined
            }
            onOpenShelfList={
              libraryEntryId != null && shelves && onToggleShelf
                ? () => setShelfListOpen(true)
                : undefined
            }
          />
          {shelfListOpen && shelves && onToggleShelf && (
            <ShelfChecklist
              theme={theme}
              shelves={shelves}
              memberIds={bookShelfIds ?? []}
              onToggle={onToggleShelf}
              onNewShelf={() => {
                setShelfListOpen(false);
                onNewShelfFromDetail?.();
              }}
              onClose={() => setShelfListOpen(false)}
            />
          )}
          <NovelAbout
            theme={theme}
            layout={layout}
            novel={state.novel}
            showFullDesc={showFullDesc}
            setShowFullDesc={setShowFullDesc}
          />
          {saveOfflineOpen && libraryEntryId && state.novel && (
            <SaveAsOfflineBookDialog
              theme={theme}
              layout={layout}
              libraryEntryId={libraryEntryId}
              novelTitle={state.novel.title}
              onCancel={() => setSaveOfflineOpen(false)}
              onEnqueued={() => setSaveOfflineOpen(false)}
            />
          )}
          {typeof source.searchChapters === "function" && (
            <ChapterSearch
              theme={theme}
              layout={layout}
              source={source}
              novel={state.novel}
              novelUrl={novelUrl}
              onOpenChapter={openChapter}
            />
          )}
          <VolumesAccordion
            theme={theme}
            layout={layout}
            source={source}
            novel={state.novel}
            novelUrl={novelUrl}
            libraryEntryId={libraryEntryId ?? undefined}
            chapterFlags={chapterFlags}
            onOpenChapter={openChapter}
            onChapterFlagsChange={setChapterFlags}
            onNovelPatch={(updater) =>
              setState((s) => ({
                ...s,
                novel:
                  typeof updater === "function"
                    ? updater(s.novel)
                    : updater,
              }))
            }
          />
        </>
      )}
    </div>
  );
}

// ── hero (cinematic header) ──────────────────────────────────────────────────

interface NovelHeroProps {
  theme: Theme;
  layout: "desktop" | "mobile";
  novel: SourceNovel;
  sourceName: string;
  sourceIconUrl?: string;
  working: boolean;
  chapterCount: number;
  /** True when the novel is already a library entry — swaps Add for Remove. */
  inLibrary: boolean;
  /** False while the library lookup is in flight — Add/Remove stays disabled
   *  so a fast click can't double-add before we know which to render. */
  libraryCheckDone: boolean;
  onRead: () => void;
  onAddToLibrary: () => void;
  onRemoveFromLibrary: () => void;
  onOpenRangeDialog: () => void;
  /** Only present for in-library, source-backed entries. */
  onOpenSaveOffline?: () => void;
  /** Only present when the book is in the library AND the parent passed
   *  shelf props — opens the ShelfChecklist popover. */
  onOpenShelfList?: () => void;
}

/** The cinematic top of the detail page: the cover blurred into a backdrop,
 *  with the sharp cover, source chip, title, key metadata, a description
 *  teaser, and the primary action cluster overlaid on a dark scrim. Actions
 *  use Button's `surface="onImage"` treatment so they read on the imagery in
 *  any app theme. */
function NovelHero({
  theme,
  layout,
  novel,
  sourceName,
  sourceIconUrl,
  working,
  chapterCount,
  inLibrary,
  libraryCheckDone,
  onRead,
  onAddToLibrary,
  onRemoveFromLibrary,
  onOpenRangeDialog,
  onOpenSaveOffline,
  onOpenShelfList,
}: NovelHeroProps) {
  const { tr } = useI18n();
  const isMobile = layout === "mobile";
  const coverW = isMobile ? 116 : 152;
  const desc = novel.description ?? "";

  // Compact, dot-separated metadata line. Lead with the chapter count (the
  // most useful "how big is this" signal), then the source's own label/value
  // pairs; fall back to the detected author when the source surfaced no meta.
  const metaItems: string[] = [];
  if (chapterCount > 0) {
    metaItems.push(tr("novel.chapterCountShort", { n: chapterCount }));
  }
  if (novel.meta.length > 0) {
    for (const m of novel.meta.slice(0, 4)) {
      const value = m.value?.trim();
      if (!value) continue;
      const label = m.label?.trim();
      metaItems.push(label ? `${label}: ${value}` : value);
    }
  } else if (novel.author && novel.author !== tr("common.unknownAuthor")) {
    metaItems.push(novel.author);
  }

  return (
    <Hero layout={layout} backdropUrl={novel.coverUrl}>
      <div
        style={{
          display: "flex",
          gap: isMobile ? 16 : 26,
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "flex-end",
        }}
      >
        <div
          style={{
            width: coverW,
            flexShrink: 0,
            alignSelf: isMobile ? "flex-start" : "flex-end",
          }}
        >
          <div
            style={{
              width: "100%",
              aspectRatio: "2 / 3",
              borderRadius: 12,
              overflow: "hidden",
              background: "rgba(255,255,255,0.06)",
              border: "0.5px solid rgba(255,255,255,0.16)",
              boxShadow: "0 10px 34px rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {novel.coverUrl ? (
              <NovelCoverImage
                coverUrl={novel.coverUrl}
                size={isMobile ? 400 : 600}
                theme={theme}
              />
            ) : (
              <span style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>
                {tr("novel.noCover")}
              </span>
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ marginBottom: 12 }}>
            <SourceBadge
              theme={theme}
              variant="chip"
              iconUrl={sourceIconUrl}
              name={sourceName}
              label={tr("novel.fromSource", { source: sourceName })}
            />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <h1
              style={{
                fontFamily: FONT_SERIF_DISPLAY,
                fontWeight: 400,
                fontSize: isMobile ? 27 : 36,
                margin: 0,
                letterSpacing: "-0.015em",
                lineHeight: 1.08,
                color: "#ffffff",
                direction: novel.direction,
                textShadow: "0 1px 24px rgba(0,0,0,0.45)",
              }}
            >
              {novel.title || tr("common.untitled")}
            </h1>
            {novel.status && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  background: "rgba(255,255,255,0.16)",
                  border: "0.5px solid rgba(255,255,255,0.28)",
                  color: "#ffffff",
                  padding: "3px 9px",
                  borderRadius: 999,
                  backdropFilter: "blur(6px)",
                  WebkitBackdropFilter: "blur(6px)",
                }}
              >
                {novel.status}
              </span>
            )}
          </div>

          {novel.originalTitle && (
            <div
              style={{
                fontSize: 13.5,
                color: "rgba(255,255,255,0.72)",
                marginTop: 5,
                direction: novel.direction,
              }}
            >
              {novel.originalTitle}
            </div>
          )}

          {metaItems.length > 0 && (
            <div
              style={{
                marginTop: 12,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                fontSize: 12.5,
                color: "rgba(255,255,255,0.82)",
                direction: novel.direction,
              }}
            >
              {metaItems.map((it, i) => (
                <Fragment key={i}>
                  {i > 0 && (
                    <span aria-hidden style={{ margin: "0 9px", opacity: 0.5 }}>
                      ·
                    </span>
                  )}
                  <span>{it}</span>
                </Fragment>
              ))}
            </div>
          )}

          {desc.length > 0 && (
            <p
              style={{
                margin: "14px 0 0 0",
                fontSize: 13.5,
                lineHeight: 1.6,
                color: "rgba(255,255,255,0.86)",
                direction: novel.direction,
                textAlign: "start",
                maxWidth: 640,
                display: "-webkit-box",
                WebkitBoxOrient: "vertical" as const,
                WebkitLineClamp: isMobile ? 3 : 2,
                overflow: "hidden",
              }}
            >
              {desc}
            </p>
          )}

          <div
            style={{
              marginTop: 20,
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
            }}
          >
            <Button
              theme={theme}
              surface="onImage"
              variant="primary"
              shape="pill"
              size="lg"
              onClick={onRead}
              leadingIcon={
                <Icon name="play" size={13} fill="currentColor" stroke={0} />
              }
            >
              {tr("novel.read")}
            </Button>
            {inLibrary ? (
              <Button
                theme={theme}
                surface="onImage"
                variant="outline"
                shape="pill"
                size="lg"
                onClick={onRemoveFromLibrary}
                disabled={working || !libraryCheckDone}
                leadingIcon={<Icon name="trash" size={14} />}
              >
                {working ? tr("novel.removing") : tr("library.removeFromLibrary")}
              </Button>
            ) : (
              <Button
                theme={theme}
                surface="onImage"
                variant="outline"
                shape="pill"
                size="lg"
                onClick={onAddToLibrary}
                disabled={working || !libraryCheckDone}
                leadingIcon={<Icon name="bookmark" size={14} />}
              >
                {working ? tr("novel.adding") : tr("novel.addToLibrary")}
              </Button>
            )}
            {onOpenShelfList && (
              <Button
                theme={theme}
                surface="onImage"
                variant="outline"
                shape="pill"
                size="lg"
                onClick={onOpenShelfList}
                leadingIcon={<Icon name="layers" size={14} />}
              >
                {tr("novel.shelves")}
              </Button>
            )}
            <Button
              theme={theme}
              surface="onImage"
              variant="outline"
              shape="pill"
              size="lg"
              onClick={onOpenRangeDialog}
              disabled={working || chapterCount === 0}
              leadingIcon={<Icon name="slider" size={14} />}
            >
              {tr("novel.downloadRange")}
            </Button>
            {onOpenSaveOffline && (
              <Button
                theme={theme}
                surface="onImage"
                variant="outline"
                shape="pill"
                size="lg"
                onClick={onOpenSaveOffline}
                disabled={working || chapterCount === 0}
                leadingIcon={<Icon name="download" size={14} />}
              >
                {tr("downloads.saveOffline.title")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Hero>
  );
}

// ── about (tags + full description) ──────────────────────────────────────────

interface NovelAboutProps {
  theme: Theme;
  layout: "desktop" | "mobile";
  novel: SourceNovel;
  showFullDesc: boolean;
  setShowFullDesc: (b: boolean) => void;
}

/** The details that sit below the hero: genre/tag chips and the full
 *  synopsis (collapsed past a threshold). The hero shows only a short teaser,
 *  so this is where the reader gets the whole description. */
function NovelAbout({
  theme,
  layout,
  novel,
  showFullDesc,
  setShowFullDesc,
}: NovelAboutProps) {
  const { tr } = useI18n();
  const desc = novel.description ?? "";
  const hasDesc = desc.length > 0;
  const hasTags = novel.tags.length > 0;
  if (!hasDesc && !hasTags) return null;

  const isLongDesc = desc.length > 300;
  const visibleDesc =
    showFullDesc || !isLongDesc ? desc : desc.slice(0, 300) + "…";

  return (
    <div
      style={{
        padding: layout === "mobile" ? "18px 18px 4px" : "26px 40px 4px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {hasTags && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {novel.tags.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 11.5,
                padding: "4px 10px",
                borderRadius: 999,
                border: `0.5px solid ${theme.rule}`,
                color: theme.muted,
                background: theme.chrome,
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {hasDesc && (
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.65,
            color: theme.ink,
            direction: novel.direction,
            textAlign: "start",
          }}
        >
          {visibleDesc}
          {isLongDesc && (
            <button
              onClick={() => setShowFullDesc(!showFullDesc)}
              style={{
                marginInlineStart: 6,
                background: "transparent",
                border: "none",
                color: theme.muted,
                cursor: "pointer",
                fontSize: 12.5,
                textDecoration: "underline",
                fontFamily: "inherit",
                padding: 0,
              }}
            >
              {showFullDesc ? tr("novel.descLess") : tr("novel.descMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Cover with the same thumbnail-first / original-fallback flow the
 *  card uses, sized for the novel-detail header. Bigger `size` than a
 *  card thumbnail since the cover renders larger here. */
function NovelCoverImage({
  coverUrl,
  size,
  theme,
}: {
  coverUrl: string;
  size: number;
  theme: Theme;
}) {
  const { tr } = useI18n();
  const [src, setSrc] = useState(() => optimizedCoverUrl(coverUrl, size));
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span style={{ color: theme.muted, fontSize: 12 }}>
        {tr("novel.noCover")}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={(e) => {
        // Same 200-OK placeholder detection as NovelCard — KolNovel
        // serves a 600×330 landscape "Could not get image" graphic
        // when the requested thumbnail size doesn't exist.
        if (src !== coverUrl && looksLikeMissingPlaceholder(e.currentTarget)) {
          setSrc(coverUrl);
        }
      }}
      onError={() => {
        if (src !== coverUrl) setSrc(coverUrl);
        else setFailed(true);
      }}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}

// ── chapter search ─────────────────────────────────────────────────────────

interface ChapterSearchProps {
  theme: Theme;
  layout: "desktop" | "mobile";
  source: Source;
  novel: SourceNovel;
  novelUrl: string;
  onOpenChapter: (chapterId: number) => void;
}

interface ChapterSearchState {
  loading: boolean;
  error: string | null;
  results: SourceChapter[] | null;
  query: string;
}

/** Live search inside this novel's chapter list. Only rendered when the
 *  source declares `searchChapters` — sites that don't expose a chapter-
 *  search endpoint (KolNovel etc.) just don't show this UI at all.
 *
 *  Source.searchChapters returns chapter stubs identified by URL, not by
 *  the per-session numeric id `getNovel` assigned. We resolve back to
 *  numeric id by URL-matching against the novel's volumes so the existing
 *  `onOpenChapter(id)` flow keeps working. Chapters the search returned
 *  that aren't in our local volume listing (e.g., outside any volume the
 *  user has expanded yet, or hidden by source-side filtering) still
 *  render but are non-clickable — that's strictly better than swallowing
 *  the result. */
function ChapterSearch({
  theme,
  layout,
  source,
  novel,
  novelUrl,
  onOpenChapter,
}: ChapterSearchProps) {
  const { tr } = useI18n();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<ChapterSearchState>({
    loading: false,
    error: null,
    results: null,
    query: "",
  });

  // URL → chapter-id map built once per novel render, lets us resolve a
  // search result back to the numeric id the reader uses for navigation.
  const idByUrl = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of novel.volumes) {
      for (const c of v.chapters) {
        map.set(c.url, c.id);
      }
    }
    return map;
  }, [novel]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < CHAPTER_SEARCH_MIN_CHARS) {
      setState({ loading: false, error: null, results: null, query: "" });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null, query: trimmed }));
    const handle = setTimeout(async () => {
      try {
        const results = await source.searchChapters!(novelUrl, trimmed);
        setState((s) =>
          s.query === trimmed
            ? { loading: false, error: null, results, query: trimmed }
            : s,
        );
      } catch (e) {
        setState((s) =>
          s.query === trimmed
            ? {
                loading: false,
                error: e instanceof Error ? e.message : String(e),
                results: null,
                query: trimmed,
              }
            : s,
        );
      }
    }, CHAPTER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, source, novelUrl]);

  const inSearchMode = state.query.length > 0;

  return (
    <div
      style={{
        padding: layout === "mobile" ? "0 18px" : "0 40px",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: theme.chrome,
          border: `0.5px solid ${theme.rule}`,
          borderRadius: 9,
          padding: "6px 10px",
        }}
      >
        <Icon name="search" size={14} style={{ color: theme.muted }} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tr("novel.searchChaptersPlaceholder")}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            color: theme.ink,
            border: "none",
            outline: "none",
            fontSize: 13,
            fontFamily: "inherit",
            padding: "4px 0",
            direction: novel.direction,
          }}
        />
        {query.length > 0 && (
          <button
            onClick={() => setQuery("")}
            aria-label={tr("novel.clearChapterSearch")}
            style={{
              background: "transparent",
              border: "none",
              color: theme.muted,
              cursor: "pointer",
              padding: 4,
              display: "flex",
              alignItems: "center",
            }}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
      {inSearchMode && (
        <div
          className="riwaq-scroll-hidden"
          style={{
            marginTop: 8,
            border: `0.5px solid ${theme.rule}`,
            borderRadius: 10,
            background: theme.bg,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {state.loading && state.results === null ? (
            <div style={{ padding: 14, color: theme.muted, fontSize: 12.5 }}>
              {tr("novel.searchingChapters")}
            </div>
          ) : state.error ? (
            <div style={{ padding: 14, color: theme.muted, fontSize: 12.5 }}>
              {tr("novel.searchChaptersError", { error: state.error })}
            </div>
          ) : state.results && state.results.length === 0 ? (
            <div style={{ padding: 14, color: theme.muted, fontSize: 12.5 }}>
              {tr("novel.searchChaptersNoMatches", { query: state.query })}
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {(state.results ?? []).map((c) => {
                const id = idByUrl.get(c.url);
                const clickable = id != null;
                return (
                  <li
                    key={c.url}
                    style={{
                      borderBottom: `0.5px solid ${theme.rule}`,
                    }}
                  >
                    <button
                      onClick={() => {
                        if (id != null) onOpenChapter(id);
                      }}
                      disabled={!clickable}
                      style={{
                        width: "100%",
                        textAlign: "start",
                        background: "transparent",
                        border: "none",
                        padding: "10px 14px",
                        color: clickable ? theme.ink : theme.muted,
                        cursor: clickable ? "pointer" : "default",
                        fontFamily: "inherit",
                        fontSize: 12.5,
                        lineHeight: 1.4,
                        direction: novel.direction,
                      }}
                      onMouseEnter={(e) => {
                        if (clickable) {
                          e.currentTarget.style.background = theme.hover;
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      {c.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── lazy-volume skeletons / error ──────────────────────────────────────────

interface VolumeChaptersSkeletonProps {
  theme: Theme;
  rows: number;
}

/** Placeholder rows shown inside an expanded but still-loading lazy
 *  volume. Mirrors the row layout the real chapter list uses (number
 *  on the left, title bar in the middle, trailing space for the
 *  download icon) so the swap-in feels smooth.
 *
 *  Row count is capped at the volume's reported chapterCount when
 *  it's small (so we don't render 459 ghost rows for vol 10 of
 *  Shadow Slave) and clamped to a sane default otherwise. */
function VolumeChaptersSkeleton({ theme, rows }: VolumeChaptersSkeletonProps) {
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: "4px 0 8px",
        borderTop: `0.5px solid ${theme.rule}`,
      }}
    >
      {Array.from({ length: Math.max(3, rows) }).map((_, i) => (
        <li
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px 10px 32px",
          }}
        >
          <span
            style={{
              width: 22,
              height: 9,
              borderRadius: 4,
              background: theme.chrome,
              flexShrink: 0,
              opacity: 0.7,
            }}
          />
          <span
            style={{
              flex: 1,
              height: 11,
              borderRadius: 4,
              background: theme.chrome,
              opacity: 0.5 + Math.random() * 0.2,
            }}
          />
        </li>
      ))}
    </ul>
  );
}

interface VolumeErrorPanelProps {
  theme: Theme;
  message: string;
  onRetry: () => void;
}

function VolumeErrorPanel({ theme, message, onRetry }: VolumeErrorPanelProps) {
  const { tr } = useI18n();
  return (
    <div
      style={{
        padding: "14px 18px",
        borderTop: `0.5px solid ${theme.rule}`,
        background: "rgba(180,60,60,0.08)",
        color: theme.ink,
        fontSize: 12.5,
        lineHeight: 1.55,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span style={{ flex: 1 }}>
        {tr("novel.chaptersLoadError", { error: message })}
      </span>
      <button
        onClick={onRetry}
        style={{
          padding: "4px 10px",
          borderRadius: 6,
          border: `0.5px solid ${theme.rule}`,
          background: theme.bg,
          color: theme.ink,
          fontFamily: "inherit",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {tr("common.retry")}
      </button>
    </div>
  );
}

// ── per-chapter download button ────────────────────────────────────────────
//
// Lives inside each chapter row in the volumes accordion. Its job is
// to show the chapter's download status (idle / queued / downloading /
// done / failed) and to enqueue/cancel a download when the user
// clicks. Filled in by task 10 once the queue module exists.

/** Resting height of a one-line chapter row. Only a seed for the windowed
 *  list's offset table — rows that wrap get measured and corrected.
 *
 *  44px, not the old 36: the row now carries a delete action beside the
 *  download one, and 36 put both under the 44px touch minimum. This
 *  feeds MeasuredVirtualList's estimatedItemHeight — leaving it stale
 *  makes the list mis-estimate its scroll extent on a 950-row volume. */
const CHAPTER_ROW_HEIGHT = 44;

interface ChapterRowProps {
  theme: Theme;
  chapter: SourceChapter;
  direction: "ltr" | "rtl";
  read: boolean;
  downloaded: boolean;
  libraryEntryId: string | null | undefined;
  novelTitle: string;
  queueJob: DownloadJob | undefined;
  onOpenChapter: (chapterId: number) => void;
  onFlagsChanged: () => void;
  /** Called after a row's own delete completes. `wasRunning` is true when
   *  the chapter had a download actually in flight at the moment of
   *  deletion, so the caller can say "cancelled and deleted" instead of
   *  plain "deleted". */
  onDeleted: (chapterId: number, wasRunning: boolean) => void;
}

/**
 * One row in a volume's chapter list.
 *
 * Memoized on purpose. The parent re-renders on every download-queue event
 * (`setActiveJobs` installs a fresh Map each tick), and with a ~950-chapter
 * volume expanded that meant reconciling every mounted row several times a
 * second during a download burst. All props here are primitives or stable
 * identities, so a row only re-renders when something about *that* chapter
 * actually changed.
 */
const ChapterRow = memo(function ChapterRow({
  theme,
  chapter,
  direction,
  read,
  downloaded,
  libraryEntryId,
  novelTitle,
  queueJob,
  onOpenChapter,
  onDeleted,
}: ChapterRowProps) {
  return (
    <div
      role="listitem"
      style={{ display: "flex", alignItems: "stretch", direction }}
    >
      <button
        onClick={() => onOpenChapter(chapter.id)}
        style={{
          flex: 1,
          textAlign: "start",
          background: "transparent",
          border: "none",
          // Start-edge accent bar — transparent by default, theme.rule when
          // read, ACCENT on hover. A fixed 2px logical border (never toggled
          // to 0) so the colour change never shifts the row's layout.
          borderInlineStart: `2px solid ${read ? theme.rule : "transparent"}`,
          paddingBlock: 13,
          paddingInlineStart: 26,
          paddingInlineEnd: 14,
          // Dim read chapters so the list reads "checked off" without hiding
          // anything.
          color: read ? theme.muted : theme.ink,
          opacity: read ? 0.72 : 1,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 12.5,
          lineHeight: 1.4,
          display: "flex",
          gap: 10,
          alignItems: "baseline",
          direction,
          transition: transition("border-color", "fast", "out"),
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = theme.hover;
          e.currentTarget.style.borderInlineStartColor = ACCENT;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.borderInlineStartColor = read
            ? theme.rule
            : "transparent";
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: theme.muted,
            minWidth: 28,
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {chapter.id}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>{chapter.title}</span>
        {read && (
          <Icon
            name="check"
            size={13}
            style={{ color: ACCENT, flexShrink: 0, alignSelf: "center" }}
          />
        )}
      </button>
      {libraryEntryId && (
        <ChapterDownloadButton
          theme={theme}
          libraryEntryId={libraryEntryId}
          chapterId={chapter.id}
          downloaded={downloaded}
          novelTitle={novelTitle}
          chapterTitle={chapter.title}
          queueJob={queueJob}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
});

interface ChapterDownloadButtonProps {
  theme: Theme;
  libraryEntryId: string;
  chapterId: number;
  /** True when the chapter has been downloaded to disk according to
   *  the parent's flag map. The button uses this for the resting state
   *  ("downloaded" check icon, armed into a delete action) and as a
   *  guard against re-enqueuing. */
  downloaded: boolean;
  /** Called after this row's own delete completes. `wasRunning` is true
   *  when the chapter had a download actually in flight at the moment
   *  of deletion. */
  onDeleted: (chapterId: number, wasRunning: boolean) => void;
}

function ChapterDownloadButton({
  theme,
  libraryEntryId,
  chapterId,
  downloaded,
  novelTitle,
  chapterTitle,
  queueJob,
  onDeleted,
}: ChapterDownloadButtonProps & {
  novelTitle: string;
  chapterTitle: string;
  /** Live queue job for this chapter when one is queued/running.
   *  Drives the spinner/progress indicator without us needing a
   *  separate subscription per row — the parent subscribes once and
   *  fans out. */
  queueJob: import("../store/downloadQueue").DownloadJob | undefined;
}) {
  const { tr } = useI18n();

  const onClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (downloaded) {
        // Single deletes skip the dialog: a deleted chapter is always
        // re-downloadable from the source, so the toast's action is a
        // cheaper undo than a modal. Bulk deletes still confirm.
        const { deleteChaptersWithQueue } = await import(
          "../store/chapterDeletion"
        );
        const res = await deleteChaptersWithQueue(libraryEntryId, [chapterId]);
        onDeleted(chapterId, res.cancelledRunning.length > 0);
        return;
      }
      if (queueJob) {
        const { cancel } = await import("../store/downloadQueue");
        cancel(queueJob.id);
        return;
      }
      const { enqueue } = await import("../store/downloadQueue");
      enqueue({ libraryEntryId, chapterId, novelTitle, chapterTitle });
    },
    [
      libraryEntryId,
      chapterId,
      downloaded,
      queueJob,
      novelTitle,
      chapterTitle,
      onDeleted,
    ],
  );

  // The touch-detection idiom used elsewhere in this codebase
  // (ContextMenu.tsx): `(hover: none)` alone misses Android Chrome
  // configs that report `hover: hover`, so OR with `(pointer: coarse)`
  // and fall back to navigator.maxTouchPoints.
  const mqTouch = useMediaQuery("(hover: none), (pointer: coarse)");
  const isTouch =
    mqTouch ||
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);

  // The downloaded row's icon is a ✓ at rest and a trash on hover or
  // keyboard focus. The button stays in the DOM and focusable at all
  // times — a hover-only control would be unreachable by keyboard —
  // and touch (no hover) shows the trash permanently.
  const [armed, setArmed] = useState(false);
  const showTrash = downloaded && (armed || isTouch);

  // Resting state precedence:
  //   downloaded (persisted)  → check icon, dim (trash armed on hover/focus/touch)
  //   queued                  → clock icon
  //   running                 → spinning download icon + progress %
  //   error (recent)          → info icon, warning color
  //   idle                    → download icon
  const status = downloaded
    ? "downloaded"
    : queueJob?.status === "queued"
      ? "queued"
      : queueJob?.status === "running"
        ? "running"
        : queueJob?.status === "error"
          ? "error"
          : "idle";

  const iconName = showTrash
    ? "trash"
    : status === "downloaded"
      ? "check"
      : status === "queued"
        ? "clock"
        : status === "running"
          ? "cloudOk"
          : status === "error"
            ? "info"
            : "download";

  // The downloaded label is now the delete label — an icon-only button
  // whose aria-label still said "Downloaded" would announce the wrong
  // action to a screen reader.
  const label =
    status === "downloaded"
      ? tr("downloads.delete.chapterLabel", { n: chapterId })
      : status === "queued"
        ? tr("novel.queuedClickCancel")
        : status === "running"
          ? tr("novel.downloadingClickCancel", {
              pct: Math.round((queueJob?.progress ?? 0) * 100),
            })
          : status === "error"
            ? tr("downloads.statusFailed", {
                error: queueJob?.error ?? tr("downloads.unknownError"),
              })
            : tr("novel.downloadChapter");
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      onMouseEnter={() => setArmed(true)}
      onMouseLeave={() => setArmed(false)}
      onFocus={() => setArmed(true)}
      onBlur={() => setArmed(false)}
      style={{
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "0 14px",
        display: "flex",
        alignItems: "center",
        gap: 4,
        color: showTrash || status === "error" ? "#b75050" : theme.muted,
        opacity: downloaded && !showTrash ? 0.55 : 1,
        flexShrink: 0,
      }}
    >
      <Icon name={iconName} size={14} />
      {status === "running" && (
        <span style={{ fontSize: 10, color: theme.muted }}>
          {Math.round((queueJob?.progress ?? 0) * 100)}%
        </span>
      )}
    </button>
  );
}

// ── volumes accordion ──────────────────────────────────────────────────────

interface VolumesAccordionProps {
  theme: Theme;
  layout: "desktop" | "mobile";
  source: Source;
  novel: SourceNovel;
  novelUrl: string;
  /** Library entry id when this view is bound to a shelf entry. Drives
   *  the per-chapter download icon's visibility — the Store-side detail
   *  view (no library entry yet) hides downloads entirely. */
  libraryEntryId?: string;
  /** Per-chapter flag lookup. Read chapters dim. Downloaded chapters
   *  show the "downloaded" indicator on their row. */
  chapterFlags: Map<number, ChapterFlags>;
  onOpenChapter: (chapterId: number) => void;
  /** Bumped by the download / queue subsystem when a chapter's flags
   *  change so the accordion re-renders. The setter accepts a new map
   *  built from the latest source.json snapshot. */
  onChapterFlagsChange: (next: Map<number, ChapterFlags>) => void;
  /** Replace the novel object the parent holds — used by the lazy
   *  volume path: after a fresh `getVolumeChapters` lands, the
   *  accordion calls this with the same novel but the target volume's
   *  chapters[] populated. Accepts either a value or a functional
   *  updater (the latter lets the accordion patch atop whatever the
   *  parent's latest state is, avoiding stale-closure overwrites when
   *  multiple effects race). */
  onNovelPatch: (
    updater: SourceNovel | ((current: SourceNovel | null) => SourceNovel | null),
  ) => void;
}

function VolumesAccordion({
  theme,
  layout,
  source,
  novel,
  novelUrl,
  libraryEntryId,
  chapterFlags,
  onOpenChapter,
  onChapterFlagsChange,
  onNovelPatch,
}: VolumesAccordionProps) {
  const { tr } = useI18n();
  // Open the first volume by default; subsequent volumes start collapsed
  // to keep the page short on a 100+ chapter novel.
  const [open, setOpen] = useState<Set<number>>(
    () => new Set(novel.volumes.length > 0 ? [novel.volumes[0].id] : []),
  );
  const toggle = (id: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── lazy volume loading ──────────────────────────────────────────────
  // For sources that declare `hasLazyVolumes`, getNovel returns volumes
  // with empty chapters[] arrays. We fetch them on first expand of each
  // volume, persist into source.json, and stuff the result into the
  // parent's novel state.
  //
  // loadingVolumes  per-volume in-flight flag (drives the skeleton)
  // errorByVolume   surface error message when a load fails
  const [loadingVolumes, setLoadingVolumes] = useState<Set<number>>(
    () => new Set(),
  );
  const [errorByVolume, setErrorByVolume] = useState<Map<number, string>>(
    () => new Map(),
  );
  const expandedRef = useRef<Set<number>>(new Set());
  const isLazy = source.hasLazyVolumes === true;

  // Cancel-on-unmount guards. Tracks every in-flight fetch by volume
  // id so an unmount mid-load doesn't leak setState calls into a
  // dead component.
  //
  // The body resets the ref to `true` on every mount because
  // `useRef`'s value persists across React StrictMode's simulated
  // unmount→remount cycle. Without the explicit reset, the cleanup
  // from the first invocation would leave the ref `false` going into
  // the second mount, and every in-flight loadVolume would bail in
  // its `if (!aliveRef.current) return;` guards — leaving the
  // skeleton stuck forever.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadVolume = useCallback(
    async (volumeId: number) => {
      if (!isLazy) return;
      if (loadingVolumes.has(volumeId)) return;
      // Did we already load it once this mount? Avoid hammering on
      // every collapse/expand toggle.
      if (expandedRef.current.has(volumeId)) return;
      const vol = novel.volumes.find((v) => v.id === volumeId);
      if (!vol) return;
      if (vol.chapters.length > 0) {
        // Already loaded (e.g. snapshot had carried-forward chapters).
        expandedRef.current.add(volumeId);
        return;
      }
      if (!source.getVolumeChapters) return;

      setLoadingVolumes((s) => {
        const next = new Set(s);
        next.add(volumeId);
        return next;
      });
      setErrorByVolume((m) => {
        if (!m.has(volumeId)) return m;
        const next = new Map(m);
        next.delete(volumeId);
        return next;
      });
      try {
        const chapters = await source.getVolumeChapters(novelUrl, vol);
        if (!aliveRef.current) return;
        // Persist + mirror into the parent's novel state. Use a
        // functional updater so we patch atop the parent's CURRENT
        // novel — if a concurrent fetchFromSource has updated
        // state.novel since our await, we'd overwrite it with the
        // stale closure copy otherwise.
        if (libraryEntryId) {
          const { setVolumeChapters } = await import("../store/sourceLibrary");
          await setVolumeChapters(libraryEntryId, volumeId, chapters);
        }
        onNovelPatch((current) => {
          if (!current) {
            // Should be unreachable — accordion only renders when
            // novel is non-null — but the functional updater's typed
            // input includes null, so guard.
            return current;
          }
          const patched = current.volumes.map((v) =>
            v.id === volumeId ? { ...v, chapters } : v,
          );
          return { ...current, volumes: patched };
        });
        expandedRef.current.add(volumeId);
      } catch (e) {
        if (!aliveRef.current) return;
        setErrorByVolume((m) => {
          const next = new Map(m);
          next.set(volumeId, e instanceof Error ? e.message : String(e));
          return next;
        });
      } finally {
        if (!aliveRef.current) return;
        setLoadingVolumes((s) => {
          const next = new Set(s);
          next.delete(volumeId);
          return next;
        });
      }
    },
    [isLazy, loadingVolumes, novel, novelUrl, source, libraryEntryId, onNovelPatch],
  );

  // Fire the load when a lazy volume becomes open (initial mount's
  // auto-opened first volume + any subsequent user-driven expand).
  useEffect(() => {
    if (!isLazy) return;
    for (const id of open) {
      const vol = novel.volumes.find((v) => v.id === id);
      if (!vol) continue;
      if (vol.chapters.length === 0 && !loadingVolumes.has(id)) {
        void loadVolume(id);
      }
    }
  }, [isLazy, open, novel.volumes, loadingVolumes, loadVolume]);

  // Refresh chapter flags on demand — used by the per-chapter download
  // button once a download completes. Reads source.json and rebuilds
  // the flag map.
  const refreshFlags = useCallback(async () => {
    if (!libraryEntryId) return;
    const { readSnapshot } = await import("../store/sourceLibrary");
    const snap = await readSnapshot(libraryEntryId);
    if (!snap) return;
    onChapterFlagsChange(buildFlagMap(snap));
  }, [libraryEntryId, onChapterFlagsChange]);

  // Toast + per-row delete plumbing. Reused by the bulk delete affordances
  // (volume / read-downloads) landing in later tasks.
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastIdRef = useRef(0);
  const showToast = useCallback(
    (
      kind: ToastMessage["kind"],
      text: string,
      action?: ToastMessage["action"],
    ) => {
      toastIdRef.current += 1;
      setToast({ id: toastIdRef.current, kind, text, action });
    },
    [],
  );

  const onChapterDeleted = useCallback(
    (chapterId: number, wasRunning: boolean) => {
      void refreshFlags();
      const chapter = novel.volumes
        .flatMap((v) => v.chapters)
        .find((c) => c.id === chapterId);
      const title = chapter?.title ?? String(chapterId);
      showToast(
        "info",
        tr(
          wasRunning
            ? "downloads.delete.deletedAndCancelled"
            : "downloads.delete.deleted",
          { title },
        ),
        {
          label: tr("downloads.delete.redownload"),
          onClick: () => {
            void (async () => {
              const { enqueue } = await import("../store/downloadQueue");
              if (!libraryEntryId || !chapter) return;
              enqueue({
                libraryEntryId,
                chapterId,
                novelTitle: novel.title,
                chapterTitle: chapter.title,
              });
            })();
          },
        },
      );
    },
    [refreshFlags, showToast, tr, novel, libraryEntryId],
  );

  // Per-volume "download all" — enqueues every not-yet-downloaded chapter in
  // one volume. Lazy volumes are fetched first so their chapter list exists
  // before we enqueue. `downloadingVol` guards the brief enqueue window so a
  // double-tap can't fire it twice.
  const [downloadingVol, setDownloadingVol] = useState<Set<number>>(
    () => new Set(),
  );
  /** Volume awaiting the user's go-ahead. One tap on the volume's download
   *  icon used to queue every chapter in it immediately — dozens of network
   *  fetches from a 42px target sitting right next to the expand/collapse
   *  row, with no way to take it back. The icon now only stages the intent;
   *  `downloadVolume` runs on confirm. `pending`/`skipped` are captured at
   *  tap time so the dialog can state exactly what it is about to queue. */
  const [volumeConfirm, setVolumeConfirm] = useState<{
    id: number;
    title: string;
    pending: number;
    skipped: number;
  } | null>(null);
  const downloadVolume = useCallback(
    async (volumeId: number) => {
      if (!libraryEntryId) return;
      if (downloadingVol.has(volumeId)) return;
      const vol = novel.volumes.find((v) => v.id === volumeId);
      if (!vol) return;
      setDownloadingVol((s) => new Set(s).add(volumeId));
      try {
        // Ensure the chapter list exists (lazy volumes arrive empty).
        let chapters = vol.chapters;
        if (chapters.length === 0 && source.getVolumeChapters) {
          const fetched = await source.getVolumeChapters(novelUrl, vol);
          if (!aliveRef.current) return;
          chapters = fetched;
          const { setVolumeChapters } = await import("../store/sourceLibrary");
          await setVolumeChapters(libraryEntryId, volumeId, fetched);
          onNovelPatch((current) =>
            current
              ? {
                  ...current,
                  volumes: current.volumes.map((v) =>
                    v.id === volumeId ? { ...v, chapters: fetched } : v,
                  ),
                }
              : current,
          );
          expandedRef.current.add(volumeId);
        }
        const { enqueue } = await import("../store/downloadQueue");
        for (const c of chapters) {
          if (chapterFlags.get(c.id)?.downloadedAt) continue;
          enqueue({
            libraryEntryId,
            chapterId: c.id,
            novelTitle: novel.title,
            chapterTitle: c.title,
          });
        }
      } catch {
        // The per-chapter rows surface queue/error state; a failed lazy
        // fetch leaves the volume untouched for a retry.
      } finally {
        if (aliveRef.current) {
          setDownloadingVol((s) => {
            const next = new Set(s);
            next.delete(volumeId);
            return next;
          });
        }
      }
    },
    [
      libraryEntryId,
      downloadingVol,
      novel,
      novelUrl,
      source,
      chapterFlags,
      onNovelPatch,
    ],
  );

  // Live queue state for this entry — drives the per-row download
  // icon's queued/running/error rendering. We subscribe to the
  // module-scoped queue once for the accordion (not once per row) and
  // re-read activeChapterSet on every emission. When a job transitions
  // from running → done we trigger a flag refresh so the persisted
  // downloadedAt picks up.
  const [activeJobs, setActiveJobs] = useState<
    Map<number, import("../store/downloadQueue").DownloadJob>
  >(new Map());
  useEffect(() => {
    if (!libraryEntryId) return;
    let lastTerminalUpdate = 0;
    let cancelled = false;
    (async () => {
      const { subscribe, activeChapterSet, getState } = await import(
        "../store/downloadQueue"
      );
      const apply = () => {
        if (cancelled) return;
        setActiveJobs(activeChapterSet(libraryEntryId));
        // Heuristic: any terminal job belonging to this entry that
        // showed up after our last refresh is a good moment to
        // re-read source.json so freshly-downloaded chapters flip
        // their persisted flag in the UI.
        const st = getState();
        let newest = lastTerminalUpdate;
        let dirty = false;
        for (const j of st.jobs) {
          if (j.libraryEntryId !== libraryEntryId) continue;
          if (
            j.status === "done" ||
            j.status === "error" ||
            j.status === "cancelled"
          ) {
            if (j.updatedAt > lastTerminalUpdate) dirty = true;
            if (j.updatedAt > newest) newest = j.updatedAt;
          }
        }
        if (dirty) {
          lastTerminalUpdate = newest;
          void refreshFlags();
        }
      };
      apply();
      const off = subscribe(apply);
      // Capture the unsubscribe for cleanup. Wrap so cleanup runs
      // even before the dynamic import resolved (cancelled-flag
      // gate above).
      return off;
    })();
    return () => {
      cancelled = true;
    };
  }, [libraryEntryId, refreshFlags]);

  return (
    <div
      style={{
        padding: layout === "mobile" ? "0 18px 40px" : "0 40px 40px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h2
        style={{
          fontSize: 14,
          fontWeight: 600,
          margin: "8px 0",
          color: theme.ink,
          letterSpacing: "-0.005em",
        }}
      >
        {tr("novel.chaptersHeading")}
      </h2>
      {novel.volumes.map((v) => {
        const isOpen = open.has(v.id);
        const count = v.chapters.length > 0 ? v.chapters.length : v.chapterCount ?? 0;
        const volLoaded = v.chapters.length > 0;
        const volPending = volLoaded
          ? v.chapters.filter((c) => !chapterFlags.get(c.id)?.downloadedAt)
              .length
          : count;
        const volAllDownloaded = volLoaded && volPending === 0;
        const volDownloading = downloadingVol.has(v.id);
        return (
          <div
            key={v.id}
            style={{
              border: `0.5px solid ${isOpen ? theme.ruleStrong : theme.rule}`,
              borderRadius: 12,
              overflow: "hidden",
              background: isOpen ? theme.chrome : theme.bg,
              transition: transition("background", "fast", "out"),
            }}
          >
            <div style={{ display: "flex", alignItems: "stretch" }}>
              <button
                onClick={() => toggle(v.id)}
                aria-expanded={isOpen}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "13px 14px",
                  border: "none",
                  background: "transparent",
                  color: theme.ink,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  textAlign: "start",
                }}
                onMouseEnter={(e) => {
                  if (!isOpen) e.currentTarget.style.background = theme.hover;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
                  {/* Outer span mirrors the chevron in RTL; the inner span
                      rotates it between closed (points toward content) and open
                      (points down). Two layers so the rotate transform doesn't
                      clobber the rtl-flip. Reduced motion neutralizes the
                      rotation via the global transition-duration override. */}
                  <span
                    className="rtl-flip-x"
                    style={{ display: "inline-flex", flexShrink: 0, color: theme.muted }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        transition: transition("transform", "fast", "out"),
                        transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                      }}
                    >
                      <Icon name="chevronR" size={14} />
                    </span>
                  </span>
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {v.title}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: theme.muted,
                    flexShrink: 0,
                    padding: "3px 9px",
                    borderRadius: 999,
                    background: theme.bg,
                    border: `0.5px solid ${theme.rule}`,
                  }}
                >
                  {count > 0 ? tr("novel.chapterCountShort", { n: count }) : "—"}
                </span>
              </button>
              {libraryEntryId && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (volAllDownloaded || volDownloading) return;
                    // A lazy volume has no chapter list yet, so volPending is
                    // the source's reported count and nothing is known to be
                    // on disk — the fetch happens after the user confirms.
                    setVolumeConfirm({
                      id: v.id,
                      title: v.title,
                      pending: volPending,
                      skipped: volLoaded ? count - volPending : 0,
                    });
                  }}
                  disabled={volAllDownloaded || volDownloading}
                  title={
                    volAllDownloaded
                      ? tr("novel.volumeAllDownloaded")
                      : volDownloading
                        ? tr("novel.downloadingVolume")
                        : tr("novel.downloadVolume")
                  }
                  aria-label={
                    volAllDownloaded
                      ? tr("novel.volumeAllDownloaded")
                      : tr("novel.downloadVolume")
                  }
                  style={{
                    flexShrink: 0,
                    width: 42,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "none",
                    background: "transparent",
                    color: volAllDownloaded ? theme.muted : theme.ink,
                    cursor:
                      volAllDownloaded || volDownloading ? "default" : "pointer",
                    opacity: volDownloading ? 0.5 : volAllDownloaded ? 0.55 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!volAllDownloaded && !volDownloading) {
                      e.currentTarget.style.background = theme.hover;
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <Icon
                    name={volAllDownloaded ? "check" : "download"}
                    size={15}
                  />
                </button>
              )}
            </div>
            {isOpen && (
              <>
                {(() => {
                  const isLoading = loadingVolumes.has(v.id);
                  const err = errorByVolume.get(v.id);
                  const empty = v.chapters.length === 0;
                  if (err && empty) {
                    return (
                      <VolumeErrorPanel
                        theme={theme}
                        message={err}
                        onRetry={() => {
                          // Allow re-attempt: clear the "already
                          // expanded" memoization so loadVolume runs
                          // again on the next mount cycle.
                          expandedRef.current.delete(v.id);
                          void loadVolume(v.id);
                        }}
                      />
                    );
                  }
                  if (isLoading && empty) {
                    return (
                      <VolumeChaptersSkeleton
                        theme={theme}
                        rows={Math.min(v.chapterCount ?? 8, 12)}
                      />
                    );
                  }
                  return null;
                })()}
              </>
            )}
            {isOpen && v.chapters.length > 0 && (
              // Windowed: a big volume runs to ~950 chapters, and mounting
              // every row cost ~200ms and ~6.6k DOM nodes — after which every
              // download-queue tick re-reconciled all of them. Measured (not
              // fixed-height) because ~6% of chapter titles wrap to a second
              // line and clipping them would hide content.
              <MeasuredVirtualList
                items={v.chapters}
                estimatedItemHeight={CHAPTER_ROW_HEIGHT}
                itemKey={(c) => c.id}
                role="list"
                className="riwaq-scroll-hidden riwaq-collapse-enter"
                ariaLabel={v.title}
                style={{
                  margin: 0,
                  padding: "4px 0 8px",
                  borderTop: `0.5px solid ${theme.rule}`,
                  maxHeight: 360,
                  background: theme.bg,
                }}
                renderItem={(c) => (
                  <ChapterRow
                    theme={theme}
                    chapter={c}
                    direction={novel.direction}
                    read={!!chapterFlags.get(c.id)?.readAt}
                    downloaded={!!chapterFlags.get(c.id)?.downloadedAt}
                    libraryEntryId={libraryEntryId}
                    novelTitle={novel.title}
                    queueJob={activeJobs.get(c.id)}
                    onOpenChapter={onOpenChapter}
                    onFlagsChanged={refreshFlags}
                    onDeleted={onChapterDeleted}
                  />
                )}
              />
            )}
          </div>
        );
      })}
      {/* AnimatedDialog stays mounted and takes `open` as a prop — it keeps the
          last children around to play the exit animation. Unmounting the whole
          thing on cancel would snap it off-screen instead. */}
      <AnimatedDialog
        open={volumeConfirm !== null}
        onScrimClick={() => setVolumeConfirm(null)}
        zIndex={9700}
      >
        {volumeConfirm && (
          <ConfirmDialog
              theme={theme}
              title={tr("novel.downloadVolumeConfirmTitle")}
              // Queuing downloads is additive and cancellable from the queue
              // page, so this is a primary action, not a destructive one.
              confirmVariant="primary"
              confirmLabel={tr("downloads.range.queueButton", {
                n: volumeConfirm.pending,
              })}
              cancelLabel={tr("common.cancel")}
              message={
                <>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    {volumeConfirm.title}
                  </div>
                  {tr(
                    volumeConfirm.pending === 1
                      ? "downloads.range.queueCountOne"
                      : "downloads.range.queueCountOther",
                    {
                      n: volumeConfirm.pending,
                      extra:
                        volumeConfirm.skipped > 0
                          ? tr("downloads.range.alreadyOnDisk", {
                              n: volumeConfirm.skipped,
                            })
                          : "",
                    },
                  )}
                </>
              }
              onConfirm={() => {
                const id = volumeConfirm.id;
                setVolumeConfirm(null);
                void downloadVolume(id);
              }}
              onCancel={() => setVolumeConfirm(null)}
          />
        )}
      </AnimatedDialog>
      <Toast theme={theme} toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
