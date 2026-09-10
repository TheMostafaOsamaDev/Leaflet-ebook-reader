// Stage a PDF/DOCX for import: parse it in memory, expose cover CANDIDATES
// (PDF page thumbnails / DOCX embedded images) plus the auto-detected title,
// and return a draft the UI can commit once the user picks a title + cover.
// Nothing touches disk until draft.commit() runs, so a cancelled import leaves
// no trace. Thumbnails are produced lazily + downscaled so a 9 MB DOCX with
// large images (or a long PDF) doesn't decode everything up front.

import { openPdfDocument } from "../pdf/pdfjs";
import { deleteStaged } from "./nativeStaging";
import { detectBookFormat } from "./bookFormat";
import { commitDocxBook, commitPdfBook, type ChosenCover } from "./fixedImport";
import { filenameTitle, type BookIndexEntry } from "./library";

/** What the user chose in the dialog; resolved to bytes at commit time. */
export type CoverChoice =
  | { kind: "candidate"; id: string }
  | { kind: "custom"; bytes: Uint8Array; ext: string }
  | { kind: "none" };

export interface CoverCandidate {
  id: string;
  /** Optional 1-based ordinal for a label (e.g. PDF page number). */
  ordinal?: number;
  /** Lazily produce a small blob: URL for the picker grid. Cached + tracked
   *  for revocation on dispose(). */
  thumb: () => Promise<string>;
  /** Lazily produce full-resolution cover bytes for the chosen candidate. */
  full: () => Promise<ChosenCover>;
}

export interface FixedImportDraft {
  id: string;
  kind: "pdf" | "docx";
  filename: string;
  /** Auto-detected title, used to prefill the field. */
  title: string;
  author: string;
  pageCount?: number;
  candidates: CoverCandidate[];
  /** First candidate id (the sensible default cover), or null when the file
   *  carried no usable images. */
  defaultCoverId: string | null;
  commit: (opts: {
    title: string;
    cover: CoverChoice;
  }) => Promise<BookIndexEntry>;
  /** Revoke thumbnails + release the parser. Idempotent. */
  dispose: () => void;
}

const PDF_CANDIDATE_PAGES = 8; // first N pages offered as cover suggestions
const DOCX_MAX_IMAGES = 12;
const DOCX_MIN_IMAGE_BYTES = 2048; // skip inline icons / bullets
const THUMB_MAX_W = 240;

/** Extra context from the native staging pass. When present, the file
 *  already sits on disk at `stagedPath` (app-data-relative), so committing a
 *  PDF renames it into place instead of pushing the bytes back across the
 *  IPC bridge — the write that used to throw `RangeError: Invalid array
 *  length` on Android for anything past ~128 MB. */
export interface StagedSource {
  stagedPath: string;
  /** Hash of the picked file, recorded on the committed entry so a repeat
   *  open of the same file reuses this book. */
  sourceHash?: string;
}

/** Where the staged file's bytes come from.
 *
 *  A PDF is read in slices straight off disk, so `{ path, length }` is the
 *  app's path for it. DOCX still needs the whole buffer, because mammoth
 *  does. */
export type FixedSource =
  | { bytes: Uint8Array }
  | { path: string; length: number };

export async function stageFixedImport(
  source: FixedSource,
  filename: string,
  /** Format the caller already sniffed. When omitted, the bytes decide. */
  kind?: "pdf" | "docx",
  staged?: StagedSource,
): Promise<FixedImportDraft> {
  const format =
    kind ?? ("bytes" in source ? detectBookFormat(source.bytes) : "pdf");
  if (format === "pdf") return stagePdf(source, filename, staged);
  if (!("bytes" in source)) {
    throw new Error("DOCX staging needs the file's bytes");
  }
  return stageDocx(source.bytes, filename, staged);
}

