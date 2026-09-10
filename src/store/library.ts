// Local library — persists books + per-book reading state under
// Tauri's app-data dir. Each book ships as up to four files:
//
//   books/<id>/book.json   the parsed EpubBook (chapters + metadata)
//   books/<id>/book.epub   the original zip, kept so covers can be re-scanned
//                          without asking the user to re-pick the file
//   books/<id>/state.json  per-book reading state (chapter index, timestamps)
//   books/<id>/cover.<ext> the extracted cover image (when one exists)
//
// A single library.json indexes the set so the Library view can render a
// list without opening every book.json. This also lets us cheaply show
// `lastReadAt`, `progress`, etc. without reloading chapters.

import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";
import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FixedImportDraft } from "./fixedImportStage";
import type { HighlightColor } from "../styles/tokens";
import { isOpaqueUri, type BookFormat } from "./bookFormat";
import { parseEpubFromSource } from "../epub/parser";
import { openNativeZip } from "../epub/zipSource";
import { writeImageManifest } from "./epubImages";
import { BOOKS, bookDir, INDEX, ROOT, STAGING } from "./paths";
import { migrateLegacyRoot } from "./legacyRoot";
// Re-exported because callers across the app import `bookDir` from here.
export { bookDir };
import {
  deleteStaged,
  newStagingToken,
  onStageProgress,
  renameStaged,
  stageImportFile,
  writeBytesChunked,
  type StageProgress,
} from "./nativeStaging";
import type { EpubBook } from "../epub/types";
import type { TocEntry } from "../types/reader";
import { makeTr, type Locale } from "../i18n";
import { findByHash } from "./dedupe";

/** Best-effort current UI locale. This module runs outside the component
 *  tree (plain store functions, no React context available), so it reads
 *  `document.documentElement.lang` instead of `useI18n()` — App.tsx keeps
 *  that attribute in sync with the user's UI-language preference. Same
 *  pattern as `currentUiLocale()` in kolnovel-theme.ts / cenele.ts /
 *  downloadNotifier.ts. */
function currentUiLocale(): Locale {
  if (typeof document !== "undefined" && document.documentElement.lang === "ar") {
    return "ar";
  }
  return "en";
}

const BASE = BaseDirectory.AppData;
// Storage layout lives in ./paths so nothing has to re-type the root folder
// name. STAGING is kept out of books/ so a cancelled PDF/DOCX import never
// leaves a half-built book directory behind.

export type BookStatus = "reading" | "finished" | "wishlist";

export interface BookIndexEntry {
  id: string;
  title: string;
  author: string;
  language: string;
  chapterCount: number;
  addedAt: number;
  lastReadAt?: number;
  /** 0..1, derived from currentChapter / chapterCount. */
  progress: number;
  /** Filename of the cover under `books/<id>/`, when the EPUB shipped one. */
  coverFile?: string;
  /**
   * Timestamp set whenever the cover file is rewritten — appended to the
   * asset URL so the webview's cache doesn't hide the new image.
   */
  coverBust?: number;
  /** Free-form description shown in the library's edit dialog. */
  description?: string;
  /** User-managed reading status. Drives the top-tabs filter and is set
      via the right-click menu on a shelf card. Undefined for older books
      that predate this field. */
  status?: BookStatus;
  /** Ids of the shelves this book is on (see store/shelves.ts). Absent on
   *  older entries → treated as []. A book can be on multiple shelves. */
  shelfIds?: string[];
  /** Lowercase hex SHA-256 of the file this book was imported from. Absent
   *  on books imported before dedup existed, and on books that never came
   *  from a file at all (source bookmarks). Lets a repeat "Open with" of
   *  the same file reuse this entry — reading position and highlights
   *  intact — instead of adding a second copy. Not backfilled. */
  sourceHash?: string;
  /** What kind of library entry this is. Older entries (and any EPUB
   *  import) don't carry the field — they're treated as "epub" by callers.
   *  "source" entries are lightweight bookmarks: no book.json, no book.epub
   *  on disk; the chapter list and content live on the source website and are
   *  fetched on demand. "pdf" / "docx" are fixed-layout books read as rendered
   *  pages — page-based progress/resume, not chapters. */
  kind?: "epub" | "source" | "pdf" | "docx";
  /** Total fixed pages. Present only on kind "pdf" | "docx"; drives page-based
   *  progress and the page counter. */
  pageCount?: number;
  /** Source extension id (e.g. "kolnovel"). Present only on
   *  kind === "source" entries. */
  sourceId?: string;
  /** Novel index page URL — the canonical handle this source uses to
   *  identify the novel. Present only on kind === "source" entries. */
  novelUrl?: string;
}

export interface BookState {
  bookId: string;
  currentChapter: number;
  /** Index of the topmost-visible paragraph within currentChapter. Lets the
      reader resume from the same scroll position, not just the chapter. */
  paragraphIndex: number;
  /** 0..1 — how far the viewport top sits INTO the topmost-visible paragraph,
      so resume lands at the exact scroll position, not just the paragraph top.
      Absent on older saves and on paginated captures → treated as 0. */
  paragraphOffset?: number;
  /** Fixed-page (PDF/DOCX) resume: current page (0-based). Absent on reflow. */
  currentPage?: number;
  /** 0..1 scroll offset within `currentPage` (scroll flow only). */
  pageOffset?: number;
  /** DOCX only — a reflow-stable content anchor (nearest block id + intra-block
      fraction) so resume survives re-pagination when the page box changes. */
  fixedAnchor?: { blockId: string; frac: number };
  /** Mutable over time — drives the Highlights panel. Empty on a freshly
      imported book. */
  highlights: Highlight[];
}

/** Fixed-layout (DOCX) highlight anchor: a stable block id + intra-block char
 *  range. Block ids are assigned once at parse (before pagination), so the
 *  anchor survives re-pagination when the page box changes. */
