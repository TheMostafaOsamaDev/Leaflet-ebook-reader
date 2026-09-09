// Streaming reader for source novels — uses the same DesktopReader /
// MobileReader the local library uses, so the user gets every feature
// they're used to (typography, RTL, panels, highlights, TOC, paginated
// vs. scroll modes) without us forking the reading surface.
//
// How it works:
//   1. On mount, fetch novel metadata + chapter list via source.getNovel.
//   2. Construct a "virtual" EpubBook — every chapter starts with
//      paragraphs:[] (no content yet). Title/href are populated so the
//      TOC + chapter labels work immediately.
//   3. Render DesktopReader / MobileReader with the virtual book.
//   4. When the user navigates to a chapter (initial open or
//      onChapterChange), check the cache. If absent, call
//      source.getChapterContent, convert SourceLine[] → ChapterItem[],
//      then replace that chapter in the book object (bumping its `id`
//      so React's key-based reconciliation re-mounts BookBody).
//   5. Persistence: currentChapter, paragraph index, and highlights are
//      saved to localStorage under a key derived from sourceId + novel
//      URL. Cleared per-novel only — closing the reader leaves them.
//
// Highlights pose a subtle challenge: the library reader's highlight
// callbacks write to `books/<id>/state.json` on disk. For streaming we
// have no on-disk book, so we provide alternative callbacks that pipe
// through localStorage. The callbacks have the same signature, so
// DesktopReader doesn't know the difference.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DesktopReader } from "./DesktopReader";
import { MobileReader } from "./MobileReader";
import { Icon } from "./Icon";
import type { ChapterItem, EpubBook, EpubChapter } from "../epub/types";
import type { BookState, Highlight } from "../store/library";
import { getSource } from "../sources/registry";
import { findSourceEntry, updateSourceReadingPosition } from "../store/library";
import {
  chapterImageSrc,
  markChapterRead,
  chapterIsDownloaded,
  readChapterContent,
  readSnapshot,
  snapshotToSourceNovel,
} from "../store/sourceLibrary";
import type {
  Source,
  SourceLine,
  SourceNovel,
} from "../sources/types";
import {
  FONT_SERIF_DISPLAY,
  FONT_STACKS,
  type Theme,
  type ThemeKey,
} from "../styles/tokens";
import { useI18n } from "../i18n/useI18n";
import type { ActivePanel, TocVolume, Tweaks } from "../types/reader";
import type { HighlightColor } from "../styles/tokens";
import { migrateStorageKey } from "../lib/legacyStorage";
import { chapterOverlay } from "./sourceChapterStatus";
import { log as devLog } from "../lib/devLog";

interface Props {
  theme: Theme;
  themeKey: ThemeKey;
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(k: K, v: Tweaks[K]) => void;
  layout: "desktop" | "mobile";
  sourceId: string;
  novelUrl: string;
  startChapterId?: number;
  onClose: () => void;
}

interface ChapterStub {
  /** Source-assigned chapter id (1..N inside this novel) — used by
   *  caller's "open at chapter X" intent and by the cache key. */
  sourceId: number;
  title: string;
  url: string;
}

