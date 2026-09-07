// Persisted state for source-backed library entries.
//
// Layout under $APPDATA/riwaq/books/<id>/:
//
//   source.json                  the novel snapshot — metadata, volumes,
//                                chapters with per-chapter flags
//   cover.<ext>                  cover (written by addNovelToLibrary)
//   chapters/<padded-id>/        per-chapter content; created on download
//     content.json               { lines: SourceLine[], fetchedAt }
//     img-001.<ext>              inline images, referenced from content.json
//                                via the bare basename (e.g. "img-001.webp")
//   state.json                   reading state — shared with EPUB entries
//
// Why source.json instead of book.json:
//  - book.json is the EPUB parse output (full chapter bodies, paragraph
//    objects, etc.). Source entries don't have a single EPUB; chapters
//    are downloaded individually and may not all be present.
//  - source.json is the canonical chapter LISTING + per-chapter flags
//    (downloadedAt, readAt). It's small (a few KB even for novels with
//    thousands of chapters) and lets the library/UI render the
//    volumes accordion offline.
//
// The chapter content lives in chapters/<id>/content.json, separately,
// so partial downloads stay efficient: re-reading the snapshot doesn't
// re-load any chapter body.

import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  remove,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import type {
  SourceChapter,
  SourceLine,
  SourceNovel,
  SourceNovelMeta,
  SourceVolume,
} from "../sources/types";
import { ROOT } from "./paths";
import { migrateLegacyRoot } from "./legacyRoot";

const BASE = BaseDirectory.AppData;
const BOOKS = `${ROOT}/books`;

// ── persisted shapes ───────────────────────────────────────────────────────

export interface PersistedSourceChapter {
  /** 1-based monotonic id across the whole novel. Matches the
   *  SourceChapter.id assigned during getNovel. */
  id: number;
  title: string;
  url: string;
  /** Epoch ms when content.json was last written. Absent = not
   *  downloaded. The presence of this field is the source of truth for
   *  "is this chapter offline-readable?". */
  downloadedAt?: number;
  /** Epoch ms when the user finished the chapter (scrolled to the
   *  end or advanced to the next). Absent = unread. */
  readAt?: number;
}

export interface PersistedSourceVolume {
  id: number;
  title: string;
  chapters: PersistedSourceChapter[];
  /** Total chapter count when the source knew it before chapters
   *  were fetched. Persisted so the volumes accordion can show
   *  "(N chapters)" before the user expands the volume + render a
   *  skeleton of the right size while lazy-loading. */
  chapterCount?: number;
  /** Opaque source-specific token mirroring SourceVolume.key. Lets
   *  the source's getVolumeChapters call recover its internal volume
   *  identifier without re-fetching the novel page. */
  key?: string;
  /** True when chapters[] was populated by an explicit fetch. The
   *  absence is the signal to lazy-load on first expand. */
  chaptersLoaded?: boolean;
}

export interface SourceSnapshot {
  version: 1;
  sourceId: string;
  novelUrl: string;
  /** Free-form display title from the source. Authoritative copy
   *  (BookIndexEntry has a duplicate to keep listing cheap). */
  title: string;
  author: string;
  originalTitle?: string;
  language: string;
  direction: "ltr" | "rtl";
  coverUrl?: string;
  description?: string;
  tags: string[];
  status?: string;
  meta: SourceNovelMeta[];
  volumes: PersistedSourceVolume[];
  /** Epoch ms when the metadata + volume listing was last fetched
   *  from the source. The detail view can show "Last updated <X>" and
   *  decide whether to refresh in the background. */
  fetchedAt: number;
}

export interface PersistedChapterContent {
  version: 1;
  id: number;
  /** Same shape as SourceLine, but image lines store the local
   *  basename (e.g. "img-001.webp") rather than an absolute URL.
   *  Reader code passes this through `chapterImageSrc(entryId, id, basename)`
   *  to get an asset:// URL. */
  lines: SourceLine[];
  fetchedAt: number;
}