export interface DocxHighlightAnchor {
  fmt: "docx";
  blockId: string;
  /** Inclusive char offset within the block's text content. */
  charStart: number;
  /** Exclusive char offset. */
  charEnd: number;
}

/** A rectangle expressed as fractions (0..1) of the page box, so it survives
 *  zoom/fit changes — multiply by the current display size to draw it. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fixed-layout (PDF) highlight anchor: a page plus the page-normalized
 *  rectangles covering the selected text (PDF pages don't reflow, so the page
 *  index is stable and rects only need scaling). */
export interface PdfHighlightAnchor {
  fmt: "pdf";
  page: number;
  rects: NormRect[];
}

export interface Highlight {
  id: string;
  chapter: number;
  /** Paragraph index within the chapter — matches the `data-p-index` we
      render on each paragraph element so highlights can be re-anchored
      when the same chapter is re-rendered, and so the sidebar can jump
      back to the exact spot. */
  paragraphIndex: number;
  /** Inclusive char offset of the first highlighted character within the
      paragraph's plain text. */
  charStart: number;
  /** Exclusive char offset — the first character after the highlight. */
  charEnd: number;
  text: string;
  note?: string;
  /** One of the palette's keys. Kept as the shared type rather than a
   *  second copy of the union, so adding a hue cannot leave the store
   *  and the picker disagreeing. */
  color: HighlightColor;
  ts: number;
  /** Fixed-layout anchor. Present ONLY on PDF/DOCX highlights — when set, the
   *  reflow fields above (chapter/paragraphIndex/charStart/charEnd) are unused
   *  (0) and this drives jump + render instead. Absent on every EPUB
   *  highlight, so the reflow pipeline is unaffected. */
  fixed?: DocxHighlightAnchor | PdfHighlightAnchor;
  /** When a selection spans multiple paragraphs, every highlight created
   *  from that one user gesture shares the same groupId. Tap-to-delete
   *  on any member deletes the whole group so the user sees a single
   *  logical highlight (even though storage is per-paragraph). Absent
   *  on single-paragraph highlights and on legacy saves that pre-date
   *  this field. */
  groupId?: string;
}

interface LibraryFile {
  version: 1;
  books: BookIndexEntry[];
}

// ── low-level fs helpers ──────────────────────────────────────────────────

export async function ensureRoot() {
  await migrateLegacyRoot();
  for (const dir of [ROOT, BOOKS, STAGING]) {
    if (!(await exists(dir, { baseDir: BASE }))) {
      await mkdir(dir, { baseDir: BASE, recursive: true });
    }
  }
}

async function readIndex(): Promise<LibraryFile> {
  await ensureRoot();
  if (!(await exists(INDEX, { baseDir: BASE }))) {
    return { version: 1, books: [] };
  }
  try {
    const raw = await readTextFile(INDEX, { baseDir: BASE });
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.books))
      return { version: 1, books: parsed.books };
    return { version: 1, books: [] };
  } catch {
    return { version: 1, books: [] };
  }
}

async function writeIndex(idx: LibraryFile) {
  await ensureRoot();
  await writeTextFile(INDEX, JSON.stringify(idx, null, 2), { baseDir: BASE });
}

async function readBookJson(id: string): Promise<EpubBook> {
  const raw = await readTextFile(`${bookDir(id)}/book.json`, { baseDir: BASE });
  return JSON.parse(raw);
}

async function readState(id: string): Promise<BookState> {
  const path = `${bookDir(id)}/state.json`;
  if (!(await exists(path, { baseDir: BASE }))) {
    return {
      bookId: id,
      currentChapter: 0,
      paragraphIndex: 0,
      paragraphOffset: 0,
      highlights: [],
    };
  }
  try {
    const raw = await readTextFile(path, { baseDir: BASE });
    const parsed = JSON.parse(raw);
    return {
      bookId: id,
      currentChapter: typeof parsed.currentChapter === "number"
        ? parsed.currentChapter
        : 0,
      paragraphIndex: typeof parsed.paragraphIndex === "number"
        ? parsed.paragraphIndex
        : 0,
      paragraphOffset: typeof parsed.paragraphOffset === "number"
        ? parsed.paragraphOffset
        : 0,
      currentPage:
        typeof parsed.currentPage === "number" ? parsed.currentPage : undefined,
      pageOffset:
        typeof parsed.pageOffset === "number" ? parsed.pageOffset : undefined,
      fixedAnchor:
        parsed.fixedAnchor && typeof parsed.fixedAnchor.blockId === "string"
          ? {
              blockId: parsed.fixedAnchor.blockId,
              frac: Number(parsed.fixedAnchor.frac) || 0,
            }
          : undefined,
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
    };
  } catch {
    return {
      bookId: id,
      currentChapter: 0,
      paragraphIndex: 0,
      paragraphOffset: 0,
      highlights: [],
    };
  }
}

async function writeState(state: BookState) {
  const path = `${bookDir(state.bookId)}/state.json`;
  await writeTextFile(path, JSON.stringify(state, null, 2), { baseDir: BASE });
}

// ── public API ────────────────────────────────────────────────────────────

export async function listBooks(): Promise<BookIndexEntry[]> {
  const idx = await readIndex();
  const sorted = idx.books.slice().sort((a, b) => {
    const aTs = a.lastReadAt ?? a.addedAt;
    const bTs = b.lastReadAt ?? b.addedAt;
    return bTs - aTs;
  });

  // Kick off a background backfill pass — anything missing a cover that has
  // its EPUB bytes on disk will get re-scanned and the next listBooks() call
  // will return it populated. We intentionally don't await this; the current
  // list returns immediately.
  void backfillMissingCovers(sorted);

  return sorted;
}