export function SourceStreamReader({
  theme,
  themeKey,
  t,
  setTweak,
  layout,
  sourceId,
  novelUrl,
  startChapterId,
  onClose,
}: Props) {
  const source = useMemo<Source | null>(() => getSource(sourceId), [sourceId]);
  // UI locale/direction for this reader's OWN chrome (the fixed-pane
  // loading/error overlays below, and the wrapper around DesktopReader /
  // MobileReader). The scraped chapter content stays independent — its
  // direction is set by DesktopReader/MobileReader/BookBody from the
  // book's own language, never from `dir` here.
  const { tr, dir } = useI18n();

  // Novel-level load state. Three top-level slices because they all
  // change together: when the index page resolves, we set `novel`,
  // `book`, and `flat` in one render. Errors short-circuit all three.
  const [novel, setNovel] = useState<SourceNovel | null>(null);
  const [book, setBook] = useState<EpubBook | null>(null);
  const [flat, setFlat] = useState<ChapterStub[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-chapter content cache. Populated as chapters are fetched. Keyed
  // by the spine index (0..N-1) — same key the reader passes around.
  const cacheRef = useRef<Map<number, ChapterItem[]>>(new Map());

  // Reading position + highlights. Persisted to localStorage so the
  // user resumes where they left off. Highlights are session-scoped
  // (lost if you uninstall the app) — they don't sync with the
  // library's per-book state.json. That's intentional: streaming is
  // ephemeral, persistence is what "Add to library" is for.
  const [currentChapter, setCurrentChapter] = useState(0);
  const [paragraphIndex, setParagraphIndex] = useState(0);
  const [paragraphOffset, setParagraphOffset] = useState(0);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [resumeParagraph, setResumeParagraph] = useState(0);
  const [resumeOffset, setResumeOffset] = useState(0);
  const [jumpNonce, setJumpNonce] = useState(0);
  // Per-chapter-index, not a shared flag: the effect below fetches the chapter
  // being read AND prefetches the next one at the same time, so a single
  // boolean was answered by whichever finished first. See chapterOverlay.
  /** Whether the NEXT chapter can be opened without the network, for the
   *  end-of-chapter card. Left undefined until known, so the card says
   *  nothing rather than promising something it has not checked. */
  const [nextAvailability, setNextAvailability] = useState<
    "device" | "online" | undefined
  >(undefined);
  const [inFlight, setInFlight] = useState<ReadonlySet<number>>(() => new Set());
  const [chapterErrors, setChapterErrors] = useState<ReadonlyMap<number, string>>(
    () => new Map(),
  );

  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  const persistKey = useMemo(
    () => `riwaq:stream-state:${sourceId}:${novelUrl}`,
    [sourceId, novelUrl],
  );

  // Volume ranges over the flattened spine, for the reader's Contents panel.
  // `flat` is built by walking `novel.volumes` in order and buildVirtualBook
  // numbers those chapters 0..N-1, so a running offset reproduces exactly the
  // `order`s the reader works in. Volumes a lazy source hasn't fetched yet
  // contribute no chapters and so get no range.
  const tocVolumes = useMemo<TocVolume[] | undefined>(() => {
    if (!novel) return undefined;
    const out: TocVolume[] = [];
    let offset = 0;
    novel.volumes.forEach((v, i) => {
      if (v.chapters.length === 0) return;
      out.push({
        id: `vol:${v.id}`,
        title: v.title.trim() || tr("novel.volumeFallback", { n: i + 1 }),
        start: offset,
        end: offset + v.chapters.length - 1,
      });
      offset += v.chapters.length;
    });
    // Sources with no volumes of their own return one pseudo-volume covering
    // everything. Grouping a whole novel under a single header just adds a row
    // that can hide the entire book, so those fall back to an ungrouped list.
    return out.length >= 2 ? out : undefined;
  }, [novel, tr]);

  // Library entry id, if this novel is on the shelf. When set, the
  // reader prefers offline content from `chapters/<id>/content.json`
  // and persists read flags into source.json. When null, the reader
  // behaves identically to the pre-library streaming mode (network
  // fetches, localStorage state).
  const [libraryEntryId, setLibraryEntryId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entry = await findSourceEntry(sourceId, novelUrl);
      if (!cancelled) setLibraryEntryId(entry?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, novelUrl]);

  // ── load novel + chapter stubs ──────────────────────────────────────────
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    (async () => {
      try {
        // Library-backed novels read from the persisted snapshot
        // first — the chapter listing is then identical to what the
        // detail view shows, and the reader works fully offline if
        // the relevant chapters are already downloaded.
        let fetchedNovel: SourceNovel | null = null;
        if (libraryEntryId) {
          const snap = await readSnapshot(libraryEntryId);
          if (snap) fetchedNovel = snapshotToSourceNovel(snap);
        }
        if (!fetchedNovel) {
          fetchedNovel = await source.getNovel(novelUrl);
        }
        if (cancelled) return;
        const flatList: ChapterStub[] = fetchedNovel.volumes.flatMap((v) =>
          v.chapters.map((c) => ({
            sourceId: c.id,
            title: c.title,
            url: c.url,
          })),
        );
        if (flatList.length === 0) {
          setLoadError(tr("stream.noChapters"));
          return;
        }
        const builtBook = buildVirtualBook(
          sourceId,
          novelUrl,
          fetchedNovel,
          flatList,
        );

        // Restore from persisted state, then map startChapterId if given.
        migrateStorageKey(persistKey);
        const persisted = readPersisted(persistKey);
        let initialIdx = 0;
        if (startChapterId !== undefined) {
          const i = flatList.findIndex((c) => c.sourceId === startChapterId);
          if (i >= 0) initialIdx = i;
        } else if (persisted) {
          if (typeof persisted.currentChapter === "number") {
            initialIdx = Math.max(
              0,
              Math.min(flatList.length - 1, persisted.currentChapter),
            );
          }
        }

        setNovel(fetchedNovel);
        setFlat(flatList);
        setBook(builtBook);
        if (persisted?.highlights) setHighlights(persisted.highlights);
        setCurrentChapter(initialIdx);
        setParagraphIndex(persisted?.paragraphIndex ?? 0);
        setParagraphOffset(persisted?.paragraphOffset ?? 0);
        setResumeParagraph(persisted?.paragraphIndex ?? 0);
        setResumeOffset(persisted?.paragraphOffset ?? 0);
        // Stamp lastReadAt + progress on the library entry so the Library's
        // "Continue reading" hero (and the auto-"Reading" tab) surface this
        // novel the moment it's opened — mirroring openBook → markBookOpened
        // for local EPUBs. Library-backed novels only; pure streaming
        // sessions are ephemeral and have no entry to update.
        if (libraryEntryId) {
          void updateSourceReadingPosition(
            libraryEntryId,
            initialIdx,
            flatList.length,
          );
        }
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, novelUrl, sourceId, startChapterId, persistKey, libraryEntryId, tr]);

  // ── fetch a specific chapter's content (cached) ─────────────────────────
  // Splices new chapter items into the book by producing a fresh object
  // tree (immutable update): new chapters array, new chapter object with
  // bumped `id`. The bumped id flips React's BookBody key so the empty
  // initial render gets replaced when content arrives.
  const fetchChapter = useCallback(
    async (idx: number) => {
      if (!source) return;
      const cached = cacheRef.current.get(idx);
      if (cached) {
        devLog("fetch:cacheHit", { idx, items: cached.length });
        setBook((prev) => spliceChapter(prev, idx, cached));
        return;
      }
      const stub = flat[idx];
      if (!stub) {
        devLog("fetch:noStub", { idx });
        return;
      }
      devLog("fetch:start", { idx, sourceId: stub.sourceId });
      setInFlight((prev) => {
        const next = new Set(prev);
        next.add(idx);
        return next;
      });
      setChapterErrors((prev) => {
        if (!prev.has(idx)) return prev;
        const next = new Map(prev);
        next.delete(idx);
        return next;
      });
      try {
        // Local-first: if the chapter has been downloaded into the
        // library entry, read its content.json from disk and rewrite
        // image basenames to asset:// URLs. Falls back to a network
        // fetch when the chapter isn't on disk OR when we don't have
        // a library entry to consult.
        let items: ChapterItem[] | null = null;
        if (libraryEntryId) {
          const local = await readChapterContent(
            libraryEntryId,
            stub.sourceId,
          );
          if (local) {
            items = await persistedLinesToChapterItems(
              libraryEntryId,
              stub.sourceId,
              local.lines,
            );
          }
        }
        if (!items) {
          const lines = await source.getChapterContent({
            id: stub.sourceId,
            title: stub.title,
            url: stub.url,
            lines: [],
          });
          items = await sourceLinesToChapterItems(lines, source);
        }
        cacheRef.current.set(idx, items);
        devLog("fetch:done", { idx, items: items.length });
        setBook((prev) => spliceChapter(prev, idx, items!));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        devLog("fetch:error", { idx, message });
        setChapterErrors((prev) => new Map(prev).set(idx, message));
      } finally {
        setInFlight((prev) => {
          if (!prev.has(idx)) return prev;
          const next = new Set(prev);
          next.delete(idx);
          return next;
        });
      }
    },
    [source, flat, libraryEntryId],
  );

  // Resolve the next chapter's availability whenever the position moves. A
  // chapter already in the session cache is instant; otherwise ask the disk,
  // since a downloaded chapter opens without a round trip and an undownloaded
  // one does not.
  useEffect(() => {
    if (!book) return;
    const next = currentChapter + 1;
    if (next >= book.chapters.length) {
      setNextAvailability(undefined);
      return;
    }
    if (cacheRef.current.has(next)) {
      setNextAvailability("device");
      return;
    }
    const stub = flat[next];
    if (!libraryEntryId || !stub) {
      setNextAvailability("online");
      return;
    }
    let cancelled = false;
    void chapterIsDownloaded(libraryEntryId, stub.sourceId).then((on) => {
      if (!cancelled) setNextAvailability(on ? "device" : "online");
    });
    return () => {
      cancelled = true;
    };
  }, [book, currentChapter, flat, libraryEntryId]);

  // Fetch on chapter change + prefetch the next one in the background.
  useEffect(() => {
    if (!book) return;
    void fetchChapter(currentChapter);
    // Prefetch — don't await, don't surface errors here. Next-chapter
    // load becomes instant when the user advances naturally.
    if (currentChapter + 1 < book.chapters.length) {
      void fetchChapter(currentChapter + 1);
    }
  }, [book, currentChapter, fetchChapter]);

  // ── persistence ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!book) return;
    writePersisted(persistKey, {
      currentChapter,
      paragraphIndex,
      paragraphOffset,
      highlights,
    });
  }, [book, persistKey, currentChapter, paragraphIndex, paragraphOffset, highlights]);

  // ── reader callbacks ───────────────────────────────────────────────────
  const onChapterChange = useCallback(
    (order: number) => {
      if (!book) return;
      const clamped = Math.max(0, Math.min(book.chapters.length - 1, order));
      // Mark the chapter we're leaving as read — moving forward (or
      // backward) past a chapter is a strong "I've engaged with this"
      // signal, the same intent the existing library reader uses for
      // updateReadingPosition. Only persist when this novel has a
      // library entry; pure streaming sessions are ephemeral.
      const prev = currentChapter;
      if (libraryEntryId && prev !== clamped) {
        const stub = flat[prev];
        if (stub) {
          void markChapterRead(libraryEntryId, stub.sourceId);
        }
      }
      // Advance the library entry's lastReadAt + progress to the chapter the
      // user just moved to, so "Continue reading" tracks the streaming reader
      // the same way updateReadingPosition tracks the local reader.
      if (libraryEntryId) {
        void updateSourceReadingPosition(
          libraryEntryId,
          clamped,
          book.chapters.length,
        );
      }
      setCurrentChapter(clamped);
      // New chapter starts at the top — match the library reader's
      // behavior so the user never lands halfway through chapter N+1
      // after pressing next-chapter.
      setResumeParagraph(0);
      setParagraphIndex(0);
      setResumeOffset(0);
      setParagraphOffset(0);
    },
    [book, currentChapter, libraryEntryId, flat],
  );

  const onParagraphChange = useCallback(
    (idx: number, offset?: number) => {
      setParagraphIndex(idx);
      setParagraphOffset(offset ?? 0);
      // Hitting the last paragraph of a chapter is the second "read"
      // signal — the user scrolled all the way through. We persist
      // here too so a chapter the user finishes without advancing to
      // the next (e.g. the last chapter, or pausing at the end)
      // still gets dimmed in the volumes accordion.
      if (!libraryEntryId || !book) return;
      const ch = book.chapters[currentChapter];
      if (!ch) return;
      const last = (ch.paragraphs?.length ?? 0) - 1;
      if (last >= 0 && idx >= last) {
        const stub = flat[currentChapter];
        if (stub) {
          void markChapterRead(libraryEntryId, stub.sourceId);
        }
      }
    },
    [book, currentChapter, libraryEntryId, flat],
  );

  const onCreateHighlight = useCallback(
    (input: {
      chapter: number;
      paragraphIndex: number;
      charStart: number;
      charEnd: number;
      text: string;
      color: HighlightColor;
      note?: string;
    }) => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setHighlights((prev) => [
        ...prev,
        { ...input, id, ts: Date.now() },
      ]);
    },
    [],
  );

  const onDeleteHighlight = useCallback((id: string) => {
    setHighlights((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const onUpdateHighlightNote = useCallback((id: string, note: string) => {
    const trimmed = note.trim();
    setHighlights((prev) =>
      prev.map((h) =>
        h.id === id ? { ...h, note: trimmed.length > 0 ? trimmed : undefined } : h,
      ),
    );
  }, []);

  const onJumpToHighlight = useCallback(
    (h: Highlight) => {
      if (!book) return;
      setCurrentChapter(h.chapter);
      setResumeParagraph(h.paragraphIndex);
      setParagraphIndex(h.paragraphIndex);
      // A highlight jump lands at the paragraph's top, not a stale offset.
      setResumeOffset(0);
      setParagraphOffset(0);
      // Bump even on same-chapter, same-paragraph jumps so the reader's
      // scroll effect re-fires and lands on the highlight.
      setJumpNonce((n) => n + 1);
    },
    [book],
  );

  // Esc closes the streaming reader (matching the rest of the panels'
  // conventions).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── render ──────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <FullPaneError theme={theme} message={loadError} onClose={onClose} />
    );
  }
  if (!book || !novel) {
    return <FullPaneLoading theme={theme} label={tr("stream.loadingNovel")} />;
  }

  const state: BookState = {
    bookId: book.id,
    currentChapter,
    paragraphIndex,
    highlights,
  };

  const currentItems = book.chapters[currentChapter]?.paragraphs ?? [];
  const overlay = chapterOverlay(
    currentChapter,
    currentItems.length,
    inFlight,
    chapterErrors,
  );

  return (
    <div
      // Reader CHROME (this wrapper, plus the chapter loading/error
      // overlays below) follows the UI language. DesktopReader /
      // MobileReader set their own `dir={dir}` on their own root too
      // (belt-and-suspenders — see their own comments); the scraped
      // chapter CONTENT they render sets its own direction further down,
      // independent of this `dir`, from the book's own language.
      dir={dir}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        background: theme.bg,
      }}
    >
      {layout === "mobile" ? (
        <MobileReader
          theme={theme}
          themeKey={themeKey}
          t={t}
          setTweak={setTweak}
          book={book}
          state={state}
          currentChapter={currentChapter}
          resumeParagraph={resumeParagraph}
          resumeOffset={resumeOffset}
          jumpNonce={jumpNonce}
          onChapterChange={onChapterChange}
          onParagraphChange={onParagraphChange}
          onCreateHighlight={onCreateHighlight}
          onDeleteHighlight={onDeleteHighlight}
          onUpdateHighlightNote={onUpdateHighlightNote}
          onJumpToHighlight={onJumpToHighlight}
          tocVolumes={tocVolumes}
          nextChapterAvailability={nextAvailability}
          onBack={onClose}
        />
      ) : (
        <DesktopReader
          theme={theme}
          themeKey={themeKey}
          t={t}
          setTweak={setTweak}
          book={book}
          state={state}
          currentChapter={currentChapter}
          resumeParagraph={resumeParagraph}
          resumeOffset={resumeOffset}
          jumpNonce={jumpNonce}
          onChapterChange={onChapterChange}
          onParagraphChange={onParagraphChange}
          onCreateHighlight={onCreateHighlight}
          onDeleteHighlight={onDeleteHighlight}
          onUpdateHighlightNote={onUpdateHighlightNote}
          onJumpToHighlight={onJumpToHighlight}
          tocVolumes={tocVolumes}
          nextChapterAvailability={nextAvailability}
          activePanel={activePanel}
          setActivePanel={setActivePanel}
          onBack={onClose}
        />
      )}

      {overlay.kind === "loading" && <ChapterLoadingOverlay theme={theme} />}
      <OverlayLog kind={overlay.kind} chapter={currentChapter} items={currentItems.length} />
      {overlay.kind === "error" && (
        <ChapterErrorOverlay
          theme={theme}
          message={overlay.message}
          onRetry={() => {
            cacheRef.current.delete(currentChapter);
            void fetchChapter(currentChapter);
          }}
          onBack={onClose}
        />
      )}
    </div>
  );
}