async function stagePdf(
  source: FixedSource,
  filename: string,
  staged?: StagedSource,
): Promise<FixedImportDraft> {
  const doc = await openPdfDocument("bytes" in source ? source.bytes : source);
  const urls: string[] = [];
  let disposed = false;

  const n = Math.min(PDF_CANDIDATE_PAGES, doc.pageCount);
  const thumbCache = new Map<number, Promise<string>>();
  const candidates: CoverCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const page = i;
    candidates.push({
      id: `page-${page}`,
      ordinal: page + 1,
      thumb: () => {
        let p = thumbCache.get(page);
        if (!p) {
          p = (async () => {
            const canvas = document.createElement("canvas");
            await doc.renderPage(page, canvas, 0.35);
            const blob = await canvasToBlob(canvas, "image/jpeg", 0.7);
            const url = URL.createObjectURL(blob);
            urls.push(url);
            return url;
          })();
          thumbCache.set(page, p);
        }
        return p;
      },
      full: async () => {
        const canvas = document.createElement("canvas");
        await doc.renderPage(page, canvas, 1.2);
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.82);
        return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: "jpg" };
      },
    });
  }

  return {
    id: newDraftId(),
    kind: "pdf",
    filename,
    title: doc.meta.title || filenameTitle(filename),
    author: doc.meta.author || "",
    pageCount: doc.pageCount,
    candidates,
    defaultCoverId: candidates[0]?.id ?? null,
    commit: async ({ title, cover }) => {
      const chosen = await resolveCover(cover, candidates);
      // Without a staged file there is nothing on disk to rename into
      // place, so the bytes are the only way to persist the original. Every
      // in-tree caller stages, so this branch is a fallback only.
      const fallbackBytes = "bytes" in source ? source.bytes : null;
      if (!staged && !fallbackBytes) {
        throw new Error("cannot commit a PDF without a staged file or bytes");
      }
      return commitPdfBook({
        ...(staged
          ? { stagedPath: staged.stagedPath }
          : { bytes: fallbackBytes as Uint8Array }),
        title: title.trim() || doc.meta.title || filenameTitle(filename),
        author: doc.meta.author || "",
        pageCount: doc.pageCount,
        outline: doc.outline,
        cover: chosen,
        sourceHash: staged?.sourceHash,
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
      doc.destroy();
      // After a successful commit the staged file has already been renamed
      // into the book directory, so this is a no-op. After a cancel or a
      // failure it reclaims the copy — which for a PDF can be hundreds of MB.
      if (staged) void discardStaged(staged.stagedPath);
    },
  };
}

async function stageDocx(
  bytes: Uint8Array,
  filename: string,
  staged?: StagedSource,
): Promise<FixedImportDraft> {
  // Lazy — pulls in mammoth/jszip only when a DOCX is actually staged.
  const { docxToFixedDoc } = await import("../docx/toFixedDoc");
  const fixed = await docxToFixedDoc(bytes, filenameTitle(filename));
  const urls: string[] = [];
  let disposed = false;

  const images = fixed.images
    .filter((im) => im.bytes.length >= DOCX_MIN_IMAGE_BYTES)
    .slice(0, DOCX_MAX_IMAGES);
  const thumbCache = new Map<string, Promise<string>>();
  const candidates: CoverCandidate[] = images.map((im) => {
    const ext = extOf(im.href);
    return {
      id: im.href,
      thumb: () => {
        let p = thumbCache.get(im.href);
        if (!p) {
          p = downscaleToThumb(im.bytes).then((url) => {
            urls.push(url);
            return url;
          });
          thumbCache.set(im.href, p);
        }
        return p;
      },
      full: async () => ({ bytes: im.bytes, ext }),
    };
  });

  return {
    id: newDraftId(),
    kind: "docx",
    filename,
    title: fixed.title,
    author: fixed.author,
    candidates,
    defaultCoverId: candidates[0]?.id ?? null,
    commit: async ({ title, cover }) => {
      const chosen = await resolveCover(cover, candidates);
      return commitDocxBook({
        html: fixed.html,
        images: fixed.images,
        dir: fixed.dir,
        title: title.trim() || fixed.title,
        author: fixed.author,
        outline: fixed.outline,
        cover: chosen,
        sourceHash: staged?.sourceHash,
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
      // DOCX keeps nothing from the original on disk, so the staged copy is
      // dead weight once the draft is done with (committed or cancelled).
      if (staged) void discardStaged(staged.stagedPath);
    },
  };
}

async function resolveCover(
  choice: CoverChoice,
  candidates: CoverCandidate[],
): Promise<ChosenCover | undefined> {
  if (choice.kind === "none") return undefined;
  if (choice.kind === "custom") return { bytes: choice.bytes, ext: choice.ext };
  const c = candidates.find((x) => x.id === choice.id);
  return c ? c.full() : undefined;
}

/** Decode `bytes` and re-encode a small JPEG thumbnail so large embedded
 *  images don't sit full-size in the picker. Falls back to the original bytes
 *  if the browser can't decode it. */
async function downscaleToThumb(bytes: Uint8Array): Promise<string> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes.slice().buffer]));
    const scale = Math.min(1, THUMB_MAX_W / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.75);
    return URL.createObjectURL(blob);
  } catch {
    return URL.createObjectURL(new Blob([bytes.slice().buffer]));
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))),
      type,
      quality,
    ),
  );
}

function extOf(href: string): string {
  const m = href.match(/\.([A-Za-z0-9]+)$/);
  const ext = m?.[1]?.toLowerCase() ?? "png";
  return ext === "jpeg" ? "jpg" : ext;
}

/** Fire-and-forget removal of a staged file. */
async function discardStaged(path: string): Promise<void> {
  await deleteStaged(path);
}

function newDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