export async function loadBook(
  id: string,
): Promise<{ book: EpubBook; state: BookState }> {
  const book = await readBookJson(id);
  const state = await readState(id);
  return { book, state };
}

/** Result of a pick: EPUBs import immediately (they ship their own cover);
 *  PDF/DOCX come back as drafts the caller shows the import dialog for. */
export interface StagedPick {
  autoImported: BookIndexEntry[];
  drafts: FixedImportDraft[];
  errors: { file: string; message: string }[];
  /** True only for folder picks that found no importable files. */
  empty?: boolean;
  /** Books already in the library that the picked files turned out to be
   *  copies of. Nothing was imported for these; the caller opens them as-is. */
  reused?: BookIndexEntry[];
}

/** Progress sink for an import run. Supplied by the caller (the library
 *  view) so the same pipeline can drive the desktop button spinner and the
 *  Android notification without knowing about either. */
export interface ImportReporter {
  /** Starting on file `index` of `total`. */
  file(index: number, total: number, name: string): void;
  /** Coarse stage change: copying bytes, parsing, or writing the book out. */
  phase(phase: "copy" | "parse" | "write"): void;
  /** Fine-grained progress within the current phase. */
  progress(p: StageProgress): void;
  /** Fine-grained progress *within* the parse phase. Separate from
   *  `progress`, which carries Rust's `StageProgress` — whose phases are
   *  copy and extract, neither of which parsing has a counterpart in. */
  parseProgress(ratio: number): void;
}

/** Thrown when a picked file's bytes aren't any format we can read.
 *  Localized at the display site via `errorLabel` (see i18n/statusLabels.ts). */
export const UNSUPPORTED_FILE =
  "Unsupported file — not an EPUB, PDF or DOCX.";

/** Resolve a staged file's format to the fixed-layout kind we should stage
 *  for the import dialog, or null when it's an EPUB (imported directly).
 *
 *  The format comes from the bytes, sniffed natively while the file was being
 *  copied: Android's picker returns a Storage Access Framework URI with no
 *  extension, so the path alone used to send every Android import into the
 *  EPUB parser. Extension only breaks ties for bytes we can't identify,
 *  keeping the previous desktop behaviour intact. */
function fixedKindFor(format: BookFormat, path: string): "pdf" | "docx" | null {
  if (format === "pdf" || format === "docx") return format;
  if (format === "epub") return null;
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.docx$/i.test(path)) return "docx";
  return null;
}

/**
 * Read + classify a list of picked paths: EPUBs import directly, PDF/DOCX are
 * staged (cover candidates ready) for the import dialog.
 *
 * Each file is first streamed to disk natively. That is what makes a 200 MB
 * book importable at all: the picked bytes never enter the webview, so they
 * never hit Tauri's Android IPC serializer, which would otherwise expand them
 * to one JSON array element per byte and throw `RangeError: Invalid array
 * length` past ~128 MB. See `nativeStaging.ts`.
 */
async function stagePaths(
  paths: string[],
  report?: ImportReporter,
): Promise<StagedPick> {
  await ensureRoot();
  const autoImported: BookIndexEntry[] = [];
  const drafts: FixedImportDraft[] = [];
  const errors: { file: string; message: string }[] = [];
  const reused: BookIndexEntry[] = [];
  // Read once, outside the loop: a multi-file drop shouldn't re-read the
  // index per file. Entries imported during this same run are appended
  // below so a batch containing the same book twice still dedupes.
  const known: BookIndexEntry[] = await listBooks();

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const token = newStagingToken();
    const stagedPath = `${STAGING}/${token}`;
    let unlisten: (() => void) | undefined;
    try {
      report?.file(i, paths.length, filenameTitle(path));
      unlisten = await onStageProgress(token, (p) => report?.progress(p));

      // The dialog selection itself grants per-path read permission on Tauri
      // v2, so we don't need $HOME / $DOCUMENT in the fs scope.
      const staged = await stageImportFile(path, stagedPath, token);

      // Already have this exact file? Drop the staged copy and hand back
      // the existing book, so its reading position and highlights survive.
      const existingId = findByHash(known, staged.hash);
      if (existingId) {
        await deleteStaged(stagedPath);
        const entry = known.find((e) => e.id === existingId);
        if (entry) reused.push(entry);
        continue;
      }

      const fixed = fixedKindFor(staged.format, path);

      if (fixed) {
        report?.phase("parse");
        // Dynamic import avoids a static library ↔ staging cycle and keeps the
        // pdf.js / mammoth toolchains out of the initial bundle.
        const { stageFixedImport } = await import("./fixedImportStage");
        // A PDF is read in slices straight off disk (pdf/rangeSource.ts), so
        // its bytes never enter the webview — reading a 200 MB book in, then
        // copying it again for pdf.js, is what made the app crawl. DOCX does
        // still cross the bridge because mammoth needs the whole buffer, but
        // Rust→JS responses travel as an octet-stream rather than a JSON
        // number array, so there's no expansion. Either way the staged file
        // stays put and `commit` renames it into place instead of writing a
        // second copy.
        const source =
          fixed === "pdf"
            ? { path: stagedPath, length: staged.size }
            : { bytes: await readFile(stagedPath, { baseDir: BASE }) };
        drafts.push(
          await stageFixedImport(source, path, fixed, {
            stagedPath,
            sourceHash: staged.hash,
          }),
        );
      } else if (staged.format === "epub") {
        const entry = await importStagedEpub(
          stagedPath,
          token,
          report,
          staged.hash,
        );
        autoImported.push(entry);
        // A batch containing the same book twice dedupes against itself.
        known.push(entry);
      } else {
        throw new Error(UNSUPPORTED_FILE);
      }
    } catch (err) {
      await deleteStaged(stagedPath);
      errors.push({
        file: path.split(/[\\/]/).pop() ?? path,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      unlisten?.();
    }
  }
  return { autoImported, drafts, errors, reused };
}

/**
 * Import a list of already-chosen files. EPUBs import immediately; PDF/DOCX
 * come back as drafts for the title/cover dialog; files the library already
 * holds come back under `reused`.
 *
 * Split out from `pickBooksForImport` so files that arrive from outside the
 * app — an "Open with" launch, an Android share, a drag-and-drop — take the
 * exact same path as picked ones, including the native staging that keeps a
 * 200 MB book off the Android IPC bridge.
 */
export async function importPaths(
  paths: string[],
  report?: ImportReporter,
): Promise<StagedPick> {
  return stagePaths(paths, report);
}

/**
 * Prompt for one or more books, then import them. Null if the user
 * cancelled.
 */
export async function pickBooksForImport(
  report?: ImportReporter,
): Promise<StagedPick | null> {
  const picked = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Books", extensions: ["epub", "pdf", "docx"] }],
  });
  if (!picked) return null;
  const paths = Array.isArray(picked) ? picked : [picked];
  return importPaths(paths, report);
}

