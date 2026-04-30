// Top-level orchestration for "pick a .docx → produce EPUB bytes".
//
// Two entry points:
//
//   docxToEpubBytes(bytes, fallbackTitle)
//       Direct path. Convert + immediately build with default edits
//       (keep all blocks, first image becomes cover). Used by the legacy
//       "Add directly to library" choice.
//
//   convertDocxToStaging(bytes, fallbackTitle)  +  buildEpubFromStaging(…)
//       Two-phase path used by the "Manage before importing" choice. The
//       first call does the heavy mammoth conversion and returns a session
//       the manage UI can render against. The second call applies the
//       user's keep/delete + cover-pick edits and finishes the EPUB build.
//
// Each stage advances the import-progress store so the modal stepper +
// minimized dock can show what's happening. Stages:
//
//   read      — read the file off disk
//   lang      — pull language + RTL/LTR out of the docx package
//   convert   — mammoth: docx → HTML + staged images
//   chapters  — parse the HTML into top-level blocks the manage UI lists
//   epub      — assemble the EPUB3 zip
//   save      — hand off to the existing importEpubBytes() pipeline
//
// The `save` step is run by the caller (library.ts), since that's where the
// existing importEpubBytes lives — keeping the docx layer free of any
// library/storage knowledge.

import JSZip from "jszip";
import { detectDocDirection, type Dir } from "./detectDirection";
import { splitHtmlIntoChapters, type DocChapter } from "./splitChapters";
import { buildEpub } from "./buildEpub";
import {
  createBlocksFromHtml,
  defaultEdits,
  disposeStaging,
  finalizeStaging,
  stagingSrc,
  type StagedDocx,
  type StagedImage,
  type StagingEdits,
} from "./stage";

// Mammoth's browser bundle is ~700KB — lazy-load it so it doesn't ship on
// app start. The first .docx import pays the load cost (one HTTP-cached
// request in the webview); subsequent imports are instant. The dynamic
// import gives Vite a natural code-split boundary.
async function loadMammoth() {
  const m = await import("mammoth/mammoth.browser");
  return m.default;
}

export interface DocxImportResult {
  /** Bytes of a self-contained EPUB3 zip. Feed to importEpubBytes(). */
  epubBytes: Uint8Array;
  /** Detected language (BCP-47, lowercased) and direction. */
  lang: string;
  dir: Dir;
  /** Number of chapters in the produced EPUB — useful for the toast at the
   *  end of import ("Imported with N chapters"). */
  chapterCount: number;
}

export interface DocxStageHooks {
  read?: () => void | Promise<void>;
  lang?: () => void | Promise<void>;
  convert?: () => void | Promise<void>;
  chapters?: () => void | Promise<void>;
  epub?: () => void | Promise<void>;
}

// ── direct path (used by "Add directly to library") ─────────────────────────

/** Convert raw docx bytes into EPUB bytes, advancing per-stage progress
 *  hooks along the way. The caller picks the file and saves the result.
 *  Internally runs the same staging pipeline as the manage flow with
 *  default keep-all + first-image-as-cover edits, then disposes the
 *  staging session before returning. */
export async function docxToEpubBytes(
  fileBytes: Uint8Array,
  fallbackTitle: string,
  hooks: DocxStageHooks = {},
): Promise<DocxImportResult> {
  const staged = await convertDocxToStaging(fileBytes, fallbackTitle, hooks);
  try {
    return await buildEpubFromStaging(
      staged,
      defaultEdits(staged),
      { title: staged.fallbackTitle, author: "Unknown author" },
      { epub: hooks.epub },
    );
  } finally {
    disposeStaging(staged);
  }
}

// ── two-phase path (used by "Manage before importing") ──────────────────────

/** Run the heavy mammoth conversion + block extraction. Returns an in-memory
 *  staging session — image bytes + blob URLs live until disposeStaging() is
 *  called. */
