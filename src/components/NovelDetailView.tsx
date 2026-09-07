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
import { useLongPress } from "../hooks/useLongPress";
import { VolumeActionsMenu } from "./VolumeActionsMenu";
import {
  downloadedChapterIds,
  readDownloadedChapterIds,
  type ChapterFlags,
} from "../store/chapterDeletion";

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
  /** Asks the accordion to delete this row's download. A request, not a
   *  notification: the accordion owns deleteChaptersWithQueue, the flag
   *  refresh and every toast this can produce — including the error one
   *  a failed snapshot write needs, which a row has no channel for. */
  onRequestDelete: (chapterId: number) => void;
  /** True once the accordion is in selection mode (any row long-pressed
   *  or right-clicked). Swaps the row's click behaviour from "open
   *  chapter" to "toggle selection" and reveals the checkbox. */
  selecting: boolean;
  /** Whether THIS row is in the parent's selected set. A boolean, not
   *  the Set itself, so only the rows whose selectedness actually
   *  changed re-render under `memo`. */
  selected: boolean;
  onToggleSelect: (chapterId: number) => void;
  onEnterSelection: (chapterId: number) => void;
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
  onRequestDelete,
  selecting,
  selected,
  onToggleSelect,
  onEnterSelection,
}: ChapterRowProps) {
  const { tr } = useI18n();
  // Long-press / right-click entry point, shared by the pointer-based
  // long-press below and the onContextMenu handler.
  //
  // Only downloaded chapters are selectable — selection exists in order
  // to delete, so a row with nothing to delete in the set would need a
  // disabled state in the action bar. This guard used to live in the
  // parent's `enterSelection`, keyed off `chapterFlags`, but that gave
  // every row's `onEnterSelection` prop a new identity whenever flags
  // were rebuilt, defeating the memo for every mounted row at once.
  // `downloaded` is already a stable per-row boolean prop, so the guard
  // belongs here instead.
  //
  // While already selecting, a long-press or right-click toggles the
  // row like a tap does rather than resetting the whole selection to
  // just this one chapter — otherwise a stray long-press mid-multi-select
  // would silently collapse a large selection down to one row.
  const activateForSelection = () => {
    if (!downloaded) return;
    if (selecting) onToggleSelect(chapter.id);
    else onEnterSelection(chapter.id);
  };
  const { bind, consumeLongPress } = useLongPress(activateForSelection);
  return (
    <div
      role={selecting ? undefined : "listitem"}
      style={{ display: "flex", alignItems: "stretch", direction }}
    >
      <button
        {...bind}
        onContextMenu={(e) => {
          e.preventDefault();
          activateForSelection();
        }}
        onClick={() => {
          if (consumeLongPress()) return;
          if (selecting) {
            if (downloaded) onToggleSelect(chapter.id);
            return;
          }
          onOpenChapter(chapter.id);
        }}
        role={selecting ? "option" : undefined}
        aria-selected={selecting ? selected : undefined}
        // Only downloaded rows are selectable, and onClick silently
        // ignores the rest. Without aria-disabled a screen-reader user
        // hears "option, not selected", activates it, and gets nothing
        // announced back — repeatedly, down a 950-row volume.
        aria-disabled={selecting && !downloaded}
        // The title is folded in because aria-label REPLACES the
        // element's accessible name: labelling the row "Select chapter
        // 12" alone left a screen-reader user in selection mode with no
        // chapter title at all — the one fact they need to decide what
        // to delete.
        aria-label={
          selecting
            ? tr("downloads.delete.selectChapter", {
                n: chapter.id,
                title: chapter.title,
              })
            : undefined
        }
        style={{
          flex: 1,
          textAlign: "start",
          background: selected
            ? `color-mix(in srgb, ${ACCENT} 10%, transparent)`
            : "transparent",
          border: "none",
          // Start-edge accent bar — transparent by default, theme.rule when
          // read, ACCENT on hover or when selected. A fixed 2px logical
          // border (never toggled to 0) so the colour change never shifts
          // the row's layout.
          borderInlineStart: `2px solid ${
            selected ? ACCENT : read ? theme.rule : "transparent"
          }`,
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
          if (selected) return;
          e.currentTarget.style.background = theme.hover;
          e.currentTarget.style.borderInlineStartColor = ACCENT;
        }}
        onMouseLeave={(e) => {
          if (selected) return;
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.borderInlineStartColor = read
            ? theme.rule
            : "transparent";
        }}
      >
        {selecting && (
          <span
            aria-hidden
            style={{
              width: 17,
              height: 17,
              borderRadius: 5,
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              border: `1.5px solid ${selected ? ACCENT : theme.ruleStrong}`,
              background: selected ? ACCENT : "transparent",
              color: "#fff",
              opacity: downloaded ? 1 : 0.3,
              transition: transition("background-color", "fast", "out"),
            }}
          >
            {selected && <Icon name="check" size={11} />}
          </span>
        )}
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
      {libraryEntryId && !selecting && (
        <ChapterDownloadButton
          theme={theme}
          libraryEntryId={libraryEntryId}
          chapterId={chapter.id}
          downloaded={downloaded}
          novelTitle={novelTitle}
          chapterTitle={chapter.title}
          queueJob={queueJob}
          onRequestDelete={onRequestDelete}
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
  /** Asks the accordion to delete this chapter's download. See
   *  ChapterRowProps.onRequestDelete for why the button doesn't run the
   *  delete itself. */
  onRequestDelete: (chapterId: number) => void;
}

function ChapterDownloadButton({
  theme,
  libraryEntryId,
  chapterId,
  downloaded,
  novelTitle,
  chapterTitle,
  queueJob,
  onRequestDelete,
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
        //
        // The delete runs in the accordion rather than here. It has to:
        // deleteChapterDownloads ends in a writeTextFile that throws on
        // a full disk — exactly the state a user deleting downloads is
        // in — and the toast that has to report that lives up there.
        onRequestDelete(chapterId);
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
      onRequestDelete,
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
        color: showTrash || status === "error" ? theme.danger : theme.muted,
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
  //
  // Generation-guarded, because these overlap and don't resolve in
  // order. Cancelling a QUEUED job inside cancelJobsForChapters calls
  // setStatus(…, "cancelled") synchronously, which emits, which makes
  // the queue subscription below see a new terminal job and fire its
  // own refreshFlags — so a read of the PRE-delete snapshot is already
  // in flight before the sweep starts, and runBulkDelete fires another
  // one when it finishes. If the first read lands last (a multi-MB
  // source.json on Android competing with 200 in-flight remove()
  // calls) the deleted chapters flip back to "downloaded" until the
  // next queue tick or navigation, and the delete looks like it
  // failed. Only the newest read may write.
  const flagsGenRef = useRef(0);
  const refreshFlags = useCallback(async () => {
    if (!libraryEntryId) return;
    const gen = ++flagsGenRef.current;
    const { readSnapshot } = await import("../store/sourceLibrary");
    const snap = await readSnapshot(libraryEntryId);
    if (!snap) return;
    if (gen !== flagsGenRef.current) return;
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
  // Stable, like closeVolumeMenu above and for the same reason. Toast's
  // auto-dismiss effect lists onDismiss in its deps, so an inline arrow
  // restarted the 3.5s timer on every parent re-render — and this
  // component re-renders on every queue emission, roughly 25 per
  // chapter (one per image). Deleting chapter 5 while chapter 7
  // downloaded pinned the toast, and its stale "Re-download chapter 5"
  // button, for the whole remaining download.
  const dismissToast = useCallback(() => setToast(null), []);

  /** One row's delete, end to end: run it, refresh the flags, report
   *  what actually happened.
   *
   *  Every exit reports something. deleteChapterDownloads ends in a
   *  writeTextFile, which throws when the disk is full — the state a
   *  user deleting downloads is most likely to be in. Left uncaught
   *  that was an unhandled rejection with no toast, no error, and a row
   *  still showing a ✓ over content that is already gone. */
  const deleteOneChapter = useCallback(
    (chapterId: number) => {
      if (!libraryEntryId) return;
      const chapter = novel.volumes
        .flatMap((v) => v.chapters)
        .find((c) => c.id === chapterId);
      const title = chapter?.title ?? String(chapterId);
      void (async () => {
        try {
          const { deleteChaptersWithQueue } = await import(
            "../store/chapterDeletion"
          );
          const res = await deleteChaptersWithQueue(libraryEntryId, [
            chapterId,
          ]);
          // res.removed is what the snapshot actually cleared. Saying
          // "Deleted X" regardless of it means a chapter the snapshot
          // never listed reads as freed disk that was never freed.
          if (res.removed.length === 0) {
            showToast("warn", tr("downloads.delete.nothingRemoved", { title }));
            return;
          }
          showToast(
            "info",
            tr(
              res.cancelledRunning.length > 0
                ? "downloads.delete.deletedAndCancelled"
                : "downloads.delete.deleted",
              { title },
            ),
            {
              label: tr("downloads.delete.redownload"),
              onClick: () => {
                void (async () => {
                  const { enqueue } = await import("../store/downloadQueue");
                  if (!chapter) return;
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
        } catch (e) {
          showToast(
            "error",
            tr("downloads.delete.failed", {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        } finally {
          // Either way: a throw can land after some directories were
          // already swept, so the rows have to be rebuilt from disk
          // rather than left on the pre-delete map.
          void refreshFlags();
        }
      })();
    },
    [refreshFlags, showToast, tr, novel, libraryEntryId],
  );

  // Volume-header overflow menu ("⋯"): delete read downloads / delete all
  // downloads in the volume. `volumeMenu` anchors the popover/sheet at the
  // trigger button's rect; `deleteConfirm` stages the chosen chapter ids
  // for the ConfirmDialog.
  const [volumeMenu, setVolumeMenu] = useState<
    { id: number; x: number; y: number } | null
  >(null);
  // Stable identity so VolumeActionsMenu's DesktopPopover effect (which
  // depends on onClose) doesn't tear down and re-add its window
  // listeners on every parent re-render (the download-queue subscription
  // above re-renders this component frequently while the popover is open).
  const closeVolumeMenu = useCallback(() => setVolumeMenu(null), []);
  /** Chapters staged for a bulk delete, awaiting the user's confirm.
   *  `conversionActive` is sampled once at stage time — see stageDelete. */
  const [deleteConfirm, setDeleteConfirm] = useState<{
    ids: number[];
    conversionActive: boolean;
  } | null>(null);
  /** Stage a bulk delete for confirmation, sampling the queue for a
   *  live conversion of this same entry on the way.
   *
   *  The design spec's hazard 5: storeConversion's enrichChapter reads
   *  a chapter from disk when downloadedAt is set and refetches it from
   *  the source otherwise. Deleting under a running "Save as offline
   *  book" therefore doesn't fail — it silently turns a fast local job
   *  into hundreds of live scrapes, which is minutes-to-hours of
   *  degradation plus real rate-limit exposure. So it warns, and does
   *  NOT block: the user may well mean it.
   *
   *  Sampled here rather than read during render because the queue
   *  module is loaded lazily throughout this file, and the confirm's
   *  body has to be a plain synchronous render. A conversion starting
   *  in the second between staging and confirming goes unwarned; that
   *  is the honest cost of not making the dialog async. */
  const stageDelete = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      void (async () => {
        let conversionActive = false;
        if (libraryEntryId) {
          try {
            const { getState } = await import("../store/downloadQueue");
            conversionActive = getState().jobs.some(
              (j) =>
                j.kind === "conversion" &&
                j.libraryEntryId === libraryEntryId &&
                (j.status === "queued" || j.status === "running"),
            );
          } catch {
            // Queue module unavailable — stage without the warning
            // rather than blocking a delete the user asked for.
          }
        }
        setDeleteConfirm({ ids, conversionActive });
      })();
    },
    [libraryEntryId],
  );
  /** Live counter for a bulk delete, driven by deleteChapterDownloads'
   *  every-25-chapters onProgress. Non-null exactly while a sweep runs,
   *  so it doubles as the "show the progress line" flag.
   *
   *  A 950-chapter volume is 950 sequential remove() IPC round-trips
   *  with the entry lock held — minutes on Android. Without this the
   *  only feedback was a toast at the very end. */
  const [deleteProgress, setDeleteProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /** Disables the bulk-delete affordances while a sweep is in flight.
   *  The ref is the actual guard — two synchronous confirms would both
   *  read a not-yet-committed `false` out of the state variable. The
   *  state exists only so the buttons re-render disabled.
   *
   *  Without it: confirm "delete all in volume", reopen the ⋯ menu
   *  (still computing `downloaded` from the pre-delete chapterFlags),
   *  confirm the same 950 ids again. The second call serializes behind
   *  the entry lock, finds every flag already clear, and reports
   *  "Deleted 0 downloads" after 950 more remove() calls. */
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  // Selection state is declared here, ahead of runBulkDelete: runBulkDelete
  // calls exitSelection at the end, and a `const` arrow declared below it
  // would be a used-before-declaration error. Library.tsx hoists showToast
  // for the same reason.
  //
  // Selection lives in the parent, not in the rows: `ChapterRow` is
  // memoized because the parent re-renders on every download-queue tick,
  // and a 950-row volume can't afford to reconcile all of them. Rows
  // receive a boolean, so only the two rows whose selectedness actually
  // changed re-render.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const exitSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  // Escape leaves selection mode. The ✕ in the action bar was the only
  // way out, and on Android the hardware back button routes into the
  // webview's history — intercepting it would mean leaving the novel
  // entirely, so a key is the honest fix here.
  //
  // Stands down while the confirm dialog or the volume menu is open:
  // both bind Escape themselves, and cancelling a confirm should not
  // also throw away the selection the user is about to retry with.
  useEffect(() => {
    if (!selecting) return;
    if (deleteConfirm !== null || volumeMenu !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, deleteConfirm, volumeMenu, exitSelection]);

  const toggleSelected = useCallback((chapterId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  }, []);

  // The "only downloaded chapters are selectable" guard used to live
  // here and depend on `chapterFlags`, which made this callback (and
  // therefore every mounted ChapterRow's `onEnterSelection` prop) get a
  // new identity on every flag rebuild — defeating the row memo for all
  // of them, not just the row whose flags actually changed. ChapterRow
  // already receives `downloaded` as a boolean prop, so the guard now
  // lives there instead, letting this stay a stable, dependency-free
  // callback.
  const enterSelection = useCallback((chapterId: number) => {
    setSelecting(true);
    setSelected(new Set([chapterId]));
  }, []);

  const runBulkDelete = useCallback(
    async (ids: number[]) => {
      if (!libraryEntryId || ids.length === 0) return;
      if (deletingRef.current) return;
      deletingRef.current = true;
      setDeleting(true);
      // Seed at 0/total so the line appears the moment the sweep starts.
      // onProgress only fires every 25 chapters, so a small batch would
      // otherwise show nothing at all until it finished.
      setDeleteProgress({ done: 0, total: ids.length });
      try {
        const { deleteChaptersWithQueue } = await import(
          "../store/chapterDeletion"
        );
        const res = await deleteChaptersWithQueue(
          libraryEntryId,
          ids,
          (done, total) => setDeleteProgress({ done, total }),
        );
        showToast(
          "info",
          tr(
            res.removed.length === 1
              ? "downloads.delete.deletedCountOne"
              : "downloads.delete.deletedCountOther",
            { n: res.removed.length },
          ),
        );
        exitSelection();
      } catch (e) {
        // The selection deliberately survives a failure: it is the
        // user's only record of what they were trying to delete, and
        // rebuilding it by hand over a 950-row volume is worse than
        // leaving the mode open behind an error toast.
        showToast(
          "error",
          tr("downloads.delete.failed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        deletingRef.current = false;
        setDeleting(false);
        setDeleteProgress(null);
        void refreshFlags();
      }
    },
    [libraryEntryId, refreshFlags, showToast, tr, exitSelection],
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
      {selecting && (
        <div
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingBlock: 10,
            paddingInline: 14,
            background: theme.chrome,
            borderBottom: `0.5px solid ${theme.rule}`,
            position: "sticky",
            top: 0,
            zIndex: 20,
          }}
        >
          <button
            onClick={exitSelection}
            aria-label={tr("downloads.delete.exitSelection")}
            style={{
              width: 32,
              height: 32,
              display: "grid",
              placeItems: "center",
              border: "none",
              background: "transparent",
              color: theme.muted,
              cursor: "pointer",
              borderRadius: 8,
            }}
          >
            <Icon name="close" size={15} />
          </button>
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>
            {tr("downloads.delete.selectionCount", { n: selected.size })}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={() => {
              // Candidate ids come from chapterFlags (rebuilt from the
              // full disk snapshot by refreshFlags), not novel.volumes.
              // For a lazy-volume source, a volume's chapters[] stays []
              // until the user expands it in THIS session — but
              // DownloadRangeDialog can populate chapterFlags for a
              // volume via setVolumeChapters without ever patching
              // novel.volumes (it doesn't call onNovelPatch). Building
              // "all" from novel.volumes would silently drop those
              // already-downloaded chapters from the selection. The
              // predicate itself still lives in chapterDeletion.ts, not
              // an inline filter — it's already unit-tested there.
              setSelected(
                new Set(
                  downloadedChapterIds(
                    Array.from(chapterFlags.keys()),
                    chapterFlags,
                  ),
                ),
              );
            }}
            style={{
              font: "inherit",
              fontSize: 11.5,
              paddingBlock: 6,
              paddingInline: 12,
              borderRadius: 999,
              border: `0.5px solid ${theme.rule}`,
              background: "transparent",
              color: theme.ink,
              cursor: "pointer",
            }}
          >
            {tr("downloads.delete.selectAllDownloaded")}
          </button>
          <button
            disabled={selected.size === 0 || deleting}
            onClick={() => stageDelete([...selected])}
            style={{
              font: "inherit",
              fontSize: 11.5,
              paddingBlock: 6,
              paddingInline: 12,
              borderRadius: 999,
              border: `0.5px solid ${theme.danger}`,
              background: theme.danger,
              // theme.bg, not #fff: theme.danger is a LIGHT red on the
              // dark themes (it has to clear AA against a near-black
              // background), and white on it measures under 3:1. Taking
              // the background as the label colour makes this ratio
              // identical to danger-vs-bg, which the token guarantees.
              color: theme.bg,
              cursor:
                selected.size === 0 || deleting ? "default" : "pointer",
              opacity: selected.size === 0 || deleting ? 0.45 : 1,
            }}
          >
            {tr(
              selected.size === 1
                ? "downloads.delete.confirmButtonOne"
                : "downloads.delete.confirmButtonOther",
              { n: selected.size },
            )}
          </button>
        </div>
      )}
      {deleteProgress && (
        // Sits outside the selection bar on purpose: the ⋯ menu's
        // "delete read"/"delete all" presets never enter selection
        // mode, so a counter living in that bar would be invisible for
        // exactly the biggest sweeps.
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingBlock: 8,
            paddingInline: 14,
            borderRadius: 10,
            background: theme.chrome,
            border: `0.5px solid ${theme.rule}`,
            color: theme.muted,
            fontSize: 11.5,
          }}
        >
          <Icon name="trash" size={13} />
          <span>
            {tr("downloads.delete.deleting", {
              done: deleteProgress.done,
              total: deleteProgress.total,
            })}
          </span>
        </div>
      )}
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
              {libraryEntryId && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setVolumeMenu({ id: v.id, x: r.left, y: r.bottom });
                  }}
                  title={tr("downloads.delete.volumeActions")}
                  aria-label={tr("downloads.delete.volumeActions")}
                  style={{
                    flexShrink: 0,
                    width: 42,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "none",
                    background: "transparent",
                    color: theme.muted,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="more" size={15} />
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
                // Rows carry role="option"/aria-selected while selecting
                // (NovelDetailView's ChapterRow), so the container has to
                // switch from list/listitem to listbox/option in step —
                // `option` outside a `listbox` is not a valid ARIA
                // pairing and leaves selection-mode screen-reader
                // behaviour undefined.
                role={selecting ? "listbox" : "list"}
                ariaMultiselectable={selecting ? true : undefined}
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
                    onRequestDelete={deleteOneChapter}
                    selecting={selecting}
                    selected={selected.has(c.id)}
                    onToggleSelect={toggleSelected}
                    onEnterSelection={enterSelection}
                  />
                )}
              />
            )}
          </div>
        );
      })}
      {(() => {
        // VolumeActionsMenu stays mounted regardless of `volumeMenu` —
        // only `open` toggles. On mobile this is load-bearing: its
        // MobileSheet plays a slide-down exit whose setTimeout unmount
        // never gets to run if the whole tree is torn down synchronously
        // in the same render that nulls `volumeMenu` (see AnimatedDialog's
        // and DownloadRangeDialog's identical always-mounted convention).
        // The derived values below tolerate `volumeMenu === null` — once
        // closed, MobileSheet freezes its last (non-empty) children for
        // the exit animation, so these empty fallbacks are never actually
        // painted; they just keep this block safe to evaluate every render.
        const vol = volumeMenu
          ? novel.volumes.find((v) => v.id === volumeMenu.id)
          : undefined;
        const all = (vol?.chapters ?? []).map((c) => c.id);
        // Predicates live in chapterDeletion.ts, not inline here —
        // "both downloaded AND read" is the kind of condition that
        // quietly drifts, and it needs a test.
        const downloaded = downloadedChapterIds(all, chapterFlags);
        const read = readDownloadedChapterIds(all, chapterFlags);
        return (
          <VolumeActionsMenu
            theme={theme}
            layout={layout}
            open={volumeMenu !== null}
            anchor={volumeMenu ? { x: volumeMenu.x, y: volumeMenu.y } : null}
            title={vol?.title ?? ""}
            // Not novel.chapterCountShort ("{n} ch."): a 200-chapter
            // volume with 12 downloads rendered "12 ch." under its own
            // title, which reads as the volume's size rather than its
            // download count. Wrong in both languages.
            subtitle={
              all.length > 0
                ? tr("downloads.delete.downloadedCount", {
                    n: downloaded.length,
                  })
                : ""
            }
            // Say why, when both rows come up disabled. A lazy-volume
            // source hands us chapters: [] until the volume is expanded
            // in this session, so "nothing downloaded" and "we haven't
            // looked yet" are different states and only one of them is
            // the user's problem to fix. Loading the volume from here
            // is deliberately deferred.
            note={
              all.length === 0
                ? tr("downloads.delete.volumeNotLoaded")
                : downloaded.length === 0
                  ? tr("downloads.delete.nothingToDelete")
                  : undefined
            }
            actions={[
              {
                id: "delete-read",
                label: tr("downloads.delete.deleteRead"),
                icon: "trash",
                destructive: true,
                disabled: read.length === 0 || deleting,
              },
              {
                id: "delete-all",
                label: tr("downloads.delete.deleteAllInVolume"),
                icon: "trash",
                destructive: true,
                disabled: downloaded.length === 0 || deleting,
              },
            ]}
            onPick={(id) => {
              stageDelete(id === "delete-read" ? read : downloaded);
            }}
            onClose={closeVolumeMenu}
          />
        );
      })()}

      <AnimatedDialog
        open={deleteConfirm !== null}
        onScrimClick={() => setDeleteConfirm(null)}
        zIndex={9700}
      >
        {deleteConfirm && (
          <ConfirmDialog
            theme={theme}
            title={tr(
              deleteConfirm.ids.length === 1
                ? "downloads.delete.confirmTitleOne"
                : "downloads.delete.confirmTitleOther",
              { n: deleteConfirm.ids.length },
            )}
            confirmVariant="destructive"
            confirmLabel={tr(
              deleteConfirm.ids.length === 1
                ? "downloads.delete.confirmButtonOne"
                : "downloads.delete.confirmButtonOther",
              { n: deleteConfirm.ids.length },
            )}
            cancelLabel={tr("common.cancel")}
            message={
              <>
                {tr("downloads.delete.confirmBody")}
                {deleteConfirm.conversionActive && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginBlockStart: 10,
                      // theme.ink against the dialog body's theme.muted,
                      // plus the icon: the warning must not rest on
                      // colour alone.
                      color: theme.ink,
                    }}
                  >
                    <Icon
                      name="info"
                      size={14}
                      style={{ flexShrink: 0, marginBlockStart: 2 }}
                    />
                    <span>{tr("downloads.delete.conversionRunning")}</span>
                  </div>
                )}
              </>
            }
            onConfirm={() => {
              const ids = deleteConfirm.ids;
              setDeleteConfirm(null);
              void runBulkDelete(ids);
            }}
            onCancel={() => setDeleteConfirm(null)}
          />
        )}
      </AnimatedDialog>

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
      <Toast theme={theme} toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