/** Pull a reasonable display title out of a file path: drop the directory
 *  portion and the .docx extension, then collapse underscores/dashes to
 *  spaces. Used when the doc has no leading heading we can borrow. Empty
 *  (not "Untitled") when the stem strips to nothing — a blank title
 *  persists as "" so the display-time fallback (`common.untitled`)
 *  localizes it wherever the book is rendered, instead of freezing an
 *  English (or whatever-locale-was-active) literal into the book's own
 *  stored title. */
export function filenameTitle(path: string): string {
  // Android hands back content://…/document%3A19, whose last segment is an
  // opaque provider id rather than a name. Empty (not the id) so the
  // display-time `common.untitled` fallback localizes it.
  if (isOpaqueUri(path)) return "";
  const base = path.split(/[\\/]/).pop() ?? path;
  const stem = base.replace(/\.(docx|pdf|epub)$/i, "");
  const cleaned = stem.replace(/[_-]+/g, " ").trim();
  return cleaned;
}

/** Write the default (empty) reading state for a freshly imported book. */
export async function writeInitialState(id: string): Promise<void> {
  await writeState({
    bookId: id,
    currentChapter: 0,
    paragraphIndex: 0,
    highlights: [],
  });
}

/** Append an entry to the library index and return it. Shared by every importer. */
export async function appendIndexEntry(
  entry: BookIndexEntry,
): Promise<BookIndexEntry> {
  const idx = await readIndex();
  idx.books.push(entry);
  await writeIndex(idx);
  return entry;
}

/** Read a single index entry (used for open-time routing on `kind`). */
export async function getEntry(id: string): Promise<BookIndexEntry | null> {
  const idx = await readIndex();
  return idx.books.find((b) => b.id === id) ?? null;
}

// ── fixed-layout books (PDF / DOCX) ─────────────────────────────────────────

export interface PdfBook {
  id: string;
  kind: "pdf";
  title: string;
  author: string;
  pageCount: number;
  outline: TocEntry[];
}

export interface DocxBook {
  id: string;
  kind: "docx";
  title: string;
  author: string;
  dir: "ltr" | "rtl";
  /** Headings with injected anchor ids. Pages are viewport-dependent and don't
   *  exist until read time, so DocxPageSource maps each anchor to a page then. */
  outline: { title: string; level: number; anchorId: string }[];
}

export type FixedBook = PdfBook | DocxBook;

/** Load a fixed-layout book descriptor + its reading state — the page-based
 *  analogue of loadBook. The descriptor is a PdfBook/DocxBook, not an EpubBook. */
export async function loadFixedBook(
  id: string,
): Promise<{ book: FixedBook; state: BookState }> {
  const raw = await readTextFile(`${bookDir(id)}/book.json`, { baseDir: BASE });
  const book = JSON.parse(raw) as FixedBook;
  const state = await readState(id);
  return { book, state };
}

/**
 * Parse an EPUB that already sits at `books/<id>/book.epub` and commit it to
 * the library.
 *
 * Everything bulky stays native. The parser reads only the text entries it
 * needs (OPF, nav/NCX, chapter XHTML) through `openNativeZip`, and images +
 * cover are copied archive → disk by Rust, so a 200 MB picture book costs the
 * webview a few hundred KB instead of holding the whole archive, a JSZip
 * mirror of it, and every decoded image at once.
 */
async function commitEpubAt(
  id: string,
  token: string,
  report?: ImportReporter,
  sourceHash?: string,
): Promise<BookIndexEntry> {
  const dir = bookDir(id);
  report?.phase("parse");
  const src = await openNativeZip(`${dir}/book.epub`, token);
  try {
    const { book, cover, images } = await parseEpubFromSource(src, id, {
      onChapter: (done, total) =>
        report?.parseProgress(total > 0 ? done / total : 1),
    });

    report?.phase("write");
    await writeTextFile(`${dir}/book.json`, JSON.stringify(book), {
      baseDir: BASE,
    });
    await writeInitialState(id);

    // In-flow images stay in the archive. Record where each one lives and
    // let the reader pull it on first view (see store/epubImages.ts) — for
    // an illustrated book, extracting here means writing the entire book a
    // second time and then keeping both copies forever.
    if (images.length > 0) {
      await writeImageManifest(id, images);
    }

    let coverFile: string | undefined;
    if (cover) {
      const name = `cover.${cover.extension}`;
      const [ok] = await src.extract([
        { entry: cover.entry, dest: `${dir}/${name}` },
      ]);
      if (ok) coverFile = name;
    }

    return appendIndexEntry({
      id: book.id,
      title: book.title,
      author: book.author,
      language: book.language,
      chapterCount: book.chapters.length,
      addedAt: Date.now(),
      progress: 0,
      ...(coverFile ? { coverFile } : {}),
      ...(sourceHash ? { sourceHash } : {}),
    });
  } finally {
    src.dispose();
  }
}

