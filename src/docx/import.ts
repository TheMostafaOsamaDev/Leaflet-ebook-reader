// Top-level orchestration for "pick a .docx → produce EPUB bytes".
//
// Each stage advances the import-progress store so the modal stepper +
// minimized dock can show what's happening. Stages:
//
//   read      — read the file off disk
//   lang      — pull language + RTL/LTR out of the docx package
//   convert   — mammoth: docx → HTML; first image becomes cover, the rest
//                are extracted as separate files referenced by relative href
//   chapters  — split the HTML into chapter docs by detected heading level
//   epub      — assemble the EPUB3 zip
//   save      — hand off to the existing importEpubBytes() pipeline
//
// The `save` step is run by the caller (library.ts), since that's where the
// existing importEpubBytes lives — keeping the docx layer free of any
// library/storage knowledge.

import JSZip from "jszip";
import { detectDocDirection, type Dir } from "./detectDirection";
import { splitHtmlIntoChapters, type DocChapter } from "./splitChapters";
import {
  buildEpub,
  type EpubBuildImage,
  type EpubCoverInput,
} from "./buildEpub";

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

/** Convert raw docx bytes into EPUB bytes, advancing per-stage progress
 *  hooks along the way. The caller picks the file and saves the result. */
export async function docxToEpubBytes(
  fileBytes: Uint8Array,
  fallbackTitle: string,
  hooks: DocxStageHooks = {},
): Promise<DocxImportResult> {
  // Direction + language. Done from the raw zip directly so we don't need
  // to wait on mammoth.
  await hooks.lang?.();
  // JSZip's loadAsync expects the underlying buffer (not the Uint8Array view)
  // — Tauri's plugin-fs returns a Uint8Array whose .buffer may be larger than
  // the view, so slice it cleanly.
  const arrayBuffer = fileBytes.byteOffset === 0 &&
    fileBytes.byteLength === fileBytes.buffer.byteLength
    ? (fileBytes.buffer as ArrayBuffer)
    : (fileBytes.slice().buffer as ArrayBuffer);
  const zip = await JSZip.loadAsync(arrayBuffer);
  const { lang, dir } = await detectDocDirection(zip);

  // Mammoth conversion + image extraction (first image → cover, rest →
  // separate files).
  await hooks.convert?.();
  const { html, cover, images } = await convertDocxToHtml(arrayBuffer);

  // Chapter detection.
  await hooks.chapters?.();
  const chapters = splitHtmlIntoChapters(html);

  // EPUB assembly. Title falls back to the picker filename — the user can
  // edit it later via the library's "Edit details" dialog.
  await hooks.epub?.();
  const epubBytes = await buildEpub(
    {
      title: deriveTitle(chapters, fallbackTitle),
      author: "Unknown author",
      language: lang,
      dir,
    },
    chapters,
    cover,
    images,
  );

  return { epubBytes, lang, dir, chapterCount: chapters.length };
}

// ── internals ─────────────────────────────────────────────────────────────

interface ConvertResult {
  html: string;
  cover: EpubCoverInput | null;
  images: EpubBuildImage[];
}

async function convertDocxToHtml(
  arrayBuffer: ArrayBuffer,
): Promise<ConvertResult> {
  const mammoth = await loadMammoth();
  let cover: EpubCoverInput | null = null;
  const images: EpubBuildImage[] = [];

  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buffer = await image.readAsArrayBuffer();
        const bytes = new Uint8Array(buffer);
        const ext = extensionFromMime(image.contentType);

        if (cover === null) {
          // First image becomes the cover. We return src="" so a regex pass
          // below strips this <img> from the chapter body — no broken-image
          // render and no duplicate of the cover in chapter content.
          cover = { bytes, mimeType: image.contentType, extension: ext };
          return { src: "", alt: "" };
        }

        // Each subsequent image gets a stable href relative to the chapter
        // file. The same path layout the EPUB parser expects for image
        // items (`images/img-NNN.ext`), so the parse-back roundtrip is a
        // straight read of the same bytes off disk.
        const idx = images.length + 1;
        const href = `images/img-${String(idx).padStart(3, "0")}.${ext}`;
        images.push({
          href,
          bytes,
          mimeType: image.contentType,
        });
        return { src: href };
      }),
    },
  );

  // Strip the empty <img> we left where the cover used to be.
  const cleaned = result.value.replace(/<img\b[^>]*src=""[^>]*\/?>/gi, "");
  return { html: cleaned, cover, images };
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