/** Dev-only: records which overlay is up, so the log distinguishes "blank" from
 *  "loading spinner showing". Renders nothing. */
function OverlayLog({
  kind,
  chapter,
  items,
}: {
  kind: string;
  chapter: number;
  items: number;
}) {
  useEffect(() => {
    devLog("overlay", { kind, chapter, items });
  }, [kind, chapter, items]);
  return null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function buildVirtualBook(
  sourceId: string,
  novelUrl: string,
  novel: SourceNovel,
  flat: ChapterStub[],
): EpubBook {
  const chapters: EpubChapter[] = flat.map((c, i) => ({
    // Each chapter's id encodes its URL so BookBody can pick a stable
    // React key. The fragment after `#` is bumped when content lands
    // (see fetchChapter); React then re-mounts BookBody with the real
    // paragraphs.
    id: `${c.url}#0`,
    href: c.url,
    title: c.title,
    paragraphs: [],
    order: i,
  }));
  return {
    id: `stream:${sourceId}:${novelUrl}`,
    title: novel.title,
    author: novel.author,
    language: novel.language,
    chapters,
  };
}

async function sourceLinesToChapterItems(
  lines: SourceLine[],
  source: Source,
): Promise<ChapterItem[]> {
  const out: ChapterItem[] = [];
  for (const l of lines) {
    if (l.type !== "image") {
      out.push({ text: l.content });
      continue;
    }
    // Source-resolved images (e.g. PDF-extracted) come back as bytes —
    // inline them as a data: URL the webview renders directly. Real URLs
    // are used as-is (the browser fetches them).
    const resolved = await source.resolveImage?.(l.content);
    if (resolved) {
      out.push({ src: await bytesToDataUrl(resolved.bytes, resolved.mimeType), alt: "" });
    } else {
      out.push({ src: l.content, alt: "" });
    }
  }
  return out;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    // Cast to BlobPart (not bytes.buffer) so a non-zero byteOffset/byteLength
    // view would still copy only its own bytes, not the whole backing buffer.
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mimeType }));
  });
}