/** Move a staged EPUB into a fresh book directory and import it. The staged
 *  copy becomes `book.epub` by rename, so the bytes are only ever written
 *  once. */
async function importStagedEpub(
  stagedPath: string,
  token: string,
  report?: ImportReporter,
  sourceHash?: string,
): Promise<BookIndexEntry> {
  const id = crypto.randomUUID();
  const dir = bookDir(id);
  await mkdir(dir, { baseDir: BASE, recursive: true });
  try {
    // Keeping the original zip lets us re-extract the cover later when the
    // parser improves, without re-asking the user for the file.
    await renameStaged(stagedPath, `${dir}/book.epub`);
    return await commitEpubAt(id, token, report, sourceHash);
  } catch (err) {
    // A failed parse shouldn't leave a partial book (or a 200 MB orphan)
    // behind.
    await deleteStaged(dir);
    throw err;
  }
}

/**
 * Import an EPUB the app itself produced in memory — a Sources download, a
 * DOCX conversion, a store conversion.
 *
 * The buffer is written to disk in bounded slices first (see
 * `writeBytesChunked`), then parsed through the same native path as a picked
 * file. Chunking matters even here: Android's IPC serializer would otherwise
 * expand the whole buffer into one JS array element per byte.
 */
export async function importEpubBytes(
  bytes: Uint8Array,
): Promise<BookIndexEntry> {
  await ensureRoot();
  const id = crypto.randomUUID();
  const token = newStagingToken();
  const dir = bookDir(id);
  await mkdir(dir, { baseDir: BASE, recursive: true });
  try {
    await writeBytesChunked(`${dir}/book.epub`, bytes);
    return await commitEpubAt(id, token);
  } catch (err) {
    await deleteStaged(dir);
    throw err;
  }
}

/**
 * Lightweight "Add to library" for a source-backed novel. Persists the
 * novel snapshot (metadata + volumes + chapter index — see
 * `store/sourceLibrary.ts`) and downloads the cover. Does NOT download
 * chapter content; that happens per-chapter via the download queue.
 *
 * If the same (sourceId, novelUrl) is already in the library, this
 * returns the existing entry but refreshes its snapshot from the source
 * so reopening picks up any newly published chapters. The refresh is
 * best-effort — when the network is unavailable the existing snapshot
 * stays put.
 */
export async function addNovelToLibrary(
  sourceId: string,
  novelUrl: string,
): Promise<BookIndexEntry> {
  const { getSource } = await import("../sources/registry");
  const { createHost } = await import("../sources/host");
  const { writeSnapshotFromSourceNovel } = await import("./sourceLibrary");
  const source = getSource(sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);

  const existing = await findSourceEntry(sourceId, novelUrl);

  const novel = await source.getNovel(novelUrl);
  const id =
    existing?.id ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  await ensureRoot();
  const dir = bookDir(id);
  if (!(await exists(dir, { baseDir: BASE }))) {
    await mkdir(dir, { baseDir: BASE, recursive: true });
  }

  // Download the cover up front so the library card has something to
  // render without going back over the network on every list refresh.
  // Cover failure isn't fatal — the entry still works, just without a
  // thumbnail.
  let coverFile: string | undefined = existing?.coverFile;
  if (novel.coverUrl && !existing?.coverFile) {
    try {
      const host = createHost(sourceId);
      const bytes = await host.fetchBytes(novel.coverUrl);
      const ext = extensionFromCoverUrl(novel.coverUrl);
      coverFile = `cover.${ext}`;
      await writeFile(`${dir}/${coverFile}`, bytes, { baseDir: BASE });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[library] couldn't download cover:", e);
    }
  }

  // Persist the snapshot (volumes + chapters with downloadedAt/readAt
  // carried over from any prior snapshot).
  await writeSnapshotFromSourceNovel(id, sourceId, novelUrl, novel);

  const chapterCount = novel.volumes.reduce(
    (a, v) => a + v.chapters.length,
    0,
  );

  const entry: BookIndexEntry = {
    ...(existing ?? {}),
    id,
    title: novel.title,
    author: novel.author,
    language: novel.language,
    chapterCount,
    addedAt: existing?.addedAt ?? Date.now(),
    progress: existing?.progress ?? 0,
    kind: "source",
    sourceId,
    novelUrl,
    ...(coverFile ? { coverFile } : {}),
    ...(novel.description ? { description: novel.description } : {}),
  };

  const idx = await readIndex();
  const at = idx.books.findIndex((b) => b.id === id);
  if (at === -1) {
    idx.books.push(entry);
  } else {
    idx.books[at] = entry;
  }
  await writeIndex(idx);
  return entry;
}

/** Find a source-backed entry for the given (sourceId, novelUrl), if
 *  one exists. Returns null when the novel hasn't been added yet. */
export async function findSourceEntry(
  sourceId: string,
  novelUrl: string,
): Promise<BookIndexEntry | null> {
  const idx = await readIndex();
  return (
    idx.books.find(
      (b) =>
        b.kind === "source" &&
        b.sourceId === sourceId &&
        b.novelUrl === novelUrl,
    ) ?? null
  );
}

/** Pluck a sane file extension from a cover URL (`/foo/bar/cover.jpg?x=1`
 *  → `jpg`). Falls back to `jpg` when nothing maps. The cover doesn't
 *  need to round-trip through a MIME detector since the EPUB pipeline
 *  isn't involved for source entries. */
function extensionFromCoverUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  if (!m) return "jpg";
  const ext = m[1].toLowerCase();
  if (ext === "jpeg") return "jpg";
  return ext;
}