// ── path helpers ───────────────────────────────────────────────────────────

function bookDir(id: string): string {
  return `${BOOKS}/${id}`;
}

function snapshotPath(entryId: string): string {
  return `${bookDir(entryId)}/source.json`;
}

function chaptersDir(entryId: string): string {
  return `${bookDir(entryId)}/chapters`;
}

function paddedChapterId(chapterId: number): string {
  return String(chapterId).padStart(5, "0");
}

function chapterDir(entryId: string, chapterId: number): string {
  return `${chaptersDir(entryId)}/${paddedChapterId(chapterId)}`;
}

function chapterContentPath(entryId: string, chapterId: number): string {
  return `${chapterDir(entryId, chapterId)}/content.json`;
}

// ── snapshot I/O ───────────────────────────────────────────────────────────

/**
 * Write the snapshot built from a freshly-fetched SourceNovel. Used by
 * addNovelToLibrary right after `source.getNovel`. Idempotent — the file
 * just gets overwritten with the latest metadata.
 *
 * Per-chapter flags (downloadedAt, readAt) are preserved when an
 * existing snapshot is present: we don't want a re-fetch to wipe the
 * user's progress. The merge keys on chapter URL since the source's id
 * sequence isn't guaranteed stable between fetches (new chapters can
 * slot in mid-volume on an updating ongoing novel).
 */
// Per-entry write serialization. source.json is a read-modify-write file:
// every mutation reads the whole snapshot, patches it, and writes it back.
// Concurrent mutations on the same entry — e.g. a range download flipping
// `downloadedAt` on several chapters at once with concurrency > 1 — would
// otherwise interleave their read and write phases and clobber each other
// (a lost update): the last writer's snapshot lacks the flags the earlier
// writers set, so middle-of-range chapters show as un-downloaded even though
// their content is already on disk. Funnel every read-modify-write for an
// entry through a per-entry promise chain so they run strictly sequentially.
const entryWriteLocks = new Map<string, Promise<unknown>>();