/** Same as `sourceLinesToChapterItems` but for the persisted shape,
 *  where image lines reference a local basename (img-001.webp) rather
 *  than an absolute URL. Each basename is resolved to an asset:// URL
 *  the webview can render directly. Image resolution failures (e.g.
 *  the file was deleted out-of-band) fall back to a text placeholder
 *  so the chapter still reads cleanly. */
async function persistedLinesToChapterItems(
  entryId: string,
  chapterId: number,
  lines: SourceLine[],
): Promise<ChapterItem[]> {
  const out: ChapterItem[] = [];
  for (const l of lines) {
    if (l.type === "text") {
      out.push({ text: l.content });
      continue;
    }
    // image line: try to resolve the local basename. If `content` is
    // already an absolute URL (a chapter downloaded before we
    // rewrote URLs to basenames), use it verbatim.
    if (/^https?:\/\//i.test(l.content)) {
      out.push({ src: l.content, alt: "" });
      continue;
    }
    const src = await chapterImageSrc(entryId, chapterId, l.content);
    if (src) {
      out.push({ src, alt: "" });
    } else {
      out.push({ text: `[Missing image: ${l.content}]` });
    }
  }
  return out;
}

/** Replace a single chapter's paragraphs in an EpubBook, producing a
 *  fresh book reference (new chapters array, new chapter object). The
 *  chapter's `id` is bumped to include the new paragraph count so
 *  React's key-based reconciliation re-mounts BookBody. */