/**
 * Run a Source (scraper extension) against a URL and add the resulting
 * EPUB to the library. Driven by the existing import-progress store so
 * the modal + minimized dock surface the long scrape automatically.
 *
 * Source lookup is dynamic to avoid eagerly loading every extension file
 * on app start — the registry resolves only the requested id.
 */
export async function importFromSourceUrl(
  sourceId: string,
  url: string,
  options?: {
    /** Inclusive chapter id range. When set, only those chapters are
     *  scraped and the resulting EPUB's title is suffixed with the range. */
    chapterIdRange?: { start: number; end: number };
  },
): Promise<BookIndexEntry> {
  const { getSource } = await import("../sources/registry");
  const { runFullSourceImport } = await import("../sources/importer");

  const source = getSource(sourceId);
  if (!source) {
    throw new Error(`Unknown source: ${sourceId}`);
  }
  return runFullSourceImport(source, url, importEpubBytes, options) as Promise<
    BookIndexEntry
  >;
}

/**
 * Prompt for a folder, shallow-scan for .epub/.pdf/.docx files (no recursion).
 * EPUBs import immediately; PDF/DOCX are staged for the dialog queue. Null if
 * the user cancelled; `empty: true` when the folder held no importable files.
 */
export async function pickFolderForImport(
  report?: ImportReporter,
): Promise<StagedPick | null> {
  const picked = await open({ multiple: false, directory: true });
  if (!picked) return null;
  const dir = Array.isArray(picked) ? picked[0] : picked;

  const entries = await readDir(dir);
  const files = entries.filter(
    (e) => e.isFile && /\.(epub|pdf|docx)$/i.test(e.name),
  );
  if (files.length === 0) {
    return { autoImported: [], drafts: [], errors: [], empty: true };
  }

  const paths: string[] = [];
  for (const e of files) paths.push(await join(dir, e.name));
  return { ...(await stagePaths(paths, report)), empty: false };
}

/** Let the user pick an image from disk and return its bytes (no write). Used
 *  by the import dialog's "choose from device" cover option. Null if
 *  dismissed. */
export async function readImageFile(): Promise<{
  bytes: Uint8Array;
  ext: string;
} | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: makeTr(currentUiLocale())("picker.filterImage"),
        extensions: ["jpg", "jpeg", "png", "gif", "webp"],
      },
    ],
  });
  if (!picked) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  const bytes = await readFile(path);
  const ext = path.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? "jpg";
  const safeExt = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)
    ? ext === "jpeg"
      ? "jpg"
      : ext
    : "jpg";
  return { bytes, ext: safeExt };
}

/**
 * Re-parse the book's stored EPUB and extract a cover. Used to backfill
 * covers on books that were imported by an older parser version that missed
 * them. Silent no-op if the EPUB wasn't saved (pre-0.2 books).
 *
 * Reads through the native zip source rather than pulling the archive into
 * memory — `backfillMissingCovers` calls this for every cover-less book after
 * each `listBooks()`, so on a shelf holding a few large books the old
 * read-it-all approach cost hundreds of MB per library render.
 *
 * Returns the updated index entry, or null if nothing could be done.
 */
export async function rescanCover(
  id: string,
): Promise<BookIndexEntry | null> {
  const dir = bookDir(id);
  const epubPath = `${dir}/book.epub`;
  if (!(await exists(epubPath, { baseDir: BASE }))) return null;

  const src = await openNativeZip(epubPath, newStagingToken());
  let coverFile: string;
  try {
    const { cover } = await parseEpubFromSource(src, id);
    if (!cover) return null;
    coverFile = `cover.${cover.extension}`;
    const [ok] = await src.extract([
      { entry: cover.entry, dest: `${dir}/${coverFile}` },
    ]);
    if (!ok) return null;
  } finally {
    src.dispose();
  }

  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return null;
  entry.coverFile = coverFile;
  // Bump addedAt-cachebust-friend so the webview re-fetches. We keep the
  // original addedAt for sorting, but append a coverBust tag in the URL.
  (entry as BookIndexEntry & { coverBust?: number }).coverBust = Date.now();
  await writeIndex(idx);
  return entry;
}

/**
 * Let the user pick any image file from disk and use it as this book's cover.
 * A useful escape hatch when the EPUB genuinely ships without one. Returns
 * the updated entry, or null if the picker was dismissed.
 */
export async function setCoverFromFile(
  id: string,
): Promise<BookIndexEntry | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: makeTr(currentUiLocale())("picker.filterImage"),
        extensions: ["jpg", "jpeg", "png", "gif", "webp"],
      },
    ],
  });
  if (!picked) return null;
  const bytes = await readFile(picked);

  const ext =
    picked.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? "jpg";
  const safeExt = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)
    ? ext
    : "jpg";
  const coverFile = `cover.${safeExt}`;

  const dir = bookDir(id);
  await writeFile(`${dir}/${coverFile}`, bytes, { baseDir: BASE });

  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return null;
  entry.coverFile = coverFile;
  (entry as BookIndexEntry & { coverBust?: number }).coverBust = Date.now();
  await writeIndex(idx);
  return entry;
}

/**
 * Fire-and-forget cover backfill. Runs in the background after `listBooks`
 * to auto-heal any book whose cover wasn't found the first time. Does
 * nothing for books without saved EPUB bytes (pre-0.2 imports).
 */
async function backfillMissingCovers(entries: BookIndexEntry[]): Promise<void> {
  const missing = entries.filter((e) => !e.coverFile);
  if (missing.length === 0) return;
  for (const entry of missing) {
    try {
      await rescanCover(entry.id);
    } catch {
      // best-effort — one bad book shouldn't block the rest
    }
  }
}

// ── cover URLs ────────────────────────────────────────────────────────────
//
// The webview can't open arbitrary paths directly — it has to go through
// Tauri's `asset://` protocol (configured in tauri.conf.json to allow
// `$APPDATA/riwaq/**`). `convertFileSrc` wraps an absolute path into
// that protocol's URL form.