export async function convertDocxToStaging(
  fileBytes: Uint8Array,
  fallbackTitle: string,
  hooks: DocxStageHooks = {},
): Promise<StagedDocx> {
  // Direction + language. Done from the raw zip directly so we don't need
  // to wait on mammoth.
  await hooks.lang?.();
  // JSZip's loadAsync expects the underlying buffer (not the Uint8Array view)
  // — Tauri's plugin-fs returns a Uint8Array whose .buffer may be larger than
  // the view, so slice it cleanly.
  const arrayBuffer =
    fileBytes.byteOffset === 0 &&
    fileBytes.byteLength === fileBytes.buffer.byteLength
      ? (fileBytes.buffer as ArrayBuffer)
      : (fileBytes.slice().buffer as ArrayBuffer);
  const zip = await JSZip.loadAsync(arrayBuffer);
  const { lang, dir } = await detectDocDirection(zip);

  // Mammoth conversion + image extraction. Every image becomes a staging
  // entry; HTML keeps `staging://<id>` markers so cover/in-flow choice can
  // be deferred to commit time.
  await hooks.convert?.();
  const { html, imagesById, imageOrder } =
    await convertDocxToHtmlAndImages(arrayBuffer);

  // Block extraction — the manage view's primary unit.
  await hooks.chapters?.();
  const blocks = createBlocksFromHtml(html);

  const headingBlock = blocks.find((b) => b.type.startsWith("h"));
  const guessedTitle =
    headingBlock?.textPreview.trim().length
      ? headingBlock.textPreview.trim()
      : fallbackTitle;

  return {
    sourceFilename: fallbackTitle,
    fallbackTitle: guessedTitle,
    language: lang,
    dir,
    blocks,
    imagesById,
    imageOrder,
  };
}

/** Apply the user's edits + assemble the EPUB. Caller is responsible for
 *  disposing the staging session afterwards (success and failure both). */
export async function buildEpubFromStaging(
  staged: StagedDocx,
  edits: StagingEdits,
  meta: { title: string; author: string },
  hooks: { epub?: () => void | Promise<void> } = {},
): Promise<DocxImportResult> {
  const { html, images, cover } = finalizeStaging(staged, edits);
  const chapters = splitHtmlIntoChapters(html);
  await hooks.epub?.();
  const epubBytes = await buildEpub(
    {
      title: deriveTitle(chapters, meta.title),
      author: meta.author,
      language: staged.language,
      dir: staged.dir,
    },
    chapters,
    cover,
    images,
  );
  return {
    epubBytes,
    lang: staged.language,
    dir: staged.dir,
    chapterCount: chapters.length,
  };
}

// ── internals ─────────────────────────────────────────────────────────────

interface ConvertResult {
  html: string;
  imagesById: Map<string, StagedImage>;
  imageOrder: string[];
}

async function convertDocxToHtmlAndImages(
  arrayBuffer: ArrayBuffer,
): Promise<ConvertResult> {
  const mammoth = await loadMammoth();
  const imagesById = new Map<string, StagedImage>();
  const imageOrder: string[] = [];

  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buffer = await image.readAsArrayBuffer();
        const bytes = new Uint8Array(buffer);
        const ext = extensionFromMime(image.contentType);
        const id = `img-${String(imageOrder.length + 1).padStart(3, "0")}`;
        // Slice the buffer for the Blob — the same `bytes` Uint8Array is
        // also stashed in imagesById.bytes for the EPUB build, so we want
        // each consumer to own its own ArrayBuffer.
        const blob = new Blob([bytes.slice().buffer], {
          type: image.contentType,
        });
        const blobUrl = URL.createObjectURL(blob);
        imagesById.set(id, {
          id,
          bytes,
          mimeType: image.contentType,
          extension: ext,
          blobUrl,
        });
        imageOrder.push(id);
        return { src: stagingSrc(id) };
      }),
    },
  );
  return { html: result.value, imagesById, imageOrder };
}

function deriveTitle(chapters: DocChapter[], fallback: string): string {
  // First chapter title is usually the document's own heading. Skip
  // "Preface" (which is what splitHtmlIntoChapters names the pre-heading
  // content bucket) — that's not a real title.
  if (chapters.length > 0 && chapters[0].title !== "Preface") {
    return chapters[0].title;
  }
  return fallback;
}

function extensionFromMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}