function spliceChapter(
  prev: EpubBook | null,
  idx: number,
  items: ChapterItem[],
): EpubBook | null {
  if (!prev) return prev;
  const existing = prev.chapters[idx];
  if (!existing) return prev;
  // Same content reference + same id → no-op. Saves a render cycle
  // when fetchChapter re-runs and finds the cache.
  if (existing.paragraphs === items) return prev;
  const nextChapter: EpubChapter = {
    ...existing,
    paragraphs: items,
    id: `${existing.href}#${items.length}`,
  };
  const nextChapters = prev.chapters.slice();
  nextChapters[idx] = nextChapter;
  return { ...prev, chapters: nextChapters };
}

// ── persistence ────────────────────────────────────────────────────────────

interface PersistedState {
  currentChapter: number;
  paragraphIndex: number;
  paragraphOffset?: number;
  highlights: Highlight[];
}

function readPersisted(key: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.currentChapter !== "number") return null;
    return {
      currentChapter: parsed.currentChapter,
      paragraphIndex:
        typeof parsed.paragraphIndex === "number" ? parsed.paragraphIndex : 0,
      paragraphOffset:
        typeof parsed.paragraphOffset === "number" ? parsed.paragraphOffset : 0,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
    };
  } catch {
    return null;
  }
}

function writePersisted(key: string, state: PersistedState): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // out of space or unavailable — skip silently
  }
}