let cachedAppDataDir: string | null = null;
async function getAppDataDir(): Promise<string> {
  if (cachedAppDataDir === null) cachedAppDataDir = await appDataDir();
  return cachedAppDataDir;
}

/** Build a webview-loadable URL for an entry's cover, or null if it has none. */
export async function coverSrcFor(
  entry: BookIndexEntry,
): Promise<string | null> {
  if (!entry.coverFile) return null;
  const root = await getAppDataDir();
  const abs = await join(root, ROOT, "books", entry.id, entry.coverFile);
  // Cache-bust on coverBust first (bumps when the cover is replaced via
  // rescanCover / setCoverFromFile), else on addedAt.
  const v = entry.coverBust ?? entry.addedAt;
  return `${convertFileSrc(abs)}?v=${v}`;
}

/** Resolve a chapter image's storage-relative `src` (e.g. `images/img-001.jpg`)
 *  into an asset-protocol URL the webview can load. The file lives at
 *  `$APPDATA/riwaq/books/<bookId>/<src>`, which is in the Tauri asset scope.
 *
 *  Absolute URLs (http/https/data:) pass through unchanged so the same
 *  resolver works for the streaming reader, which mounts a virtual EpubBook
 *  whose image items reference remote URLs directly without a local copy. */
export async function chapterImageSrcFor(
  bookId: string,
  src: string,
): Promise<string> {
  // Streaming books reference images by their origin URL. Don't try to
  // join them against a non-existent local storage path; the webview can
  // fetch them directly.
  if (/^(https?:|data:|asset:|blob:)/i.test(src)) {
    return src;
  }
  const root = await getAppDataDir();
  // Split on `/` so the path joins are platform-correct (Windows backslashes
  // come from `join`, not from the stored hrefs).
  const parts = src.split("/").filter((p) => p.length > 0);
  const abs = await join(root, ROOT, "books", bookId, ...parts);
  return convertFileSrc(abs);
}

/**
 * Set or clear the user-managed reading status. Pass undefined to clear.
 *
 * Marking a book as "finished" also pins its progress to 100% — otherwise a
 * book the reader hasn't actually scrolled to the end of would still show a
 * partial progress bar in the Finished tab, which reads as a bug.
 */
export async function updateBookStatus(
  id: string,
  status: BookStatus | undefined,
): Promise<BookIndexEntry | null> {
  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return null;
  if (status === undefined) delete entry.status;
  else entry.status = status;
  if (status === "finished") entry.progress = 1;
  await writeIndex(idx);
  return entry;
}

/** Set the shelves a book belongs to. Mirrors updateBookStatus. */
export async function updateBookShelfIds(
  id: string,
  shelfIds: string[],
): Promise<BookIndexEntry | null> {
  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return null;
  entry.shelfIds = [...new Set(shelfIds)];
  await writeIndex(idx);
  return entry;
}

// ── shelf membership (delta mutators) ────────────────────────────────────
//
// addBookToShelf / removeBookFromShelf mutate a single id instead of taking
// a caller-computed absolute shelfIds list. A caller that reads the React
// `books` snapshot, computes the full next list, and writes it back
// wholesale (as updateBookShelfIds above requires) can race with itself:
// two rapid toggles both read the same stale snapshot before either
// `refresh()` lands, and the second write silently clobbers the first
// change. These two mutators read the index fresh on every call and only
// touch the one id they're asked about, so a stale caller-side "is this on
// the shelf" check is harmless — the write itself is a safe, idempotent
// add/remove. `serialize` below closes the remaining race where two calls
// could both read the index before either has written it back.
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/** Add one shelf id to a book's membership, reading the fresh index rather
 *  than trusting a caller-supplied list. No-op if the book is missing or
 *  already on the shelf. */
export async function addBookToShelf(
  bookId: string,
  shelfId: string,
): Promise<void> {
  await serialize(async () => {
    const idx = await readIndex();
    const entry = idx.books.find((b) => b.id === bookId);
    if (!entry) return;
    const set = new Set(entry.shelfIds ?? []);
    if (set.has(shelfId)) return;
    set.add(shelfId);
    entry.shelfIds = [...set];
    await writeIndex(idx);
  });
}

/** Remove one shelf id from a book's membership. Mirrors addBookToShelf. */
export async function removeBookFromShelf(
  bookId: string,
  shelfId: string,
): Promise<void> {
  await serialize(async () => {
    const idx = await readIndex();
    const entry = idx.books.find((b) => b.id === bookId);
    if (!entry) return;
    if (!entry.shelfIds?.includes(shelfId)) return;
    entry.shelfIds = entry.shelfIds.filter((sid) => sid !== shelfId);
    await writeIndex(idx);
  });
}

/** Strip one shelf id from every book that has it. Called when a shelf is
 *  deleted so no dangling membership remains. */
export async function removeShelfFromAllBooks(shelfId: string): Promise<void> {
  const idx = await readIndex();
  let changed = false;
  for (const b of idx.books) {
    if (b.shelfIds?.includes(shelfId)) {
      b.shelfIds = b.shelfIds.filter((sid) => sid !== shelfId);
      changed = true;
    }
  }
  if (changed) await writeIndex(idx);
}

/**
 * Patch one or more user-editable fields on a book's index entry. Used by
 * the library's "Edit book" dialog. Only fields supplied in `patch` are
 * touched — everything else is left as-is.
 */
export async function updateBookMeta(
  id: string,
  patch: { title?: string; author?: string; description?: string },
): Promise<BookIndexEntry | null> {
  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return null;
  if (patch.title !== undefined) entry.title = patch.title;
  if (patch.author !== undefined) entry.author = patch.author;
  if (patch.description !== undefined) entry.description = patch.description;
  await writeIndex(idx);
  return entry;
}

