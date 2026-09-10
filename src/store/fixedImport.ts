// Commit fixed-layout books (PDF / DOCX) to the local library. Parsing and
// cover-candidate extraction live in fixedImportStage.ts; these functions do
// the disk writes once the user has chosen a title + cover in the import
// dialog (or accepted the defaults). Each writes the original/source under
// books/<id>/ plus a book.json descriptor, an optional cover, and a library
// index entry. Pages are rendered lazily at read time, never held in memory.

import {
  BaseDirectory,
  mkdir,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { TocEntry } from "../types/reader";
import { renameStaged, writeBytesChunked } from "./nativeStaging";
import {
  appendIndexEntry,
  bookDir,
  ensureRoot,
  writeInitialState,
  type BookIndexEntry,
  type DocxBook,
  type PdfBook,
} from "./library";

const BASE = BaseDirectory.AppData;

/** Resolved cover to write for a book (already at final resolution). */
export interface ChosenCover {
  bytes: Uint8Array;
  /** File extension without the dot, e.g. "jpg" / "png". */
  ext: string;
}

export function newFixedId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Persist a PDF: store the original, a PdfBook descriptor, the chosen cover
 *  (if any), and append the index entry.
 *
 *  The original arrives one of two ways. `stagedPath` means the native import
 *  pass already streamed it to disk, so we just rename it into place — no
 *  bytes cross the IPC bridge, which is what makes a 200 MB PDF importable on
 *  Android at all (see `nativeStaging.ts`). `bytes` is the in-memory
 *  fallback, kept for callers that never touch disk. */
export async function commitPdfBook(
  opts: {
    title: string;
    author: string;
    pageCount: number;
    outline: TocEntry[];
    cover?: ChosenCover;
    sourceHash?: string;
  } & ({ stagedPath: string } | { bytes: Uint8Array }),
): Promise<BookIndexEntry> {
  await ensureRoot();
  const id = newFixedId("pdf");
  const dir = bookDir(id);
  await mkdir(dir, { baseDir: BASE, recursive: true });
  // Keep the original file so pages can be re-rendered / re-scanned later.
  if ("stagedPath" in opts) {
    await renameStaged(opts.stagedPath, `${dir}/book.pdf`);
  } else {
    await writeBytesChunked(`${dir}/book.pdf`, opts.bytes);
  }

  const coverFile = await writeCover(dir, opts.cover);

  const book: PdfBook = {
    id,
    kind: "pdf",
    title: opts.title,
    author: opts.author,
    pageCount: opts.pageCount,
    outline: opts.outline,
  };
  await writeTextFile(`${dir}/book.json`, JSON.stringify(book), { baseDir: BASE });
  await writeInitialState(id);

  return appendIndexEntry({
    id,
    title: book.title,
    author: book.author,
    language: "",
    chapterCount: 0,
    pageCount: book.pageCount,
    kind: "pdf",
    addedAt: Date.now(),
    progress: 0,
    ...(coverFile ? { coverFile } : {}),
    ...(opts.sourceHash ? { sourceHash: opts.sourceHash } : {}),
  });
}

/** Persist a DOCX: store the sanitized HTML + extracted images, a DocxBook
 *  descriptor, the chosen cover (if any), and append the index entry. */
export async function commitDocxBook(opts: {
  html: string;
  images: { href: string; bytes: Uint8Array }[];
  dir: "ltr" | "rtl";
  title: string;
  author: string;
  outline: { title: string; level: number; anchorId: string }[];
  cover?: ChosenCover;
  sourceHash?: string;
}): Promise<BookIndexEntry> {
  await ensureRoot();
  const id = newFixedId("docx");
  const dir = bookDir(id);
  await mkdir(dir, { baseDir: BASE, recursive: true });
  await writeTextFile(`${dir}/content.html`, opts.html, { baseDir: BASE });

  if (opts.images.length > 0) {
    await mkdir(`${dir}/images`, { baseDir: BASE, recursive: true });
    for (const img of opts.images) {
      await writeFile(`${dir}/${img.href}`, img.bytes, { baseDir: BASE });
    }
  }

  const coverFile = await writeCover(dir, opts.cover);

  const book: DocxBook = {
    id,
    kind: "docx",
    title: opts.title,
    author: opts.author,
    dir: opts.dir,
    outline: opts.outline,
  };
  await writeTextFile(`${dir}/book.json`, JSON.stringify(book), { baseDir: BASE });
  await writeInitialState(id);

  return appendIndexEntry({
    id,
    title: book.title,
    author: book.author,
    language: "",
    chapterCount: 0,
    kind: "docx",
    addedAt: Date.now(),
    progress: 0,
    ...(coverFile ? { coverFile } : {}),
    ...(opts.sourceHash ? { sourceHash: opts.sourceHash } : {}),
  });
}

async function writeCover(
  dir: string,
  cover: ChosenCover | undefined,
): Promise<string | undefined> {
  if (!cover) return undefined;
  const coverFile = `cover.${cover.ext}`;
  await writeFile(`${dir}/${coverFile}`, cover.bytes, { baseDir: BASE });
  return coverFile;
}