function withEntryLock<T>(
  entryId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = entryWriteLocks.get(entryId) ?? Promise.resolve();
  // Chain onto the tail whether it resolved or rejected, so one failed
  // mutation doesn't wedge the queue for the entry.
  const run = prev.then(fn, fn);
  // Store a rejection-swallowed tail so the next waiter's `prev.then`
  // doesn't reject before its own `fn` runs.
  entryWriteLocks.set(
    entryId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Serialized entry point — the read-modify-write body is in
 *  writeSnapshotFromSourceNovelImpl, run under the per-entry lock so it
 *  can't interleave with a concurrent snapshot mutation for the same entry. */
export async function writeSnapshotFromSourceNovel(
  entryId: string,
  sourceId: string,
  novelUrl: string,
  novel: SourceNovel,
): Promise<SourceSnapshot> {
  return withEntryLock(entryId, () =>
    writeSnapshotFromSourceNovelImpl(entryId, sourceId, novelUrl, novel),
  );
}

async function writeSnapshotFromSourceNovelImpl(
  entryId: string,
  sourceId: string,
  novelUrl: string,
  novel: SourceNovel,
): Promise<SourceSnapshot> {
  await migrateLegacyRoot();
  const dir = bookDir(entryId);
  if (!(await exists(dir, { baseDir: BASE }))) {
    await mkdir(dir, { baseDir: BASE, recursive: true });
  }

  const prev = await readSnapshot(entryId);
  const prevByUrl = new Map<string, PersistedSourceChapter>();
  if (prev) {
    for (const v of prev.volumes) {
      for (const c of v.chapters) {
        prevByUrl.set(c.url, c);
      }
    }
  }

  // Volume-level merge. We carry forward the chapters of any volume
  // that the prior snapshot had marked `chaptersLoaded` — the
  // incoming `novel.volumes` may have empty chapters[] (lazy sources)
  // and we don't want to lose listings the user already expanded.
  const prevVolByKey = new Map<string, PersistedSourceVolume>();
  const prevVolById = new Map<number, PersistedSourceVolume>();
  if (prev) {
    for (const v of prev.volumes) {
      if (v.key !== undefined) prevVolByKey.set(v.key, v);
      prevVolById.set(v.id, v);
    }
  }

  const volumes: PersistedSourceVolume[] = novel.volumes.map((v) => {
    const prevVol =
      (v.key !== undefined ? prevVolByKey.get(v.key) : undefined) ??
      prevVolById.get(v.id);
    const incomingHasChapters = v.chapters.length > 0;
    // Three cases:
    //   1. incoming chapters populated → use them (with prior flags
    //      merged by URL).
    //   2. incoming empty + prior had chapters → carry the prior
    //      chapters forward, with their flags.
    //   3. both empty → leave empty; lazy fetch will fill later.
    let chapters: PersistedSourceChapter[];
    let chaptersLoaded = false;
    if (incomingHasChapters) {
      chapters = v.chapters.map<PersistedSourceChapter>((c) => {
        const carry = prevByUrl.get(c.url);
        return {
          id: c.id,
          title: c.title,
          url: c.url,
          ...(carry?.downloadedAt ? { downloadedAt: carry.downloadedAt } : {}),
          ...(carry?.readAt ? { readAt: carry.readAt } : {}),
        };
      });
      chaptersLoaded = true;
    } else if (prevVol && prevVol.chapters.length > 0) {
      chapters = prevVol.chapters;
      chaptersLoaded = prevVol.chaptersLoaded ?? true;
    } else {
      chapters = [];
      chaptersLoaded = false;
    }
    return {
      id: v.id,
      title: v.title,
      chapters,
      chapterCount: v.chapterCount ?? prevVol?.chapterCount ?? chapters.length,
      key: v.key ?? prevVol?.key,
      chaptersLoaded,
    };
  });

  const snapshot: SourceSnapshot = {
    version: 1,
    sourceId,
    novelUrl,
    title: novel.title,
    author: novel.author,
    originalTitle: novel.originalTitle,
    language: novel.language,
    direction: novel.direction,
    coverUrl: novel.coverUrl,
    description: novel.description,
    tags: novel.tags,
    status: novel.status,
    meta: novel.meta,
    volumes,
    fetchedAt: Date.now(),
  };

  await writeTextFile(snapshotPath(entryId), JSON.stringify(snapshot), {
    baseDir: BASE,
  });
  return snapshot;
}

export async function readSnapshot(
  entryId: string,
): Promise<SourceSnapshot | null> {
  const path = snapshotPath(entryId);
  if (!(await exists(path, { baseDir: BASE }))) return null;
  try {
    const raw = await readTextFile(path, { baseDir: BASE });
    const parsed = JSON.parse(raw) as SourceSnapshot;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Convert the persisted shape back into the SourceNovel shape callers
 *  already know how to render. Identical to the data the source returned
 *  at fetch time, plus the persisted per-chapter flags exposed
 *  through a parallel `chapters[].downloadedAt / readAt` lookup. */
export function snapshotToSourceNovel(snapshot: SourceSnapshot): SourceNovel {
  return {
    title: snapshot.title,
    author: snapshot.author,
    originalTitle: snapshot.originalTitle,
    language: snapshot.language,
    direction: snapshot.direction,
    coverUrl: snapshot.coverUrl,
    description: snapshot.description,
    tags: snapshot.tags,
    status: snapshot.status,
    meta: snapshot.meta,
    volumes: snapshot.volumes.map<SourceVolume>((v) => ({
      id: v.id,
      title: v.title,
      chapters: v.chapters.map<SourceChapter>((c) => ({
        id: c.id,
        title: c.title,
        url: c.url,
        lines: [],
      })),
      ...(v.chapterCount !== undefined ? { chapterCount: v.chapterCount } : {}),
      ...(v.key !== undefined ? { key: v.key } : {}),
    })),
  };
}

/** Write a single volume's freshly-fetched chapter list into the
 *  snapshot. Used by the lazy-volume path: NovelDetailView calls
 *  source.getVolumeChapters → stuffs the result back here so the
 *  volume sticks across reopens.
 *
 *  Merge semantics:
 *   - chapters are replaced wholesale by the incoming list (the
 *     source-side ordering wins).
 *   - per-chapter flags (downloadedAt, readAt) are preserved by
 *     URL — a previously-downloaded chapter that re-appears in
 *     the same volume keeps its flag without losing data on disk.
 *   - chaptersLoaded flips to true. */
export async function setVolumeChapters(
  entryId: string,
  volumeId: number,
  chapters: SourceChapter[],
): Promise<SourceSnapshot | null> {
  return withEntryLock(entryId, () =>
    setVolumeChaptersImpl(entryId, volumeId, chapters),
  );
}

async function setVolumeChaptersImpl(
  entryId: string,
  volumeId: number,
  chapters: SourceChapter[],
): Promise<SourceSnapshot | null> {
  const snap = await readSnapshot(entryId);
  if (!snap) return null;
  const vol = snap.volumes.find((v) => v.id === volumeId);
  if (!vol) return null;
  const prevByUrl = new Map<string, PersistedSourceChapter>();
  for (const c of vol.chapters) prevByUrl.set(c.url, c);
  vol.chapters = chapters.map<PersistedSourceChapter>((c) => {
    const carry = prevByUrl.get(c.url);
    return {
      id: c.id,
      title: c.title,
      url: c.url,
      ...(carry?.downloadedAt ? { downloadedAt: carry.downloadedAt } : {}),
      ...(carry?.readAt ? { readAt: carry.readAt } : {}),
    };
  });
  vol.chaptersLoaded = true;
  // Update chapterCount to reflect what we actually got back —
  // useful when the upstream count was stale.
  vol.chapterCount = chapters.length;
  await writeTextFile(snapshotPath(entryId), JSON.stringify(snap), {
    baseDir: BASE,
  });
  return snap;
}

// ── chapter flag mutations ─────────────────────────────────────────────────

/** Update a single chapter's flags in source.json. The mutator can
 *  return null to leave it unchanged; otherwise the partial it returns
 *  is merged over the existing record. Returns the new snapshot so
 *  callers can re-render the UI without a separate read. */
function patchChapter(
  entryId: string,
  chapterId: number,
  mutator: (
    c: PersistedSourceChapter,
  ) => Partial<PersistedSourceChapter> | null,
): Promise<SourceSnapshot | null> {
  return withEntryLock(entryId, () =>
    patchChapterImpl(entryId, chapterId, mutator),
  );
}

async function patchChapterImpl(
  entryId: string,
  chapterId: number,
  mutator: (
    c: PersistedSourceChapter,
  ) => Partial<PersistedSourceChapter> | null,
): Promise<SourceSnapshot | null> {
  const snap = await readSnapshot(entryId);
  if (!snap) return null;
  let changed = false;
  for (const v of snap.volumes) {
    for (let i = 0; i < v.chapters.length; i++) {
      const c = v.chapters[i];
      if (c.id !== chapterId) continue;
      const patch = mutator(c);
      if (!patch) return snap;
      v.chapters[i] = { ...c, ...patch };
      changed = true;
      break;
    }
    if (changed) break;
  }
  if (!changed) return snap;
  await writeTextFile(snapshotPath(entryId), JSON.stringify(snap), {
    baseDir: BASE,
  });
  return snap;
}

export async function markChapterDownloaded(
  entryId: string,
  chapterId: number,
  ts: number = Date.now(),
): Promise<SourceSnapshot | null> {
  return patchChapter(entryId, chapterId, () => ({ downloadedAt: ts }));
}

export async function markChapterRead(
  entryId: string,
  chapterId: number,
  ts: number = Date.now(),
): Promise<SourceSnapshot | null> {
  return patchChapter(entryId, chapterId, (c) =>
    c.readAt ? null : { readAt: ts },
  );
}

export async function markChapterUnread(
  entryId: string,
  chapterId: number,
): Promise<SourceSnapshot | null> {
  return patchChapter(entryId, chapterId, (c) => {
    if (!c.readAt) return null;
    const next: Partial<PersistedSourceChapter> = { readAt: undefined };
    return next;
  });
}

/** Drop N chapters' downloaded content in one pass: sweep each
 *  directory, then patch the snapshot ONCE.
 *
 *  Why batched. patchChapter reads and rewrites the whole source.json
 *  per call, and source.json holds every chapter of the novel. Looping
 *  the single-chapter version over a 950-chapter volume is 950 full
 *  read+write cycles — minutes of jank on Android, and a crash halfway
 *  leaves the snapshot and the disk disagreeing about what's on disk.
 *
 *  Returns the ids actually cleared so the caller can report a truthful
 *  count. A chapter whose directory is already gone still counts as
 *  removed: the flag is what makes a chapter "downloaded", so clearing
 *  it is the operation that matters.
 *
 *  Never touches readAt. Deleting a download frees disk; it does not
 *  reset the user's reading progress. */
export async function deleteChapterDownloads(
  entryId: string,
  chapterIds: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ removed: number[]; snapshot: SourceSnapshot | null }> {
  if (chapterIds.length === 0) return { removed: [], snapshot: null };
  return withEntryLock(entryId, () =>
    deleteChapterDownloadsImpl(entryId, chapterIds, onProgress),
  );
}

async function deleteChapterDownloadsImpl(
  entryId: string,
  chapterIds: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ removed: number[]; snapshot: SourceSnapshot | null }> {
  const snap = await readSnapshot(entryId);
  if (!snap) return { removed: [], snapshot: null };

  const wanted = new Set(chapterIds);
  const total = chapterIds.length;
  let done = 0;

  for (const chapterId of chapterIds) {
    const dir = chapterDir(entryId, chapterId);
    try {
      // Recursive on purpose: a chapter directory holds content.json
      // plus inline images, and a per-file sweep would miss any
      // subdirectory while the flag below still flips.
      await remove(dir, { baseDir: BASE, recursive: true });
    } catch {
      // Already gone, or the platform refused. Either way the flag
      // still has to clear — a stale downloadedAt pointing at nothing
      // is the one state the reader can't recover from.
    }
    done++;
    // Throttled: a 900-chapter sweep would otherwise push 900 React
    // updates through a progress line nobody reads that closely.
    if (done % 25 === 0 || done === total) onProgress?.(done, total);
  }

  const removed: number[] = [];
  for (const v of snap.volumes) {
    for (let i = 0; i < v.chapters.length; i++) {
      const c = v.chapters[i];
      if (!wanted.has(c.id)) continue;
      removed.push(c.id);
      // Rebuild without downloadedAt rather than assigning undefined,
      // so the field is genuinely absent. readAt is carried across
      // explicitly — this is the line that must never regress.
      const { downloadedAt: _dropped, ...rest } = c;
      v.chapters[i] = rest;
    }
  }

  if (removed.length === 0) {
    // Nothing in the listing matched, so the snapshot would go back to
    // disk byte-identical. On a 950-chapter novel that is a multi-MB
    // serialize and write bought for no change at all.
    return { removed, snapshot: snap };
  }

  await writeTextFile(snapshotPath(entryId), JSON.stringify(snap), {
    baseDir: BASE,
  });
  return { removed, snapshot: snap };
}

/** Drop one chapter's downloaded content + image files, and clear its
 *  downloadedAt flag. Thin wrapper over the batch version so there is
 *  exactly one delete code path to reason about and test. */
export async function deleteChapterDownload(
  entryId: string,
  chapterId: number,
): Promise<SourceSnapshot | null> {
  const { snapshot } = await deleteChapterDownloads(entryId, [chapterId]);
  return snapshot;
}

// ── chapter content I/O ────────────────────────────────────────────────────

/** True when the chapter has been downloaded to disk (content.json
 *  exists). Cheaper than reading the snapshot for a single check. */
export async function chapterIsDownloaded(
  entryId: string,
  chapterId: number,
): Promise<boolean> {
  return exists(chapterContentPath(entryId, chapterId), { baseDir: BASE });
}

export async function readChapterContent(
  entryId: string,
  chapterId: number,
): Promise<PersistedChapterContent | null> {
  const path = chapterContentPath(entryId, chapterId);
  if (!(await exists(path, { baseDir: BASE }))) return null;
  try {
    const raw = await readTextFile(path, { baseDir: BASE });
    const parsed = JSON.parse(raw) as PersistedChapterContent;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write a chapter's downloaded content + inline image files in one
 *  call. The `lines` argument is in its persisted form already —
 *  image lines must reference local basenames, not remote URLs.
 *  Callers building the lines from a network scrape are expected to
 *  rewrite image URLs before passing them in. */
export async function writeChapterContent(
  entryId: string,
  chapterId: number,
  lines: SourceLine[],
  imageFiles: Array<{ basename: string; bytes: Uint8Array }>,
): Promise<void> {
  await migrateLegacyRoot();
  const dir = chapterDir(entryId, chapterId);
  if (!(await exists(dir, { baseDir: BASE }))) {
    await mkdir(dir, { baseDir: BASE, recursive: true });
  }
  for (const img of imageFiles) {
    await writeFile(`${dir}/${img.basename}`, img.bytes, { baseDir: BASE });
  }
  const payload: PersistedChapterContent = {
    version: 1,
    id: chapterId,
    lines,
    fetchedAt: Date.now(),
  };
  await writeTextFile(chapterContentPath(entryId, chapterId), JSON.stringify(payload), {
    baseDir: BASE,
  });
}

/** Resolve a chapter image basename to an asset:// URL the webview can
 *  load. Mirrors coverSrcFor in library.ts. Returns null on filesystem
 *  errors — callers should fall back to the original remote URL when
 *  the asset path can't be resolved. */
export async function chapterImageSrc(
  entryId: string,
  chapterId: number,
  basename: string,
  cacheBuster?: number,
): Promise<string | null> {
  try {
    const root = await appDataDir();
    const abs = await join(
      root,
      ROOT,
      "books",
      entryId,
      "chapters",
      paddedChapterId(chapterId),
      basename,
    );
    const url = convertFileSrc(abs);
    return cacheBuster ? `${url}?v=${cacheBuster}` : url;
  } catch {
    return null;
  }
}

// ── stats convenience ─────────────────────────────────────────────────────

export interface SnapshotStats {
  chapterCount: number;
  downloadedCount: number;
  readCount: number;
}

export function statsFromSnapshot(snapshot: SourceSnapshot): SnapshotStats {
  let downloadedCount = 0;
  let readCount = 0;
  let chapterCount = 0;
  for (const v of snapshot.volumes) {
    for (const c of v.chapters) {
      chapterCount++;
      if (c.downloadedAt) downloadedCount++;
      if (c.readAt) readCount++;
    }
  }
  return { chapterCount, downloadedCount, readCount };
}

/** Flat list of (volume, chapter) pairs in their natural source order —
 *  for pickers and the importer-style "all chapters" iteration. */
export interface FlatPersistedChapter {
  volumeId: number;
  volumeTitle: string;
  chapter: PersistedSourceChapter;
}

export function flattenSnapshotChapters(
  snapshot: SourceSnapshot,
): FlatPersistedChapter[] {
  const out: FlatPersistedChapter[] = [];
  for (const v of snapshot.volumes) {
    for (const c of v.chapters) {
      out.push({ volumeId: v.id, volumeTitle: v.title, chapter: c });
    }
  }
  return out;
}