export async function deleteBook(id: string): Promise<void> {
  const idx = await readIndex();
  idx.books = idx.books.filter((b) => b.id !== id);
  await writeIndex(idx);
  try {
    // Recursive — books with in-flow images live under an `images/` subdir
    // that a per-file sweep wouldn't reach.
    await remove(bookDir(id), { baseDir: BASE, recursive: true });
  } catch {
    // best-effort — missing files shouldn't block a delete from the index
  }
}

/**
 * Stamp a book's `lastReadAt` to "now" without touching its reading
 * position. Called when the user opens a book, so the Library's
 * "Continue reading" hero picks the most-recently-opened book even when
 * the user exits before a chapter change has run `updateReadingPosition`
 * (e.g. they opened a book, scrolled within the current chapter, and
 * tapped back). Without this, the hero would still point at whichever
 * book the user previously switched chapters in.
 */
export async function markBookOpened(id: string): Promise<void> {
  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return;
  entry.lastReadAt = Date.now();
  await writeIndex(idx);
}

export async function updateReadingPosition(
  id: string,
  currentChapter: number,
  chapterCount: number,
): Promise<void> {
  const state = await readState(id);
  state.currentChapter = currentChapter;
  // A chapter switch resets paragraph progress for that chapter — the new
  // chapter starts at the top.
  state.paragraphIndex = 0;
  state.paragraphOffset = 0;
  await writeState(state);

  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (entry) {
    entry.progress =
      chapterCount > 0
        ? Math.min(1, (currentChapter + 1) / chapterCount)
        : 0;
    entry.lastReadAt = Date.now();
    await writeIndex(idx);
  }
}

/**
 * Stamp `lastReadAt` + `progress` on a *source* library entry as the user
 * reads it in the streaming reader. The source-novel reader (SourceStreamReader)
 * is the analogue of openBook + changeChapter for the local reader, but it
 * persists its scroll position in localStorage, not in `state.json` — so unlike
 * `updateReadingPosition` this only touches the library index and never writes a
 * `state.json`. Without this, a source entry's `lastReadAt` stays undefined and
 * its `progress` stays 0, so the Library's "Continue reading" hero (which keys
 * off `lastReadAt`) and the auto-"Reading" tab (which keys off `progress`) both
 * skip it even right after the user finished reading it. No-op when the entry
 * is missing.
 */
export async function updateSourceReadingPosition(
  id: string,
  currentChapter: number,
  chapterCount: number,
): Promise<void> {
  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return;
  entry.progress =
    chapterCount > 0 ? Math.min(1, (currentChapter + 1) / chapterCount) : 0;
  entry.lastReadAt = Date.now();
  await writeIndex(idx);
}

/**
 * Persist the topmost-visible paragraph index within the current chapter.
 * Called as the user scrolls (debounced). Doesn't touch the library index —
 * that's only for chapter-level progress / lastReadAt.
 */
export async function updateParagraphPosition(
  id: string,
  paragraphIndex: number,
  paragraphOffset?: number,
): Promise<void> {
  const state = await readState(id);
  state.paragraphIndex = paragraphIndex;
  state.paragraphOffset = paragraphOffset ?? 0;
  await writeState(state);
}

/**
 * Persist fixed-page (PDF/DOCX) resume position. Called as the user scrolls /
 * flips pages (debounced by the caller). Doesn't touch the library index —
 * page-level progress goes through updatePageProgress.
 */
export async function updatePagePosition(
  id: string,
  currentPage: number,
  pageOffset?: number,
  fixedAnchor?: { blockId: string; frac: number },
): Promise<void> {
  const state = await readState(id);
  state.currentPage = currentPage;
  state.pageOffset = pageOffset ?? 0;
  if (fixedAnchor) state.fixedAnchor = fixedAnchor;
  await writeState(state);
}

/**
 * Stamp page-based progress + lastReadAt on a fixed book's index entry — the
 * page-based analogue of updateReadingPosition. `currentPage` is 0-based.
 */
export async function updatePageProgress(
  id: string,
  currentPage: number,
  pageCount: number,
): Promise<void> {
  const idx = await readIndex();
  const entry = idx.books.find((b) => b.id === id);
  if (!entry) return;
  entry.progress =
    pageCount > 0 ? Math.min(1, (currentPage + 1) / pageCount) : 0;
  entry.lastReadAt = Date.now();
  await writeIndex(idx);
}

export async function saveHighlight(
  id: string,
  highlight: Omit<Highlight, "id" | "ts">,
): Promise<Highlight> {
  const state = await readState(id);
  const full: Highlight = {
    ...highlight,
    id: crypto.randomUUID(),
    ts: Date.now(),
  };
  state.highlights.push(full);
  await writeState(state);
  return full;
}

export async function deleteHighlight(
  id: string,
  highlightId: string,
): Promise<void> {
  const state = await readState(id);
  state.highlights = state.highlights.filter((h) => h.id !== highlightId);
  await writeState(state);
}

/** Delete several highlights atomically. Used when a multi-paragraph
 *  highlight group is removed via any one of its members. */
export async function deleteHighlights(
  id: string,
  highlightIds: string[],
): Promise<void> {
  if (highlightIds.length === 0) return;
  const ids = new Set(highlightIds);
  const state = await readState(id);
  state.highlights = state.highlights.filter((h) => !ids.has(h.id));
  await writeState(state);
}

export async function updateHighlightNote(
  id: string,
  highlightId: string,
  note: string,
): Promise<void> {
  const state = await readState(id);
  const trimmed = note.trim();
  state.highlights = state.highlights.map((h) =>
    h.id === highlightId
      ? { ...h, note: trimmed.length > 0 ? trimmed : undefined }
      : h,
  );
  await writeState(state);
}