// ── overlay panes ──────────────────────────────────────────────────────────

function FullPaneLoading({ theme, label }: { theme: Theme; label: string }) {
  // Standalone chrome root (this pane replaces the whole reader while the
  // novel is loading) — follows the UI direction, same as the main
  // wrapper below. There's no book content here yet to decouple from.
  const { dir } = useI18n();
  return (
    <div
      dir={dir}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT_SERIF_DISPLAY,
        fontSize: 20,
      }}
    >
      {label}
    </div>
  );
}

function FullPaneError({
  theme,
  message,
  onClose,
}: {
  theme: Theme;
  message: string;
  onClose: () => void;
}) {
  // Standalone chrome root, same reasoning as FullPaneLoading — follows
  // the UI direction. `message` is raw error data (network/parse errors,
  // or e.message) — never passed through tr().
  const { tr, dir } = useI18n();
  return (
    <div
      dir={dir}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        background: theme.bg,
        color: theme.ink,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 24,
        fontFamily: FONT_STACKS.sans,
      }}
    >
      <button
        onClick={onClose}
        aria-label={tr("common.close")}
        style={{
          position: "absolute",
          top: 16,
          // Logical inline-start so this corner button mirrors to the
          // opposite physical side under RTL, matching the rest of the
          // reader chrome's converted positioning.
          insetInlineStart: 16,
          width: 36,
          height: 36,
          borderRadius: 18,
          border: `0.5px solid ${theme.rule}`,
          background: theme.bg,
          color: theme.ink,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="close" size={16} />
      </button>
      <div style={{ fontSize: 14, color: theme.muted }}>
        {tr("stream.loadErrorTitle")}
      </div>
      <div style={{ maxWidth: 500, textAlign: "center", fontSize: 13 }}>
        {message}
      </div>
    </div>
  );
}

