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
import { parseEpub } from "../epub/parser";
import type { EpubBook } from "../epub/types";

const BASE = BaseDirectory.AppData;
const ROOT = "leaflet";
const BOOKS = `${ROOT}/books`;
const INDEX = `${ROOT}/library.json`;

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
}

export interface BookState {
  bookId: string;
  currentChapter: number;
  /** Index of the topmost-visible paragraph within currentChapter. Lets the
      reader resume from the same scroll position, not just the chapter. */
  paragraphIndex: number;
  /** Mutable over time — drives the Highlights panel. Empty on a freshly
      imported book. */
  highlights: Highlight[];
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
  color: "yellow" | "blue" | "pink" | "green";
  ts: number;
}

interface LibraryFile {
  version: 1;
  books: BookIndexEntry[];
}

// ── low-level fs helpers ──────────────────────────────────────────────────

async function ensureRoot() {
  for (const dir of [ROOT, BOOKS]) {
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

function bookDir(id: string) {
  return `${BOOKS}/${id}`;
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
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
    };
  } catch {
    return {
      bookId: id,
      currentChapter: 0,
      paragraphIndex: 0,
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

/**
 * Prompt for an EPUB, parse it, and persist. Returns the index entry, or
 * null if the user cancelled the picker.
 */
export async function pickAndImportEpub(): Promise<BookIndexEntry | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "EPUB", extensions: ["epub"] }],
  });
  if (!picked) return null;
  // The dialog selection itself grants per-path read permission on Tauri v2,
  // so we don't need $HOME / $DOCUMENT in the fs scope.
  const bytes = await readFile(picked);
  return importEpubBytes(bytes);
}

export async function importEpubBytes(
  bytes: Uint8Array,
): Promise<BookIndexEntry> {
  await ensureRoot();
  const { book, cover } = await parseEpub(bytes.buffer as ArrayBuffer);

  const dir = bookDir(book.id);
  await mkdir(dir, { baseDir: BASE, recursive: true });
  await writeTextFile(`${dir}/book.json`, JSON.stringify(book), {
    baseDir: BASE,
  });
  // Persist the original zip alongside the parsed book. Costs ~MB of disk
  // but lets us re-extract the cover later when the parser improves —
  // without re-asking the user for the file.
  await writeFile(`${dir}/book.epub`, bytes, { baseDir: BASE });
  await writeState({
    bookId: book.id,
    currentChapter: 0,
    paragraphIndex: 0,
    highlights: [],
  });

  let coverFile: string | undefined;
  if (cover) {
    coverFile = `cover.${cover.extension}`;
    await writeFile(`${dir}/${coverFile}`, cover.bytes, { baseDir: BASE });
  }

  const entry: BookIndexEntry = {
    id: book.id,
    title: book.title,
    author: book.author,
    language: book.language,
    chapterCount: book.chapters.length,
    addedAt: Date.now(),
    progress: 0,
    ...(coverFile ? { coverFile } : {}),
  };

  const idx = await readIndex();
  idx.books.push(entry);
  await writeIndex(idx);
  return entry;
}

export interface ImportFolderResult {
  imported: BookIndexEntry[];
  errors: { file: string; message: string }[];
  /** True when the folder contained no .epub files at its top level. */
  empty: boolean;
}

/**
 * Prompt for a folder, shallow-scan for .epub files (no recursion), and
 * import each. Returns null if the user cancelled. On a folder with no
 * top-level epubs, `empty: true` — the caller should tell the user.
 */
export async function pickAndImportFolder(): Promise<ImportFolderResult | null> {
  const picked = await open({ multiple: false, directory: true });
  if (!picked) return null;

  const entries = await readDir(picked);
  const epubs = entries.filter(
    (e) => e.isFile && /\.epub$/i.test(e.name),
  );

  if (epubs.length === 0) {
    return { imported: [], errors: [], empty: true };
  }

  const imported: BookIndexEntry[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const e of epubs) {
    try {
      const path = await join(picked, e.name);
      const bytes = await readFile(path);
      const entry = await importEpubBytes(bytes);
      imported.push(entry);
    } catch (err) {
      errors.push({
        file: e.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { imported, errors, empty: false };
}

/**
 * Re-parse the book's stored EPUB bytes and extract a cover. Used to backfill
 * covers on books that were imported by an older parser version that missed
 * them. Silent no-op if the EPUB bytes weren't saved (pre-0.2 books).
 *
 * Returns the updated index entry, or null if nothing could be done.
 */
export async function rescanCover(
  id: string,
): Promise<BookIndexEntry | null> {
  const dir = bookDir(id);
  const epubPath = `${dir}/book.epub`;
  if (!(await exists(epubPath, { baseDir: BASE }))) return null;

  const bytes = await readFile(epubPath, { baseDir: BASE });
  const { cover } = await parseEpub(bytes.buffer as ArrayBuffer);
  if (!cover) return null;

  const coverFile = `cover.${cover.extension}`;
  await writeFile(`${dir}/${coverFile}`, cover.bytes, { baseDir: BASE });

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
      { name: "Image", extensions: ["jpg", "jpeg", "png", "gif", "webp"] },
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
// `$APPDATA/leaflet/**`). `convertFileSrc` wraps an absolute path into
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

/**
 * Dev-only nuke: remove every book from the index and wipe the books/
 * directory. Useful while iterating on the parser or UI. Called from a
 * dev-mode button in the Library header.
 */
export async function clearLibrary(): Promise<void> {
  const idx = await readIndex();
  for (const b of idx.books) {
    try {
      const entries = await readDir(bookDir(b.id), { baseDir: BASE });
      for (const e of entries) {
        await remove(`${bookDir(b.id)}/${e.name}`, { baseDir: BASE });
      }
      await remove(bookDir(b.id), { baseDir: BASE });
    } catch {
      // best-effort — a missing dir shouldn't stop the sweep
    }
  }
  await writeIndex({ version: 1, books: [] });
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
    // Recursive remove — both files under dir, then the dir itself.
    const entries = await readDir(bookDir(id), { baseDir: BASE });
    for (const e of entries) {
      await remove(`${bookDir(id)}/${e.name}`, { baseDir: BASE });
    }
    await remove(bookDir(id), { baseDir: BASE });
  } catch {
    // best-effort — missing files shouldn't block a delete from the index
  }
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
 * Persist the topmost-visible paragraph index within the current chapter.
 * Called as the user scrolls (debounced). Doesn't touch the library index —
 * that's only for chapter-level progress / lastReadAt.
 */
export async function updateParagraphPosition(
  id: string,
  paragraphIndex: number,
): Promise<void> {
  const state = await readState(id);
  state.paragraphIndex = paragraphIndex;
  await writeState(state);
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