function ChapterLoadingOverlay({ theme }: { theme: Theme }) {
  // Nested inside the main wrapper (which already sets dir={dir}) — no
  // dir attribute of its own needed, it inherits the chrome direction.
  const { tr } = useI18n();
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1,
        background: `${theme.bg}`,
        // Lean on the same backdrop fade the lightbox uses so the
        // overlay isn't jarring — fades in over 200ms via the
        // skeleton-shimmer animation defined on the container itself.
        opacity: 0.92,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: FONT_SERIF_DISPLAY,
        fontSize: 18,
        color: theme.muted,
        pointerEvents: "none",
      }}
    >
      {tr("stream.loadingChapter")}
    </div>
  );
}

function ChapterErrorOverlay({
  theme,
  message,
  onRetry,
  onBack,
}: {
  theme: Theme;
  message: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  // Also nested inside the main wrapper — inherits dir from there.
  // `message` is raw error data — never passed through tr().
  const { tr } = useI18n();
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: `${theme.bg}f0`,
        fontFamily: FONT_STACKS.sans,
      }}
    >
      <div
        style={{
          background: theme.chrome,
          border: `0.5px solid ${theme.rule}`,
          borderRadius: 10,
          padding: 20,
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {tr("stream.chapterErrorTitle")}
        </div>
        <div style={{ fontSize: 13, color: theme.muted, lineHeight: 1.5 }}>
          {message}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onRetry}
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontFamily: "inherit",
              background: theme.ink,
              color: theme.bg,
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            {tr("common.retry")}
          </button>
          <button
            onClick={onBack}
            style={{
              padding: "8px 14px",
              fontSize: 13,
              fontFamily: "inherit",
              background: "transparent",
              color: theme.ink,
              border: `0.5px solid ${theme.rule}`,
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            {tr("stream.backToNovel")}
          </button>
        </div>
      </div>
    </div>
  );
}
